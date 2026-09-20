import { Resend } from 'resend'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createAttachmentFromBuffer } from '@open-mercato/core/modules/attachments/lib/createFromBuffer'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('rfq_intake').child({ component: 'inbound-attachments' })

/**
 * Pulls an RFQ e-mail's PDFs from Resend and stores them as attachments.
 *
 * Why this exists: `inbox_emails.attachment_ids` has a reader and no writer anywhere in
 * the installed tree. The inbound webhook route has no attachment handling at all
 * (`grep -i attach` over it returns nothing) and `fetchResendEmail` drops everything
 * outside `from/to/subject/text/html/messageId/replyTo/inReplyTo`. So an RFQ whose brief
 * says "w załączeniu przesyłam rzuty" arrives with the drawings absent, the case opens,
 * and the document analysis never starts.
 *
 * Why it is pulled HERE rather than on `inbox_ops.email.received`: doing it on arrival
 * would fetch and store attachments for EVERY e-mail entering the platform — newsletters
 * and spam included — which changes product-wide behavior for the sake of one module.
 * The files are only worth having once a human has accepted the RFQ and asked for the
 * analysis, which is exactly where the caller sits.
 *
 * See `.ai/specs/2026-09-19-rfq-attachment-ingestion.md`.
 */

/** Ceilings. Resend accepts large mail; the PDF agents and storage do not need it. */
const MAX_FILES = 10
const MAX_BYTES_PER_FILE = 25 * 1024 * 1024

export type InboundPdf = {
  fileName: string
  mimeType: string
  buffer: Buffer
}

type CredentialsService = {
  resolve: (
    integrationId: string,
    scope: { tenantId: string; organizationId: string | null },
  ) => Promise<Record<string, unknown> | null>
}

export type Scope = { tenantId: string; organizationId: string }

function isPdf(contentType: string | null, fileName: string | null): boolean {
  if (contentType && contentType.toLowerCase().includes('pdf')) return true
  return Boolean(fileName && fileName.toLowerCase().endsWith('.pdf'))
}

/**
 * RFC Message-IDs are compared without their angle brackets or surrounding space.
 *
 * Today both sides agree: Resend returns `<60D52309-…@evojam.com>` and the inbound route
 * stores `data.message_id` verbatim (`inbox_ops/api/webhook/inbound.ts:138`), so plain
 * equality would work. It is normalized anyway because this comparison is the hinge of
 * the whole feature and it fails SILENTLY — one side trimming a bracket would leave the
 * analysis never starting, with no error anywhere, which is exactly the class of bug
 * this feature exists to fix.
 */
export function normalizeMessageId(value: string | null | undefined): string | null {
  const trimmedValue = typeof value === 'string' ? value.trim() : ''
  if (!trimmedValue) return null
  return trimmedValue.replace(/^<+/, '').replace(/>+$/, '').trim() || null
}

/**
 * Integration first, environment second.
 *
 * The integration is the right source: it is per-tenant, encrypted, and set by an
 * operator. Today it is enabled but carries no stored credentials, while inbound mail
 * works anyway because the installed webhook reads `process.env.RESEND_API_KEY`
 * (`inbox_ops/api/webhook/inbound.ts:123`) — "enabled" and "configured" are independent.
 *
 * HACK(hackathon): hence the environment fallback. It grants no access the platform does
 * not already exercise — we fetch attachments for e-mails that this very key let in — but
 * it does cost the per-tenant story: a second tenant with its own Resend account would
 * silently use the platform's key. The integration branch is tried first and already
 * works, so storing credentials retires the fallback with no code change.
 */
export async function resolveResendApiKey(
  resolve: <T>(token: string) => T,
  scope: Scope,
): Promise<{ apiKey: string; source: 'integration' | 'environment' } | null> {
  try {
    const credentials = resolve<CredentialsService | null>('integrationCredentialsService')
    if (credentials) {
      const fromScope = await credentials.resolve('channel_resend', scope)
        ?? await credentials.resolve('channel_resend', { ...scope, organizationId: null })
      const apiKey = typeof fromScope?.apiKey === 'string' ? fromScope.apiKey.trim() : ''
      if (apiKey) return { apiKey, source: 'integration' }
    }
  } catch (error) {
    // A missing service or an undecryptable blob must not cost us the fallback.
    logger.warn('Could not read channel_resend credentials; trying the environment', { err: error })
  }

  const fromEnv = process.env.RESEND_API_KEY?.trim()
  return fromEnv ? { apiKey: fromEnv, source: 'environment' } : null
}

/**
 * Finds the provider record by RFC `messageId` and downloads its PDFs.
 *
 * Correlation is by `message_id` because our row does not keep Resend's own id — the
 * inbound route persists `messageId` and `contentHash` and nothing else provider-shaped.
 * Only the first page is searched: an RFQ older than one page is one nobody is waiting on.
 *
 * Every failure here is non-fatal by design. The caller opens the case either way; losing
 * the whole enquiry because one download 404'd is the worse outcome.
 */
export async function fetchInboundPdfs(input: {
  apiKey: string
  messageId: string | null
}): Promise<InboundPdf[]> {
  const wanted = normalizeMessageId(input.messageId)
  if (!wanted) return []
  const resend = new Resend(input.apiKey)

  const list = await resend.emails.receiving.list()
  if (list.error) {
    logger.warn('Resend receiving.list failed', { error: list.error })
    return []
  }
  const match = (list.data?.data ?? []).find(
    (entry) => normalizeMessageId(entry.message_id) === wanted,
  )
  if (!match) {
    logger.info('No Resend inbound record matches this message id', { messageId: input.messageId })
    return []
  }

  const full = await resend.emails.receiving.get(match.id)
  if (full.error) {
    logger.warn('Resend receiving.get failed', { error: full.error })
    return []
  }

  const candidates = (full.data?.attachments ?? [])
    .filter((attachment) => isPdf(attachment.content_type, attachment.filename))
    .filter((attachment) => {
      if (attachment.size <= MAX_BYTES_PER_FILE) return true
      logger.warn('Skipping an oversized inbound attachment', {
        fileName: attachment.filename,
        size: attachment.size,
      })
      return false
    })
    .slice(0, MAX_FILES)

  const files: InboundPdf[] = []
  for (const attachment of candidates) {
    const signed = await resend.emails.receiving.attachments.get({
      emailId: match.id,
      id: attachment.id,
    })
    if (signed.error || !signed.data?.download_url) {
      logger.warn('Could not obtain a download url for an inbound attachment', {
        fileName: attachment.filename,
        error: signed.error,
      })
      continue
    }
    // The url is short-lived (`expires_at`), so it is used immediately and never retried
    // from a stale value.
    const response = await fetch(signed.data.download_url)
    if (!response.ok) {
      logger.warn('Inbound attachment download failed', {
        fileName: attachment.filename,
        status: response.status,
      })
      continue
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0) continue
    files.push({
      fileName: attachment.filename?.trim() || `${attachment.id}.pdf`,
      mimeType: attachment.content_type || 'application/pdf',
      buffer,
    })
  }
  return files
}

/**
 * Persists the files against the DEAL the RFQ opened and returns their attachment ids.
 *
 * The deal, not the e-mail row, because that is where the files are used and looked for:
 * the deal detail page's Files tab lists attachments by `entityId`/`recordId`
 * (`customers/backend/customers/deals/[id]/page.tsx:603`), and the attachments list route
 * filters on those COLUMNS — the `assignments` array in `storage_metadata` is display
 * metadata, not a second index, so a row owned by the e-mail can never surface on the
 * case. The rendered floor-plan pages already land on the deal the same way
 * (`agent_orchestrator.artifact.promote` in `commands/analysis.ts`), so the customer's
 * own PDFs sitting somewhere else was the odd one out.
 *
 * The ids are still written onto `inbox_emails.attachment_ids` by the caller: that field
 * is the re-acceptance cache and the backlink, and nothing in the installed inbox UI
 * renders the files themselves (`attachmentIds` appears only in the API response
 * mapper), so nothing is lost by owning them from the case.
 *
 * `createAttachmentFromBuffer` is the installed seam for server-side producers that
 * materialize an attachment without going through the multipart upload route; it resolves
 * the partition and driver, stores the bytes and writes the row atomically.
 */
export async function storeInboundPdfs(input: {
  em: EntityManager
  scope: Scope
  dealId: string
  files: InboundPdf[]
}): Promise<string[]> {
  const ids: string[] = []
  for (const file of input.files) {
    try {
      const created = await createAttachmentFromBuffer({
        em: input.em,
        tenantId: input.scope.tenantId,
        organizationId: input.scope.organizationId,
        entityId: E.customers.customer_deal,
        recordId: input.dealId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        buffer: file.buffer,
      })
      ids.push(created.id)
    } catch (error) {
      logger.warn('Failed to store an inbound attachment', { fileName: file.fileName, err: error })
    }
  }
  return ids
}

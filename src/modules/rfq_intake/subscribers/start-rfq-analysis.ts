import type { EntityManager } from '@mikro-orm/postgresql'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import {
  InboxEmail,
  InboxProposal,
  InboxProposalAction,
} from '@open-mercato/core/modules/inbox_ops/data/entities'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { emitRfqIntakeEvent } from '../events'
import { startRfqAnalysisProcess } from '../lib/startProcess'

const logger = createLogger('rfq_intake').child({ subscriber: 'start-rfq-analysis' })

/**
 * Turns an executed RFQ inbox action into the app's own, agent-shaped event.
 *
 * Persistent: the analysis is the point of the feature, so a dropped queue row is
 * worse than a redelivery. A redelivery re-emits; the workflow trigger's own
 * concurrency guard bounds the duplicate instances, and no business record is
 * written here.
 */
export const metadata = {
  event: 'inbox_ops.action.executed',
  persistent: true,
  id: 'rfq_intake:start-rfq-analysis',
}

export type ActionExecutedPayload = {
  actionId?: string | null
  proposalId?: string | null
  actionType?: string | null
  createdEntityId?: string | null
  createdEntityType?: string | null
  /** Whoever accepted the action in the inbox; `inbox_ops` puts it on the event. */
  executedByUserId?: string | null
  tenantId?: string | null
  organizationId?: string | null
}

export type RfqCreatedEvent = {
  dealId: string
  proposalId: string
  emailId: string
  tenantId: string
  organizationId: string
  /**
   * Whoever accepted the action in the inbox. Carried on the event so a subscriber
   * other than ours can attribute the RFQ without re-reading the action.
   *
   * The chain's own copy of this identity travels through the process execution
   * (`lib/startProcess.ts`), not through this payload — see the note there for why
   * a run without an actor cannot execute a single step.
   */
  userId: string
  /** The one document the chain analyses: the first PDF among the e-mail's attachments. */
  attachmentId: string
  customerId: string | null
  channelId: string | null
}

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Pure guard, exported so the test pins the routing rule rather than trusting prose.
 *
 * `create_quote` is this module's RFQ action (see `inbox-actions.ts` for why the type
 * id lies), but the SAME type still reaches us from any other proposal, so the
 * created entity type is what actually distinguishes our case from a real quote.
 */
export function isRfqActionExecuted(payload: ActionExecutedPayload): boolean {
  return (
    payload?.actionType === 'create_quote' &&
    payload?.createdEntityType === 'customer_deal' &&
    Boolean(trimmed(payload?.createdEntityId))
  )
}

const PDF_MIME_TYPE = 'application/pdf'

/**
 * The ONE document the chain analyses: the first PDF among the e-mail's attachments.
 *
 * Not a simplification we chose freely — `pdf_intake` enforces it server-side. Its
 * tool counts the files staged into the run sandbox and refuses anything but exactly
 * one (`property_documents/ai-tools.ts:345`, `invalid_attachment_count`), and it
 * counts FILES, not PDFs: a signature logo staged next to the brief breaks the run
 * just as a second brief would.
 *
 * HACK(hackathon): "first" is the e-mail's own attachment order, and a second PDF is
 * dropped with nothing but a log line. An RFQ that splits its brief across two
 * documents silently gets half an analysis.
 *
 * Resolved through the attachments module rather than trusted from the id list: the
 * mime type is what makes a PDF a PDF, and only the Attachment row knows it. Scoped
 * to tenant AND organization, so an id that does not resolve here counts as absent.
 */
async function pickFirstPdfAttachmentId(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  attachmentIds: string[],
): Promise<string | null> {
  const rows = await findWithDecryption(
    em,
    Attachment,
    // No soft-delete filter: `Attachment` carries no `deletedAt` — removal is a real
    // delete plus the storage driver's own cleanup.
    { id: { $in: attachmentIds }, ...scope },
    undefined,
    scope,
  )
  const pdfIds = new Set(
    rows
      .filter((row) => (row.mimeType ?? '').trim().toLowerCase() === PDF_MIME_TYPE)
      .map((row) => String(row.id)),
  )
  // Ordered by the e-mail, not by the query: `$in` guarantees no ordering, and "the
  // first attachment" has to mean the same thing on every run.
  return attachmentIds.find((id) => pdfIds.has(id)) ?? null
}

/**
 * The CRM facets the agent step passes on: who the RFQ is for, and through which
 * sales channel.
 *
 * Both are read off the executed action's own payload. `enrichOrderPayload` resolves
 * them SERVER-side during extraction and writes the enriched payload back onto the
 * action row (`inbox_ops/subscribers/extractionWorker.ts:271-281`), so this is the
 * enrichment's own answer rather than anything the model invented.
 *
 * HACK(hackathon): `customerId` is the contact the EXTRACTION matched. When no
 * contact matched and our action created one through `ensureContact`, the payload
 * still holds null and the agent gets null — the deal has the right contact, this
 * field does not. Carrying it out of `execute` needs a channel the installed
 * `InboxActionExecutionResult` does not have.
 */
async function resolveCrmFacets(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  actionId: string | null,
): Promise<{ customerId: string | null; channelId: string | null }> {
  if (!actionId) return { customerId: null, channelId: null }
  const action = await findOneWithDecryption(
    em,
    InboxProposalAction,
    { id: actionId, ...scope, deletedAt: null },
    undefined,
    scope,
  )
  const actionPayload = (action?.payload ?? {}) as Record<string, unknown>
  return {
    customerId: trimmed(actionPayload.customerEntityId),
    channelId: trimmed(actionPayload.channelId),
  }
}

export default async function handler(
  payload: ActionExecutedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  if (!isRfqActionExecuted(payload)) return

  const dealId = trimmed(payload.createdEntityId)!
  const proposalId = trimmed(payload.proposalId)
  const tenantId = trimmed(payload.tenantId)
  const organizationId = trimmed(payload.organizationId)
  const userId = trimmed(payload.executedByUserId)

  // Scope arrives on the event from the authenticated execution context. Missing
  // scope must never widen a query — fail closed instead.
  if (!proposalId || !tenantId || !organizationId) {
    logger.warn('Executed RFQ action carries incomplete scope; not starting the analysis', {
      dealId,
      hasProposal: Boolean(proposalId),
    })
    return
  }

  // Same treatment for the actor, and for a stronger reason than tidiness: a run
  // without one cannot invoke an agent or execute a command, so emitting anyway
  // would buy a workflow instance that exists only to fail. Say why instead.
  if (!userId) {
    logger.warn('Executed RFQ action carries no acting user; not starting the analysis', {
      dealId,
      proposalId,
    })
    return
  }

  const em = (ctx.resolve('em') as EntityManager).fork()
  const scope = { tenantId, organizationId }

  const proposal = await findOneWithDecryption(
    em,
    InboxProposal,
    { id: proposalId, ...scope, deletedAt: null },
    undefined,
    scope,
  )
  if (!proposal) {
    logger.warn('Proposal behind the executed RFQ action is not visible in this scope', { proposalId })
    return
  }

  const email = await findOneWithDecryption(
    em,
    InboxEmail,
    { id: proposal.inboxEmailId, ...scope, deletedAt: null },
    undefined,
    scope,
  )

  const attachmentIds = (email?.attachmentIds ?? []).filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  )

  if (attachmentIds.length === 0) {
    // HACK(hackathon): today this branch is not the exception, it is EVERY RFQ that
    // arrives by e-mail. `inbox_emails.attachment_ids` is a column nothing writes:
    // the installed module declares it (`inbox_ops/data/entities.ts:178`) and
    // projects it in the emails API, but neither route that creates an InboxEmail
    // sets it and `parseInboundEmail` never looks at attachments. The real fix is at
    // ingestion — persist the inbound files as scoped Attachment rows and write their
    // ids here. Warn, not info: "no attachments" currently means "the feature did not
    // run", not "this e-mail happened to carry no document".
    logger.warn('RFQ has no attachments; the case is open but no document analysis starts', {
      dealId,
      proposalId,
      emailId: proposal.inboxEmailId,
    })
    return
  }

  const attachmentId = await pickFirstPdfAttachmentId(em, scope, attachmentIds)
  if (!attachmentId) {
    logger.warn('RFQ carries attachments but none of them is a PDF; no document analysis starts', {
      dealId,
      proposalId,
      emailId: proposal.inboxEmailId,
      attachments: attachmentIds.length,
    })
    return
  }

  const { customerId, channelId } = await resolveCrmFacets(em, scope, trimmed(payload.actionId))

  const event: RfqCreatedEvent = {
    dealId,
    proposalId,
    emailId: proposal.inboxEmailId,
    tenantId,
    organizationId,
    userId,
    attachmentId,
    customerId,
    channelId,
  }

  // Announced, not dispatched. The chain no longer hangs off this event — it is a
  // declared domain event other modules may subscribe to, and the audit trail of an
  // RFQ having been opened.
  await emitRfqIntakeEvent('rfq_intake.rfq.created', event, { persistent: true })

  const { started, reason } = await startRfqAnalysisProcess(
    ctx.resolve,
    em,
    { tenantId, organizationId },
    userId,
    {
      dealId,
      proposalId,
      emailId: proposal.inboxEmailId,
      attachmentId,
      customerId,
      channelId,
    },
  )
  if (!started) {
    logger.warn('RFQ case opened but the analysis did not start', { dealId, reason })
    return
  }

  logger.info('RFQ analysis requested', { dealId, attachments: attachmentIds.length })
}

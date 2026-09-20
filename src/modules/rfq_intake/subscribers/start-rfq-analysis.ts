import type { EntityManager } from '@mikro-orm/postgresql'
import { InboxEmail, InboxProposal } from '@open-mercato/core/modules/inbox_ops/data/entities'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { emitRfqIntakeEvent } from '../events'
import { startRfqAnalysisProcess } from '../lib/startProcess'
import { fetchInboundPdfs, resolveResendApiKey, storeInboundPdfs } from '../lib/inboundAttachments'

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
  __files: { attachments: Array<{ attachmentId: string }> }
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

/**
 * Fetches the e-mail's PDFs, stores them ON THE DEAL so they show up in the case's Files
 * tab, then records their ids on the e-mail row so a second acceptance of the same RFQ
 * finds them and skips the provider entirely.
 *
 * Best effort throughout: a provider outage, an unconfigured integration or a failed
 * download leaves the case open without attachments — the same outcome as an enquiry that
 * genuinely had none. The caller's existing log line covers it.
 */
async function pullInboundAttachments(
  resolve: SubscriberContext['resolve'],
  em: EntityManager,
  input: {
    scope: { tenantId: string; organizationId: string }
    emailId: string
    dealId: string
    messageId: string | null
  },
): Promise<string[]> {
  try {
    const key = await resolveResendApiKey(resolve, input.scope)
    if (!key) {
      logger.info('No Resend key from the integration or the environment; skipping the pull', {
        emailId: input.emailId,
      })
      return []
    }

    const files = await fetchInboundPdfs({ apiKey: key.apiKey, messageId: input.messageId })
    if (files.length === 0) return []

    const ids = await storeInboundPdfs({ em, scope: input.scope, dealId: input.dealId, files })
    if (ids.length === 0) return []

    // Linking is an optimization, not a precondition: it makes a second acceptance skip
    // the provider and keeps the backlink from the e-mail to the files the case now owns
    // (the inbox response mapper already reads this field). The attachments are stored
    // on the deal and usable whether or not this lands,
    // so its failure must not discard them — the analysis is the point.
    try {
      const row = await em.findOne(InboxEmail, { id: input.emailId, ...input.scope, deletedAt: null })
      if (row) {
        row.attachmentIds = ids
        await em.flush()
      }
    } catch (error) {
      logger.warn('Stored the attachments but could not link them to the e-mail', {
        emailId: input.emailId,
        err: error,
      })
    }

    logger.info('Pulled inbound attachments for an accepted RFQ', {
      emailId: input.emailId,
      count: ids.length,
      keySource: key.source,
    })
    return ids
  } catch (error) {
    logger.warn('Inbound attachment pull failed; the case stays open without them', {
      emailId: input.emailId,
      err: error,
    })
    return []
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

  let attachmentIds = (email?.attachmentIds ?? []).filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  )

  // Nothing populates `attachment_ids` on the way in — the installed inbound route has no
  // attachment handling at all — so an empty list here is the normal case, not an
  // exception. Pull this ONE e-mail's PDFs now that a human has accepted the RFQ.
  // Deliberately not done on `inbox_ops.email.received`: that would fetch and store files
  // for every e-mail reaching the platform. See
  // `.ai/specs/2026-09-19-rfq-attachment-ingestion.md`.
  if (attachmentIds.length === 0 && email) {
    attachmentIds = await pullInboundAttachments(ctx.resolve, em, {
      scope: { tenantId, organizationId },
      emailId: proposal.inboxEmailId,
      dealId,
      messageId: email.messageId ?? null,
    })
  }

  if (attachmentIds.length === 0) {
    // Not a failure: the case is open and useful. Say so rather than letting the
    // absent analysis look like a silent success.
    logger.info('RFQ has no attachments; the case is open but no document analysis starts', {
      dealId,
      proposalId,
      emailId: proposal.inboxEmailId,
    })
    return
  }

  const event: RfqCreatedEvent = {
    dealId,
    proposalId,
    emailId: proposal.inboxEmailId,
    tenantId,
    organizationId,
    userId,
    __files: { attachments: attachmentIds.map((attachmentId) => ({ attachmentId })) },
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
      __files: event.__files,
    },
  )
  if (!started) {
    logger.warn('RFQ case opened but the analysis did not start', { dealId, reason })
    return
  }

  logger.info('RFQ analysis requested', { dealId, attachments: attachmentIds.length })
}

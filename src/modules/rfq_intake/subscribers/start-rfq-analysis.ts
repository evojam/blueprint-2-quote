import type { EntityManager } from '@mikro-orm/postgresql'
import { InboxEmail, InboxProposal } from '@open-mercato/core/modules/inbox_ops/data/entities'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { emitRfqIntakeEvent } from '../events'

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
  tenantId?: string | null
  organizationId?: string | null
}

export type RfqCreatedEvent = {
  dealId: string
  proposalId: string
  emailId: string
  tenantId: string
  organizationId: string
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

export default async function handler(
  payload: ActionExecutedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  if (!isRfqActionExecuted(payload)) return

  const dealId = trimmed(payload.createdEntityId)!
  const proposalId = trimmed(payload.proposalId)
  const tenantId = trimmed(payload.tenantId)
  const organizationId = trimmed(payload.organizationId)

  // Scope arrives on the event from the authenticated execution context. Missing
  // scope must never widen a query — fail closed instead.
  if (!proposalId || !tenantId || !organizationId) {
    logger.warn('Executed RFQ action carries incomplete scope; not starting the analysis', {
      dealId,
      hasProposal: Boolean(proposalId),
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
    __files: { attachments: attachmentIds.map((attachmentId) => ({ attachmentId })) },
  }

  await emitRfqIntakeEvent('rfq_intake.rfq.created', event, { persistent: true })
  logger.info('RFQ analysis requested', { dealId, attachments: attachmentIds.length })
}

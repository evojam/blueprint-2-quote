import type { EntityManager } from '@mikro-orm/postgresql'
import {
  InboxDiscrepancy,
  InboxProposalAction,
} from '@open-mercato/core/modules/inbox_ops/data/entities'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('rfq_intake').child({ subscriber: 'clear-catalog-discrepancies' })

/**
 * Stops a catalog miss from locking an RFQ out of the inbox.
 *
 * `extractionWorker.ts` raises one `product_not_found` discrepancy at `severity: 'error'`
 * for every line item that did not resolve to a catalog product, for any `create_order`
 * or `create_quote` action. `ActionCard.tsx:245` disables Accept when an action carries
 * any unresolved error, so a renovation enquiry naming "gładzie" and "malowanie" against
 * a catalog of plumbing and electrical work arrives permanently unacceptable.
 *
 * That check is correct for what it was written for — a quote DOCUMENT cannot be issued
 * for a product nobody sells. It is wrong for this module's action, which opens a CRM
 * CASE: the line items are a description of what the customer asked for, pricing happens
 * later in the agent chain against measurements nobody has yet, and the catalog is not
 * consulted at acceptance time at all.
 *
 * The operator is otherwise stuck rather than inconvenienced: Accept is disabled and
 * Edit fails too, because the edit route validates against the installed
 * `orderPayloadSchema` (see the note in `inbox-actions.ts` and upstream #6279). Reject is
 * the only remaining button, and rejecting a real enquiry is the one outcome that costs
 * a customer.
 *
 * What this does NOT do: it resolves the blocking catalog miss and nothing else. Every
 * other discrepancy — missing quantities, an unresolvable currency, a contact that did
 * not match — stays exactly as raised, visible to whoever accepts. The point is to stop
 * lying about what blocks an RFQ, not to make the card look green.
 */
export const metadata = {
  event: 'inbox_ops.proposal.created',
  persistent: true,
  id: 'rfq_intake:clear-catalog-discrepancies',
}

export type ProposalCreatedPayload = {
  proposalId?: string | null
  tenantId?: string | null
  organizationId?: string | null
}

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
}

/**
 * The discrepancy types this module clears, and only these.
 *
 * `product_not_found` is the blocker. Nothing else is listed because nothing else is
 * wrong about an RFQ — and a set that grows silently is how a guard turns into a gag.
 */
const CLEARED_TYPES = ['product_not_found'] as const

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export default async function handler(
  payload: ProposalCreatedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  const proposalId = trimmed(payload?.proposalId)
  const tenantId = trimmed(payload?.tenantId)
  const organizationId = trimmed(payload?.organizationId)

  // Scope arrives on the event from the extraction that produced it. Missing scope must
  // never widen a query — fail closed instead.
  if (!proposalId || !tenantId || !organizationId) {
    logger.warn('Proposal event carries incomplete scope; leaving its discrepancies alone', {
      proposalId,
    })
    return
  }

  const em = (ctx.resolve('em') as EntityManager).fork()
  const scope = { tenantId, organizationId }

  // `create_quote` IS this module's RFQ action: `inbox-actions.ts` registers the type and
  // there is one definition per type, so in this app no other action carries it. The
  // subscriber that runs AFTER acceptance cannot rely on that and checks the created
  // entity instead — here there is no created entity yet, and the registration is the
  // fact available.
  const actions = await em.find(InboxProposalAction, {
    proposalId,
    ...scope,
    actionType: 'create_quote',
    deletedAt: null,
  })
  if (actions.length === 0) return

  const actionIds = actions.map((action) => action.id)
  const blocking = await em.find(InboxDiscrepancy, {
    proposalId,
    ...scope,
    actionId: { $in: actionIds },
    type: { $in: [...CLEARED_TYPES] },
    resolved: false,
    deletedAt: null,
  })
  if (blocking.length === 0) return

  for (const discrepancy of blocking) {
    discrepancy.resolved = true
    // Says who resolved it and why, so the row reads as a decision rather than as a
    // human having ticked something off. The UI hides resolved rows; the record does not.
    discrepancy.metadata = {
      ...(discrepancy.metadata ?? {}),
      resolvedBy: 'rfq_intake:clear-catalog-discrepancies',
      resolvedReason: 'rfq_case_is_not_priced_from_the_catalog_at_acceptance',
    }
    em.persist(discrepancy)
  }
  await em.flush()

  logger.info('Cleared catalog-match blockers from an RFQ proposal', {
    proposalId,
    actionCount: actions.length,
    cleared: blocking.length,
  })
}

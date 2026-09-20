import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerDeal } from '@open-mercato/core/modules/customers/data/entities'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { runCommand } from '../lib/commandBus'
import { resolveCaseId } from '../lib/quoteCase'

const logger = createLogger('rfq_intake').child({ subscriber: 'sync-deal-value' })

/**
 * Carries a quote's net total onto the RFQ case it was priced for.
 *
 * `sales.document.totals.calculated` rather than a quote-created hook, because the
 * question is "what is this lead worth NOW", and sales re-emits this on every
 * recalculation — a line edited in the UI moves the funnel card with it. A hook on
 * creation alone would leave the case advertising the first draft forever, which is
 * worse than no number at all: nobody distrusts a figure that looks precise.
 *
 * Persistent, and that is load-bearing rather than defensive. The emit happens INSIDE
 * `withAtomicFlush(..., { transaction: true })` (`sales/commands/documents.ts`), so an
 * inline subscriber could read the quote row before that transaction commits and find
 * nothing. A queued delivery runs after it.
 */
export const metadata = {
  event: 'sales.document.totals.calculated',
  persistent: true,
  id: 'rfq_intake:sync-deal-value',
}

export type TotalsCalculatedPayload = {
  documentKind?: string | null
  documentId?: string | null
  tenantId?: string | null
  organizationId?: string | null
  totals?: { grandTotalNetAmount?: string | number | null } | null
  lineCount?: number | null
}

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Pure guard, exported so the routing rule is pinned by a test rather than by prose.
 *
 * The event is shared with orders and with every quote in the system, including ones
 * that have nothing to do with an RFQ. Kind is checked here; whether the document
 * belongs to a case is decided by the lookup below, which is the part that needs the
 * database.
 */
export function isQuoteTotalsEvent(payload: TotalsCalculatedPayload): boolean {
  return payload?.documentKind === 'quote' && Boolean(trimmed(payload?.documentId))
}

export default async function handler(
  payload: TotalsCalculatedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  if (!isQuoteTotalsEvent(payload)) return

  const quoteId = trimmed(payload.documentId)!
  const tenantId = trimmed(payload.tenantId)
  const organizationId = trimmed(payload.organizationId)

  // Scope arrives on the event from the write that produced it. Missing scope must
  // never widen a query — fail closed instead.
  if (!tenantId || !organizationId) {
    logger.warn('Quote totals carry incomplete scope; leaving the case value alone', { quoteId })
    return
  }

  // Net, decided with the business: the funnel is read by people who forecast revenue,
  // and VAT is not revenue. The gross figure stays on the quote, where a customer
  // reads it.
  const net = payload.totals?.grandTotalNetAmount
  const amount = typeof net === 'number' ? String(net) : trimmed(net)
  if (!amount) {
    logger.warn('Quote totals carry no net grand total; leaving the case value alone', { quoteId })
    return
  }

  const em = (ctx.resolve('em') as EntityManager).fork()
  const scope = { tenantId, organizationId }

  const resolved = await resolveCaseId(em, scope, quoteId)
  if (!resolved) {
    // The common outcome, and not a problem: most quotes in the system were never
    // priced from an RFQ. Debug rather than warn, so the log stays readable.
    logger.debug('Quote is not linked to an RFQ case; nothing to update', { quoteId })
    return
  }

  const deal = await em.findOne(CustomerDeal, { id: resolved.dealId, ...scope, deletedAt: null })
  if (!deal) {
    logger.warn('Quote names a case that is not visible in this scope', {
      quoteId,
      dealId: resolved.dealId,
    })
    return
  }

  // Last write wins, including over a figure somebody typed in by hand. The
  // alternative needs a "who set this" flag on the deal, which is a data-model change
  // for a case the demo does not have: the value is owned by the quote.
  //
  // With several quotes on one case the most recently RECALCULATED one therefore wins,
  // not the newest one. For an RFQ, where the case is one enquiry and the quote is its
  // answer, that is the same document in practice.
  await runCommand(asCommandContext(ctx, organizationId), 'customers.deals.update', {
    ...scope,
    id: resolved.dealId,
    valueAmount: amount,
    valueCurrency: resolved.currencyCode,
  })

  logger.info('RFQ case value synced from its quote', {
    dealId: resolved.dealId,
    quoteId,
    valueAmount: amount,
    valueCurrency: resolved.currencyCode,
  })
}

/**
 * The subscriber holds a resolver, not a container. The command only resolves services
 * from it, so a resolver plus a cradle proxy is the whole surface it needs — the same
 * shape `lib/startProcess.ts` builds, for the same reason.
 *
 * `auth: null` is accurate: nothing here was done by a person. The write is a
 * consequence of the quote's own totals, and the deal's history records it as such.
 */
function asCommandContext(ctx: SubscriberContext, organizationId: string): CommandRuntimeContext {
  return {
    container: {
      resolve: ctx.resolve,
      cradle: new Proxy({}, { get: (_target, prop: string) => ctx.resolve(prop) }),
    } as unknown as CommandRuntimeContext['container'],
    auth: null,
    organizationScope: null,
    selectedOrganizationId: organizationId,
    organizationIds: [organizationId],
  }
}

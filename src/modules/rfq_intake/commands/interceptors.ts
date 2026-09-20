import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerDeal } from '@open-mercato/core/modules/customers/data/entities'
import { dealClosureOutcomeFromStatus } from '@open-mercato/core/modules/customers/lib/closureStage'
import { SalesQuote } from '@open-mercato/core/modules/sales/data/entities'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type {
  CommandInterceptor,
  CommandInterceptorContext,
} from '@open-mercato/shared/lib/commands/command-interceptor'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { runCommand } from '../lib/commandBus'
import type { Scope } from '../lib/pipeline'
import { resolveCaseId } from '../lib/quoteCase'

const logger = createLogger('rfq_intake').child({ interceptor: 'close-case-on-conversion' })

/**
 * Whether a conversion should close this case as won.
 *
 * Pure, so the rule is pinned by tests rather than by prose.
 *
 * A case already closed as won is skipped — converting the same quote twice must not
 * write the deal again and stack a second transition onto its history.
 *
 * A case in a LOST stage is closed as won anyway, deliberately. The customer has just
 * signed; that is a more recent fact than whoever marked the enquiry lost earlier. Note
 * this is the opposite call from the send-side guard (`lib/quoteSentFunnel.ts`), and for
 * a reason: there, nothing new had happened — a quote was merely re-sent — so a closed
 * deal stayed closed. Here the most decisive thing in the whole funnel just happened.
 */
export function shouldCloseAsWon(deal: { status?: string | null } | null): boolean {
  if (!deal) return false
  return dealClosureOutcomeFromStatus(deal.status ?? null) !== 'won'
}

/**
 * Trusted scope for a conversion, derived from the quote rather than from the actor.
 *
 * This is the part that cannot be copied from `deal_links/commands/interceptors.ts`.
 * That one reads `ctx.auth?.tenantId`, which is `null` on the PUBLIC acceptance path:
 * `sales/api/quotes/accept/route.ts:128-136` builds its command context with
 * `auth: null` — the customer holds a quote token, not a session — and puts no
 * `tenantId` anywhere on it. Of what an interceptor is handed, only
 * `selectedOrganizationId` is populated on both paths.
 *
 * So the organization comes from the context and the tenant comes from the quote row
 * read within it. That is deriving scope from a record the command just operated on, not
 * trusting a payload: the query is already narrowed by organization, and a quote that
 * does not answer to it simply is not found. Missing scope returns `null` and the hook
 * does nothing — it never widens into an unscoped read.
 */
async function resolveConversionScope(
  ctx: CommandInterceptorContext,
  quoteId: string,
): Promise<{ em: EntityManager; scope: Scope } | null> {
  // `CommandInterceptorContext` is a narrower shape than the runtime context a command
  // receives: `commandId`, `auth`, `selectedOrganizationId`, `container`, `metadata`, and
  // nothing else. There is no `organizationIds` here to fall back to.
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (!organizationId) {
    logger.warn('Conversion carries no organization scope; leaving the case alone', { quoteId })
    return null
  }

  const em = (ctx.container.resolve('em') as EntityManager).fork()
  const quote = await em.findOne(SalesQuote, { id: quoteId, organizationId, deletedAt: null })
  const tenantId = quote?.tenantId ?? null
  if (!tenantId) {
    logger.warn('Converted quote is not visible in this organization; leaving the case alone', {
      quoteId,
      organizationId,
    })
    return null
  }

  return { em, scope: { tenantId, organizationId } }
}

/**
 * Closes the RFQ case as won when its quote is converted into an order.
 *
 * `sales.quotes.convert_to_order` emits no event, so there is nothing to subscribe to —
 * but unlike the send route it IS a command, so the ordinary UMES seam applies and no
 * route has to be replaced. `deal_links` already intercepts this same command, which is
 * the proof that the hook fires here.
 *
 * Catches every conversion, by decision: the customer accepting through their quote link
 * (`sales/api/quotes/accept/route.ts`) and a salesperson converting by hand
 * (`sales/api/quotes/convert/route.ts`). A conversion is the win whoever clicked it.
 *
 * **The write is `status: 'win'` with NO `pipelineStageId`, and that is load-bearing.**
 * `customers/commands/deals.ts:798-801` only resolves the closure stage when
 * `pipelineStageId === undefined`:
 *
 *     parsed.pipelineStageId === undefined && requestedClosureOutcome
 *       ? await loadClosurePipelineStageSnapshot(...)
 *
 * Passing a stage id — which is exactly what `rfq_intake.deal.advance` does — would skip
 * that branch and leave a deal that reads `Closed Won` on the board while its `status` is
 * still `open` and `closureOutcome` is null. Letting the installed command resolve the
 * terminal stage by label is why `RFQ_PIPELINE_STAGES` spells the closing stages in
 * English in the first place (see `lib/pipeline.ts`).
 *
 * Transaction timing differs between the two paths, and the note on `deal_links`'
 * interceptor only analysed one of them. The accept route runs the command inside its OWN
 * `em.transactional` (passing `transactionalEm: trx`), while `CommandBus.execute` runs
 * `runCommandInterceptorsAfter` before it returns (`command-bus.ts:336`) — so on that
 * path this hook runs INSIDE the acceptance transaction, before it commits. On the staff
 * path there is no outer transaction at all.
 *
 * HACK(hackathon): the close cannot join that acceptance transaction even so, because
 * `CommandInterceptorContext` does not carry `transactionalEm` — the hook only receives
 * `auth`, `selectedOrganizationId` and the container. The close therefore runs in its own
 * transaction on a forked EM, and an acceptance that rolled back after this point would
 * leave the case closed as won with no order behind it. The window is one commit wide
 * (nothing between the command returning and the transaction closing can throw), and
 * `deal_links` already carries exactly this tradeoff on exactly this command. Closing it
 * properly needs an upstream change to pass the transactional EM through to interceptors.
 *
 * HACK(hackathon): undoing the conversion does NOT reopen the case. The convert command's
 * own undo hard-deletes the order, so an undone conversion leaves a deal sitting in
 * `Closed Won` with no order behind it, repairable only by hand. Deliberate — restoring
 * the previous stage needs it captured here and replayed in `afterUndo`, which is more
 * machinery than the demo earns. Revisit if undo is ever used in anger.
 */
export const interceptors: CommandInterceptor[] = [
  {
    id: 'rfq_intake.close-case-on-conversion',
    targetCommand: 'sales.quotes.convert_to_order',
    priority: 50,
    async afterExecute(input, _result, ctx) {
      // Nothing in here may fail the conversion. On the acceptance path a throw would
      // roll back the customer's acceptance — the order and the quote's `confirmed`
      // status with it — because this hook runs inside that transaction. A funnel move
      // must never be able to refuse a signature.
      try {
        await closeCaseForConversion(input, ctx)
      } catch (err) {
        logger.error('Quote was converted but its case could not be closed', { err })
      }
    },
  },
]

async function closeCaseForConversion(input: unknown, ctx: CommandInterceptorContext): Promise<void> {
  const quoteId = (input as { quoteId?: unknown } | null)?.quoteId
  if (typeof quoteId !== 'string' || quoteId.trim().length === 0) {
    // `sales.quotes.convert_to_order` always sends `quoteId` as a string today, so this
    // can only fire after an upstream rename. Log it rather than swallow it, so the drift
    // is visible instead of silently leaving every case open.
    logger.warn('Expected a string quoteId on convert_to_order', {
      commandId: 'sales.quotes.convert_to_order',
      quoteIdType: typeof quoteId,
    })
    return
  }

  const resolvedScope = await resolveConversionScope(ctx, quoteId)
  if (!resolvedScope) return
  const { em, scope } = resolvedScope

  const resolved = await resolveCaseId(em, scope, quoteId)
  if (!resolved) {
    // The common outcome: most quotes in the system were never priced from an RFQ.
    logger.debug('Converted quote is not linked to an RFQ case; nothing to close', { quoteId })
    return
  }

  const deal = await em.findOne(CustomerDeal, { id: resolved.dealId, ...scope, deletedAt: null })
  if (!deal) {
    logger.warn('Converted quote names a case that is not visible in this scope', {
      quoteId,
      dealId: resolved.dealId,
    })
    return
  }

  if (!shouldCloseAsWon(deal)) {
    logger.debug('Case is already closed as won; leaving it alone', {
      quoteId,
      dealId: resolved.dealId,
    })
    return
  }

  await runCommand(asCommandContext(ctx, scope), 'customers.deals.update', {
    ...scope,
    id: resolved.dealId,
    status: 'win',
  })

  logger.info('RFQ case closed as won by its converted quote', {
    quoteId,
    dealId: resolved.dealId,
    from: deal.status ?? null,
  })
}

export default interceptors

/**
 * Widens the interceptor's context into the one a command expects.
 *
 * `auth` is carried through rather than forced to `null`: on the staff conversion path a
 * real person clicked it and the deal's history should say so, while on the public
 * acceptance path it is already `null` and the write is correctly recorded as nobody's.
 */
function asCommandContext(ctx: CommandInterceptorContext, scope: Scope): CommandRuntimeContext {
  return {
    container: ctx.container as unknown as CommandRuntimeContext['container'],
    auth: ctx.auth,
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  }
}

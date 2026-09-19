import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandInterceptor } from '@open-mercato/shared/lib/commands/command-interceptor'
import { DealDocumentLink } from '../data/entities'

/**
 * Carries a deal link across the quote → order conversion.
 *
 * `sales.quotes.convert_to_order` emits NO event — its body
 * (`sales/commands/documents.ts:6368-7117`) writes an audit entry and nothing else —
 * so there is nothing to subscribe to. Intercepting the command instead of its
 * callers means every conversion is caught: staff UI, API, or agent alike.
 *
 * Auto-discovered by the `commands/interceptors.ts` convention; no DI registration.
 *
 * Commit timing (checked in `@open-mercato/shared/src/lib/commands/command-bus.ts`
 * and `command-interceptor-runner.ts`): `CommandBus.execute()` awaits
 * `handler.execute(...)` — for this command that is
 * `transactionalEm.transactional((trx) => runConversion(trx))`, which commits the
 * quote-status-flip + order-materialization transaction before that await resolves
 * — then runs `captureAfter`, `buildLog`, and `persistLog` (the audit write), and
 * only after all of that calls `runCommandInterceptorsAfter(...)`. So this hook
 * runs strictly AFTER the conversion's transaction has committed, satisfying
 * AGENTS.md's post-commit rule for effects.
 * HACK(hackathon): because the hook runs after commit, a crash between that commit
 * and this hook running (process death, afterExecute throwing before em.flush())
 * leaves the new order converted but unlinked from its deal, with no reconciliation
 * job to repair it. Acceptable for the hackathon; would need a reconciliation sweep
 * (e.g. compare orders against their source quote's deal link) before this ships wider.
 */
export const interceptors: CommandInterceptor[] = [
  {
    id: 'deal_links.link-converted-order',
    targetCommand: 'sales.quotes.convert_to_order',
    priority: 50,
    async afterExecute(input, result, ctx) {
      const quoteId = (input as { quoteId?: unknown } | null)?.quoteId
      const orderId = (result as { orderId?: unknown } | null)?.orderId
      if (typeof quoteId !== 'string' || typeof orderId !== 'string') return

      // Fail closed: an unscoped lookup here would search every tenant's links.
      const tenantId = ctx.auth?.tenantId ?? null
      const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
      if (!tenantId || !organizationId) return

      const em = (ctx.container.resolve('em') as EntityManager).fork()

      const source = await em.findOne(DealDocumentLink, {
        documentId: quoteId,
        documentKind: 'quote',
        tenantId,
        organizationId,
        deletedAt: null,
      })
      // The quote did not come from a deal. Not our business.
      if (!source) return

      const existing = await em.findOne(DealDocumentLink, {
        documentId: orderId,
        documentKind: 'order',
        tenantId,
        organizationId,
        deletedAt: null,
      })
      if (existing) return

      em.persist(
        em.create(DealDocumentLink, {
          dealId: source.dealId,
          documentId: orderId,
          documentKind: 'order',
          tenantId,
          organizationId,
        }),
      )
      await em.flush()
    },
  },
]

export default interceptors

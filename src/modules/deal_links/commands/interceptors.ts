import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandInterceptor } from '@open-mercato/shared/lib/commands/command-interceptor'
import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { DealDocumentLink } from '../data/entities'

const logger = createLogger('deal_links').child({ interceptor: 'link-converted-order' })

/**
 * Shape of the `order` half of `sales.quotes.convert_to_order`'s undo payload,
 * as written by that command's own `buildLog` (`sales/commands/documents.ts`
 * around line 6757: `payload.undo = { quote: before, order: after }`, where
 * `after` is an `OrderGraphSnapshot`). We do not import from `sales` — this is
 * a local, minimal re-statement of the persisted JSON shape, read generically
 * off `undoContext.logEntry` via the shared `extractUndoPayload` helper. Only
 * the fields we actually read are declared.
 */
type ConvertUndoPayload = {
  order?: { order?: { id?: string } } | null
}

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
 *
 * Second write path, deliberately: this hook writes directly with `em.create`/
 * `em.persist`/`em.flush` instead of calling `deal_links.document_links.create`
 * (REQ-002 asks for exactly one write path — a command). That command runs
 * through the command bus; re-entering the bus from inside this post-commit
 * interceptor hook (itself run by the bus, for a *different* command) would be
 * circular. The plan prescribed writing here directly for that reason, so this
 * is not an oversight, but it does cost what going through the command would
 * have bought: no Zod validation of the row we build (`dealId`/`orderId` are
 * taken as-is from the already-validated conversion's own input/result), no
 * audit-log entry for the link creation, and no CRUD-cache invalidation if
 * `ENABLE_CRUD_API_CACHE` is ever turned on in a deployed environment — a
 * cached document-links list would keep serving the pre-conversion order-less
 * state until it naturally expires.
 */
export const interceptors: CommandInterceptor[] = [
  {
    id: 'deal_links.link-converted-order',
    targetCommand: 'sales.quotes.convert_to_order',
    priority: 50,
    async afterExecute(input, result, ctx) {
      const quoteId = (input as { quoteId?: unknown } | null)?.quoteId
      const orderId = (result as { orderId?: unknown } | null)?.orderId
      if (typeof quoteId !== 'string' || typeof orderId !== 'string') {
        // Today `sales.quotes.convert_to_order` always sends both keys as
        // strings, so this can only fire after an upstream `sales` rename —
        // log it instead of swallowing it, so that drift is visible instead of
        // silently producing a deal with an honest-looking but wrong "no order" tab.
        logger.warn('Expected string quoteId/orderId not found on convert_to_order', {
          commandId: 'sales.quotes.convert_to_order',
          expectedKeys: ['input.quoteId', 'result.orderId'],
          quoteIdType: typeof quoteId,
          orderIdType: typeof orderId,
        })
        return
      }

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
    /**
     * Undoes the link created above when the conversion itself is undone.
     *
     * `sales.quotes.convert_to_order`'s own `undo` (`sales/commands/documents.ts`
     * around line 6780) hard-deletes the order and its lines/shipments/payments
     * via `nativeDelete`. Without this hook the link row created in
     * `afterExecute` above would survive with `documentKind: 'order'` pointing
     * at a document that no longer exists — a dead row the deal tab renders as
     * a 404 link, with no delete route to clean it up by hand.
     *
     * `CommandInterceptorUndoContext` (`command-interceptor.ts`) is NOT the
     * same shape as `afterExecute`'s `(input, result, ctx)` — it carries
     * `{ input, logEntry, undoToken }`, no `result`. The created order's id is
     * not in `input` (the original `{ quoteId, orderId?, orderNumber? }` sent
     * to `execute`); it has to be read back off `logEntry`, the persisted
     * `ActionLog` row, via the shared `extractUndoPayload` helper — see the
     * `ConvertUndoPayload` comment above for exactly what shape that is.
     */
    async afterUndo(undoContext, ctx) {
      // Fail closed: an unscoped lookup here would search every tenant's links.
      const tenantId = ctx.auth?.tenantId ?? null
      const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
      if (!tenantId || !organizationId) return

      const payload = extractUndoPayload<ConvertUndoPayload>(
        undoContext.logEntry as Parameters<typeof extractUndoPayload>[0],
      )
      const orderId = payload?.order?.order?.id
      if (typeof orderId !== 'string') return

      const em = (ctx.container.resolve('em') as EntityManager).fork()

      const link = await em.findOne(DealDocumentLink, {
        documentId: orderId,
        documentKind: 'order',
        tenantId,
        organizationId,
        deletedAt: null,
      })
      if (!link) return

      link.deletedAt = new Date()
      em.persist(link)
      await em.flush()
    },
  },
]

export default interceptors

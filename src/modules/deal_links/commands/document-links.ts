import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { z } from 'zod'
import { DealDocumentLink } from '../data/entities'

/**
 * Non-strict on purpose: unknown keys are STRIPPED rather than rejected. The
 * caller is another command forwarding a model-produced payload, which may carry
 * `tenantId`/`organizationId`; stripping them here is what makes it impossible to
 * write a row into someone else's scope by asking nicely.
 *
 * HACK(hackathon): `dealId` and `documentId` are validated as UUIDs only, not
 * as ids that actually exist. Their eventual caller forwards an LLM-produced
 * payload, so a hallucinated UUID is accepted and written happily. Checking
 * `dealId` against `customers` would mean a cross-module ORM read, which the
 * repo forbids (`.ai/guides/contracts.md`), and the `customers` read path is
 * not wired here either way. What breaks: a bad id becomes a dead row in the
 * deal-documents tab with no cleanup path — the module ships no delete route.
 */
export const documentLinkCreateSchema = z.object({
  dealId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentKind: z.enum(['quote', 'order']),
})

export type DocumentLinkCreateInput = z.infer<typeof documentLinkCreateSchema>

function ensureScope(ctx: CommandRuntimeContext): { tenantId: string; organizationId: string } {
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) throw new CrudHttpError(400, { error: 'Tenant context is required' })
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (!organizationId) throw new CrudHttpError(400, { error: 'Organization context is required' })
  return { tenantId, organizationId }
}

/**
 * NOT joined to the caller's transaction. `execute` writes through
 * `dataEngine.createOrmEntity` (`@open-mercato/shared/lib/data/engine.ts`),
 * which persists and flushes on the data engine's OWN `EntityManager` and
 * never reads `ctx.transactionalEm` — so this write commits immediately,
 * regardless of whatever transaction the caller is running in.
 *
 * This matters because the command this interface was published for —
 * whatever creates the quote — will plausibly wrap its own work in
 * `em.transactional(...)`, the same pattern `sales.quotes.convert_to_order`
 * uses for its quote-status-flip + order-materialization. A caller that calls
 * this command from INSIDE such a transaction and then fails after the call
 * rolls its own work back while this link row stays committed: the result is
 * an orphan link pointing at a document (e.g. a quote) that never actually
 * came to exist. Callers that wrap their work in a transaction MUST call this
 * command AFTER their transaction commits, not from within it. The module
 * ships no delete command and no DELETE route, so an orphan created this way
 * has no cleanup path short of hand-written SQL.
 */
const createDocumentLinkCommand: CommandHandler<Record<string, unknown>, DealDocumentLink> = {
  id: 'deal_links.document_links.create',
  async execute(rawInput, ctx) {
    const parsed = documentLinkCreateSchema.parse(rawInput)
    const scope = ensureScope(ctx)
    const de = ctx.container.resolve('dataEngine') as DataEngine

    // HACK(hackathon): no emitCrudSideEffects and no search indexing for link
    // rows. Nothing subscribes to them yet and nothing searches them. What breaks:
    // a future consumer wanting `deal_links.document_link.created` has to add the
    // emission here first.
    return de.createOrmEntity({
      entity: DealDocumentLink,
      data: {
        dealId: parsed.dealId,
        documentId: parsed.documentId,
        documentKind: parsed.documentKind,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      },
    })
  },
}

registerCommand(createDocumentLinkCommand)

export { createDocumentLinkCommand }

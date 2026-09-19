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

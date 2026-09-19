import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { ensureRfqPipeline } from './lib/pipeline'
import { ensureRfqProcessDefinition } from './lib/processDefinition'

/**
 * `seedDefaults` runs once per organization during `mercato init`, in dependency order,
 * so `customers` has already seeded its own "Default Pipeline" by the time we arrive
 * and `ensureRfqPipeline` demotes it.
 *
 * It does NOT run on a tenant that already exists, which every environment we deploy
 * to already is. `mercato rfq_intake seed-pipeline` and `mercato rfq_intake
 * seed-process` are the same two calls for those, and `mercato seed:defaults
 * --module rfq_intake` runs this hook itself for every organization.
 */
export const setup: ModuleSetupConfig = {
  async seedDefaults(ctx) {
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    await ensureRfqPipeline(ctx.em as EntityManager, scope)
    // The funnel is CRM structure; this is the orchestrator entry point for the same
    // case. Both are scoped rows nothing derives from code, so both belong here.
    await ensureRfqProcessDefinition(ctx.em as EntityManager, ctx.container, scope)
  },
}

export default setup

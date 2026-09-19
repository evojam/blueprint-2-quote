import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { ensureRfqPipeline } from './lib/pipeline'

/**
 * `seedDefaults` runs once per organization during `mercato init`, in dependency order,
 * so `customers` has already seeded its own "Default Pipeline" by the time we arrive
 * and `ensureRfqPipeline` demotes it.
 *
 * It does NOT run on a tenant that already exists, which every environment we deploy
 * to already is — `mercato rfq_intake seed-pipeline` is the same call for those.
 */
export const setup: ModuleSetupConfig = {
  async seedDefaults(ctx) {
    await ensureRfqPipeline(ctx.em as EntityManager, {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
  },
}

export default setup

import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { z } from 'zod'
import { runCommand } from '../lib/commandBus'
import { RFQ_STAGE_KEYS, resolveRfqStageId, type RfqStageKey } from '../lib/pipeline'

const logger = createLogger('rfq_intake').child({ component: 'pipeline-command' })

const advanceInputSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  dealId: z.string().uuid(),
  stage: z.enum(RFQ_STAGE_KEYS as [RfqStageKey, ...RfqStageKey[]]),
})
type AdvanceInput = z.infer<typeof advanceInputSchema>

/**
 * Moves an RFQ case to one stage of the funnel defined in `lib/pipeline.ts`.
 *
 * A workflow step calls this rather than writing `pipelineStageId` itself, because the
 * stage id is a per-tenant row: the graph can only name the stage symbolically and have
 * it resolved at run time.
 *
 * A missing funnel is a warning, not a failure. The analysis is the valuable part of
 * the run and it must not be lost because nobody seeded the pipeline; the case simply
 * stays where it is, and `mercato rfq_intake seed-pipeline` fixes the next one.
 */
const advanceDealStageCommand: CommandHandler<AdvanceInput, { moved: boolean; stageId: string | null }> = {
  id: 'rfq_intake.deal.advance',
  async execute(rawInput, ctx) {
    const input = advanceInputSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scope = { tenantId: input.tenantId, organizationId: input.organizationId }

    const stageId = await resolveRfqStageId(em, scope, input.stage)
    if (!stageId) {
      logger.warn('RFQ pipeline is not seeded; leaving the case where it is', {
        stage: input.stage,
        dealId: input.dealId,
      })
      return { moved: false, stageId: null }
    }

    // `customers.deals.update` derives the pipeline from the stage and records the
    // transition in the deal's history, so the card carries a timeline rather than a
    // silently mutated column.
    await runCommand(ctx, 'customers.deals.update', {
      ...scope,
      id: input.dealId,
      pipelineStageId: stageId,
    })

    logger.info('RFQ case moved', { dealId: input.dealId, stage: input.stage })
    return { moved: true, stageId }
  },
}

registerCommand(advanceDealStageCommand)

export { advanceDealStageCommand }

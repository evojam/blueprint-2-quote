import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { z } from 'zod'
import { AgentRun, AgentRunArtifact } from '@open-mercato/enterprise/modules/agent_orchestrator/data/entities'
import { getArtifactBytes } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/runtime/artifactFileStore'
import {
  PDF_AGENT_ID,
  ROOM_DIMENSIONS_AGENT_ID,
} from '@/modules/property_documents/ai-tools'
import { CATALOG_MATCHER_AGENT_ID } from '@/modules/property_documents/ai-agents'

const logger = createLogger('rfq_intake').child({ component: 'analysis-commands' })

/** The attachments module's entity id for a CRM case; artifacts promote onto it. */
const DEAL_ENTITY_ID = 'customers:customer_deal'

const BRIEF_MANIFEST = 'brief.json'
const FLOOR_PLANS_MANIFEST = 'floor-plans.json'

/** Matches `catalog_matcher`'s own default; its instructions clamp 1..10 anyway. */
const CATALOG_MATCH_LIMIT = 5

/**
 * Bound on the fan-out. A brief with three hundred requirements is a malformed
 * document or a prompt-injection attempt, not a work item, and either way we do not
 * spend three hundred model calls finding out.
 */
const MAX_ITEMS = 40

const analysisInputSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  dealId: z.string().uuid(),
  workflowInstanceId: z.string().uuid(),
  stepId: z.string().min(1).optional(),
})
type AnalysisInput = z.infer<typeof analysisInputSchema>

type AgentRuntimeLike = {
  run: (
    agentId: string,
    input: unknown,
    ctx: {
      tenantId: string
      organizationId: string
      userId: string
      workflowInstanceId?: string
      stepId?: string
      invocationId?: string
    },
  ) => Promise<unknown>
}

type CommandCtx = Parameters<CommandHandler<AnalysisInput, unknown>['execute']>[1]

function scopeOf(input: AnalysisInput) {
  return { tenantId: input.tenantId, organizationId: input.organizationId }
}

/**
 * The `pdf_intake` run of THIS workflow instance.
 *
 * Correlating by instance rather than by "the newest run for this agent" is what
 * keeps two RFQs processed at the same second from reading each other's manifests.
 */
async function findIntakeRun(em: EntityManager, input: AnalysisInput) {
  return em.findOne(
    AgentRun,
    {
      ...scopeOf(input),
      workflowInstanceId: input.workflowInstanceId,
      agentId: PDF_AGENT_ID,
      deletedAt: null,
    },
    { orderBy: { createdAt: 'DESC' } },
  )
}

async function readManifest(
  em: EntityManager,
  ctx: CommandCtx,
  input: AnalysisInput,
  runId: string,
  fileName: string,
): Promise<unknown | null> {
  const artifact = await em.findOne(AgentRunArtifact, {
    ...scopeOf(input),
    runId,
    fileName,
    deletedAt: null,
  })
  if (!artifact) return null
  const bytes = await getArtifactBytes(
    ctx.container as never,
    scopeOf(input),
    artifact.storageKey,
  )
  if (!bytes) return null
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    logger.warn('Manifest is not valid JSON', { fileName, runId, err: error })
    return null
  }
}

function basename(value: string): string {
  const parts = value.split('/')
  return parts[parts.length - 1] ?? value
}

function agentCtx(input: AnalysisInput, ctx: CommandCtx, invocationId: string) {
  return {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    userId: (ctx.auth?.sub as string | undefined) ?? '',
    workflowInstanceId: input.workflowInstanceId,
    stepId: input.stepId,
    invocationId,
  }
}

// ---------------------------------------------------------------------------
// rfq_intake.plans.analyze
// ---------------------------------------------------------------------------

type PlanEntry = { sourcePage?: number; title?: string | null; artifactPath?: string }

/**
 * Reads every plan `pdf_intake` extracted and runs `room_dimensions` over each.
 *
 * The iteration lives here rather than in the workflow graph because the engine has
 * no dynamic fan-out — `PARALLEL_FORK` opens one branch per static transition — and
 * because `room_dimensions` accepts exactly one image by design, which is what keeps
 * it testable in isolation. Each call still produces a real `AgentRun` correlated to
 * this instance and step, so the trace is unchanged.
 *
 * One plan failing is recorded and the loop continues: a single unreadable drawing
 * must not cost us the rooms found in the others.
 */
const analyzePlansCommand: CommandHandler<AnalysisInput, {
  analysed: number
  failed: number
  rooms: unknown[]
}> = {
  id: 'rfq_intake.plans.analyze',
  async execute(rawInput, ctx) {
    const input = analysisInputSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const agentRuntime = ctx.container.resolve('agentRuntime') as AgentRuntimeLike
    const commandBus = ctx.container.resolve('commandBus') as {
      execute: <TIn, TOut>(id: string, input: TIn, ctx?: unknown) => Promise<TOut>
    }

    const run = await findIntakeRun(em, input)
    if (!run) {
      logger.warn('No pdf_intake run for this workflow instance', {
        workflowInstanceId: input.workflowInstanceId,
      })
      return { analysed: 0, failed: 0, rooms: [] }
    }

    const manifest = (await readManifest(em, ctx, input, run.id, FLOOR_PLANS_MANIFEST)) as
      | { plans?: PlanEntry[] }
      | null
    const plans = (manifest?.plans ?? []).filter((plan) => typeof plan?.artifactPath === 'string')
    if (plans.length === 0) {
      logger.info('The brief contained no floor plans; nothing to measure', { runId: run.id })
      return { analysed: 0, failed: 0, rooms: [] }
    }

    const artifacts = await em.find(AgentRunArtifact, {
      ...scopeOf(input),
      runId: run.id,
      deletedAt: null,
    })
    const byFileName = new Map(artifacts.map((artifact) => [artifact.fileName, artifact]))

    const rooms: unknown[] = []
    let failed = 0

    for (const plan of plans.slice(0, MAX_ITEMS)) {
      const fileName = basename(plan.artifactPath as string)
      const artifact = byFileName.get(fileName)
      if (!artifact) {
        logger.warn('Plan manifest names an artifact the run did not capture', { fileName })
        failed += 1
        continue
      }

      try {
        const { attachmentId } = await commandBus.execute<
          Record<string, unknown>,
          { attachmentId: string }
        >('agent_orchestrator.artifact.promote', {
          ...scopeOf(input),
          artifactId: artifact.id,
          entityId: DEAL_ENTITY_ID,
          recordId: input.dealId,
          fileName,
        })

        const result = await agentRuntime.run(
          ROOM_DIMENSIONS_AGENT_ID,
          {
            task: 'Extract every visible room dimension from the attached floor-plan image and group the dimensions by room.',
            __files: { attachments: [{ attachmentId, as: 'floor-plan.png' }] },
          },
          agentCtx(input, ctx, `plan:${artifact.id}`),
        )
        rooms.push({ plan: plan.title ?? fileName, attachmentId, result })
      } catch (error) {
        failed += 1
        logger.warn('Plan analysis failed; continuing with the remaining plans', {
          fileName,
          err: error,
        })
      }
    }

    return { analysed: rooms.length, failed, rooms }
  },
}

// ---------------------------------------------------------------------------
// rfq_intake.requirements.match
// ---------------------------------------------------------------------------

type RequirementEntry = { category?: string; text?: string }

/**
 * Runs `catalog_matcher` once per requirement in the brief.
 *
 * One requirement per call is what that agent's own contract expects: it derives a
 * single catalog query of one to four terms and searches once. Concatenating the
 * brief's requirements into one string would collapse them into a query for whichever
 * phrase happened to dominate, and every service has to reach the quote — a
 * requirement the matcher never saw is a missing quote line.
 *
 * An unmatched requirement is reported, never dropped.
 */
const matchRequirementsCommand: CommandHandler<AnalysisInput, {
  matched: number
  unmatched: string[]
  failed: number
  results: unknown[]
}> = {
  id: 'rfq_intake.requirements.match',
  async execute(rawInput, ctx) {
    const input = analysisInputSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const agentRuntime = ctx.container.resolve('agentRuntime') as AgentRuntimeLike

    const run = await findIntakeRun(em, input)
    if (!run) return { matched: 0, unmatched: [], failed: 0, results: [] }

    const brief = (await readManifest(em, ctx, input, run.id, BRIEF_MANIFEST)) as
      | { requirements?: RequirementEntry[] }
      | null
    const requirements = (brief?.requirements ?? [])
      .map((requirement) => (typeof requirement?.text === 'string' ? requirement.text.trim() : ''))
      .filter((text) => text.length > 0)

    if (requirements.length === 0) {
      logger.info('The brief stated no requirements; nothing to match', { runId: run.id })
      return { matched: 0, unmatched: [], failed: 0, results: [] }
    }

    const results: unknown[] = []
    const unmatched: string[] = []
    let failed = 0

    for (const [index, text] of requirements.slice(0, MAX_ITEMS).entries()) {
      try {
        const result = (await agentRuntime.run(
          CATALOG_MATCHER_AGENT_ID,
          { text, limit: CATALOG_MATCH_LIMIT },
          agentCtx(input, ctx, `requirement:${index}`),
        )) as { data?: { matches?: unknown[] } } | null
        const matches = result?.data?.matches ?? []
        if (matches.length === 0) unmatched.push(text)
        results.push({ text, result })
      } catch (error) {
        failed += 1
        unmatched.push(text)
        logger.warn('Requirement matching failed; continuing with the remaining requirements', {
          err: error,
        })
      }
    }

    return { matched: results.length - unmatched.length, unmatched, failed, results }
  },
}

registerCommand(analyzePlansCommand)
registerCommand(matchRequirementsCommand)

export { analyzePlansCommand, matchRequirementsCommand }

import { createHash, randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { z } from 'zod'
import {
  AgentRun,
  AgentRunArtifact,
} from '@open-mercato/enterprise/modules/agent_orchestrator/data/entities'
import { getArtifactBytes } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/runtime/artifactFileStore'
import {
  CATALOG_MATCHER_AGENT_ID,
  catalogMatcherGroupedResultSchema,
} from '@/modules/property_documents/ai-agents'
import { PDF_AGENT_ID } from '@/modules/property_documents/ai-tools'

const BRIEF_FILE = 'brief.json'
const PAGE_INVENTORY_FILE = 'pdf-pages.json'
const MAX_BRIEF_BYTES = 65_536

const analysisInputSchema = z
  .object({
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    workflowInstanceId: z.string().uuid(),
    stepId: z.literal('match_catalog'),
  })
  .strict()
export type AnalysisInput = z.infer<typeof analysisInputSchema>
export type PdfIntakeBrief = {
  runId: string
  brief: string
}
type GroupedMatcherResult = z.infer<typeof catalogMatcherGroupedResultSchema>
type CommandCtx = Parameters<CommandHandler<AnalysisInput, unknown>['execute']>[1]
type AgentRuntime = {
  run: (
    agentId: string,
    input: unknown,
    ctx: {
      tenantId: string
      organizationId: string
      userId: string
      workflowInstanceId: string
      stepId: 'match_catalog'
      invocationId: string
    },
  ) => Promise<unknown>
}

const controlArtifactRefSchema = z
  .object({
    artifactId: z.string().uuid().nullable().optional(),
    mimeType: z.literal('application/json'),
    caption: z.string().max(2_000).nullable().optional(),
  })
  .strict()
const intakeResultSchema = z
  .object({
    kind: z.literal('artifact'),
    artifacts: z.tuple([
      controlArtifactRefSchema.extend({ fileName: z.literal(BRIEF_FILE) }).strict(),
      controlArtifactRefSchema.extend({ fileName: z.literal(PAGE_INVENTORY_FILE) }).strict(),
    ]),
    summary: z.string().max(2_000).optional(),
  })
  .strict()
const briefSchema = z.object({ brief: z.string().min(1) }).strict()

function failIntake(reason: string): never {
  throw new Error(`[internal] PDF intake ${reason.slice(0, 180)}`)
}

function parseJsonArtifact<T>(bytes: Buffer, schema: z.ZodType<T>, label: string): T {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    failIntake(`invalid ${label}`)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) failIntake(`invalid ${label}`)
  return parsed.data
}

function trustedScope(input: AnalysisInput, ctx: CommandCtx) {
  const tenantId = ctx.auth?.tenantId
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId
  if (!tenantId || !organizationId) failIntake('trusted scope is unavailable')
  if (tenantId !== input.tenantId || organizationId !== input.organizationId) {
    failIntake('trusted scope mismatch')
  }
  return { tenantId, organizationId }
}

async function readVerifiedArtifact(
  ctx: CommandCtx,
  scope: { tenantId: string; organizationId: string },
  artifact: AgentRunArtifact,
): Promise<Buffer> {
  if (
    typeof artifact.storageKey !== 'string' ||
    artifact.storageKey.length === 0 ||
    !Number.isInteger(artifact.fileSize) ||
    artifact.fileSize < 1 ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256)
  ) {
    failIntake('invalid artifact metadata')
  }
  const bytes = await getArtifactBytes(ctx.container, scope, artifact.storageKey)
  if (!bytes) failIntake('unreadable artifact')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== artifact.fileSize || digest !== artifact.sha256) {
    failIntake('invalid artifact metadata')
  }
  return bytes
}

async function findIntakeRun(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  workflowInstanceId: string,
): Promise<AgentRun | null> {
  return em.findOne(
    AgentRun,
    {
      ...scope,
      workflowInstanceId,
      stepId: 'extract_pdf',
      agentId: PDF_AGENT_ID,
      deletedAt: null,
    },
    { orderBy: { createdAt: 'DESC' } },
  )
}

export async function loadPdfIntakeBrief(
  em: EntityManager,
  ctx: CommandCtx,
  rawInput: AnalysisInput,
): Promise<PdfIntakeBrief> {
  const input = analysisInputSchema.parse(rawInput)
  const scope = trustedScope(input, ctx)
  const run = await findIntakeRun(em, scope, input.workflowInstanceId)
  if (
    !run ||
    run.tenantId !== scope.tenantId ||
    run.organizationId !== scope.organizationId ||
    run.workflowInstanceId !== input.workflowInstanceId ||
    run.stepId !== 'extract_pdf' ||
    run.agentId !== PDF_AGENT_ID ||
    run.deletedAt != null ||
    run.status !== 'ok' ||
    run.resultKind !== 'artifact'
  ) {
    failIntake('completed run is unavailable')
  }

  const parsedResult = intakeResultSchema.safeParse(run.output)
  if (!parsedResult.success) failIntake('invalid AgentResult')

  const briefArtifact = await em.findOne(AgentRunArtifact, {
    ...scope,
    runId: run.id,
    fileName: BRIEF_FILE,
    deletedAt: null,
  })
  if (
    !briefArtifact ||
    briefArtifact.tenantId !== scope.tenantId ||
    briefArtifact.organizationId !== scope.organizationId ||
    briefArtifact.runId !== run.id ||
    briefArtifact.fileName !== BRIEF_FILE ||
    briefArtifact.deletedAt != null
  ) {
    failIntake('artifact scope mismatch')
  }
  if (briefArtifact.mimeType !== 'application/json') failIntake('invalid artifact metadata')

  const briefReference = parsedResult.data.artifacts[0]
  if (briefReference.artifactId != null && briefReference.artifactId !== briefArtifact.id) {
    failIntake('invalid AgentResult')
  }

  const briefBytes = await readVerifiedArtifact(ctx, scope, briefArtifact)
  if (briefBytes.length > MAX_BRIEF_BYTES) failIntake(`invalid ${BRIEF_FILE}`)
  const { brief } = parseJsonArtifact(briefBytes, briefSchema, BRIEF_FILE)
  return { runId: run.id, brief }
}

async function findSuccessfulGroupedMatcherRun(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  workflowInstanceId: string,
): Promise<GroupedMatcherResult | null> {
  const runs = await em.find(
    AgentRun,
    {
      ...scope,
      workflowInstanceId,
      stepId: 'match_catalog',
      agentId: CATALOG_MATCHER_AGENT_ID,
      status: 'ok',
      deletedAt: null,
    },
    { orderBy: { createdAt: 'DESC' } },
  )

  for (const run of runs) {
    if (
      run.tenantId !== scope.tenantId ||
      run.organizationId !== scope.organizationId ||
      run.workflowInstanceId !== workflowInstanceId ||
      run.stepId !== 'match_catalog' ||
      run.agentId !== CATALOG_MATCHER_AGENT_ID ||
      run.status !== 'ok' ||
      run.deletedAt != null
    ) {
      continue
    }
    const parsed = catalogMatcherGroupedResultSchema.safeParse(run.output)
    if (parsed.success) return parsed.data
  }
  return null
}

const matchRequirementsCommand: CommandHandler<AnalysisInput, GroupedMatcherResult> = {
  id: 'rfq_intake.requirements.match',
  execute: async (rawInput, ctx) => {
    const input = analysisInputSchema.parse(rawInput)
    const scope = trustedScope(input, ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const priorResult = await findSuccessfulGroupedMatcherRun(em, scope, input.workflowInstanceId)
    if (priorResult) return priorResult

    const { brief } = await loadPdfIntakeBrief(em, ctx, input)
    const userId = ctx.auth?.sub
    if (!userId) failIntake('trusted user is unavailable')
    const agentRuntime = ctx.container.resolve('agentRuntime') as AgentRuntime
    const result = await agentRuntime.run(
      CATALOG_MATCHER_AGENT_ID,
      {
        mode: 'grouped',
        text: brief,
        maxNeeds: 40,
        limitPerNeed: 5,
      },
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        userId,
        workflowInstanceId: input.workflowInstanceId,
        stepId: 'match_catalog',
        invocationId: randomUUID(),
      },
    )
    return catalogMatcherGroupedResultSchema.parse(result)
  },
}

registerCommand(matchRequirementsCommand)

export { matchRequirementsCommand }

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
  parseCatalogMatcherGroupedResult,
} from '@/modules/property_documents/ai-agents'
import { PDF_AGENT_ID, ROOM_MEASUREMENTS_AGENT_ID } from '@/modules/property_documents/ai-tools'
import { runCommand } from '../lib/commandBus'

const BRIEF_FILE = 'brief.json'
const PAGE_INVENTORY_FILE = 'pdf-pages.json'
const MAX_BRIEF_BYTES = 65_536
const GROUPED_MATCHER_LIMITS = {
  maxNeeds: 40,
  limitPerNeed: 5,
} as const

const MAX_RENDERED_PAGES = 48

const workflowCommandInputSchema = z
  .object({
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    workflowInstanceId: z.string().uuid(),
  })
  .strict()
const analysisInputSchema = workflowCommandInputSchema
  .extend({ stepId: z.literal('match_catalog') })
  .strict()
const measureRoomsInputSchema = workflowCommandInputSchema
  .extend({
    dealId: z.string().uuid(),
    stepId: z.literal('measure_rooms'),
  })
  .strict()

export type AnalysisInput = z.infer<typeof analysisInputSchema>
export type MeasureRoomsInput = z.infer<typeof measureRoomsInputSchema>
export type PdfIntakeBrief = {
  runId: string
  brief: string
}
export type RoomMeasurementFanoutResult = {
  intakeRunId: string
  totalPages: number
  succeeded: number
  failed: Array<{ fileName: string; reason: string }>
}
type WorkflowCommandInput = AnalysisInput | MeasureRoomsInput
type GroupedMatcherResult = z.infer<typeof catalogMatcherGroupedResultSchema>
type CommandCtx = Parameters<CommandHandler<WorkflowCommandInput, unknown>['execute']>[1]
type AgentRuntime = {
  run: (
    agentId: string,
    input: unknown,
    ctx: {
      tenantId: string
      organizationId: string
      userId: string
      workflowInstanceId: string
      stepId: AnalysisInput['stepId'] | MeasureRoomsInput['stepId']
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
const pageInventorySchema = z
  .object({
    pageCount: z.number().int().min(1).max(MAX_RENDERED_PAGES),
    files: z.array(z.string().regex(/^pdf-page-\d{4}\.png$/)).min(1).max(MAX_RENDERED_PAGES),
  })
  .strict()
  .superRefine(({ pageCount, files }, context) => {
    if (files.length !== pageCount) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'page count does not match files' })
    }
    if (new Set(files).size !== files.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'page files must be unique' })
    }
  })

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

function trustedScope(input: WorkflowCommandInput, ctx: CommandCtx) {
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
  const { brief } = parseJsonArtifact(briefBytes, briefSchema, BRIEF_FILE)
  if (Buffer.byteLength(brief, 'utf8') > MAX_BRIEF_BYTES) failIntake(`invalid ${BRIEF_FILE}`)
  return { runId: run.id, brief }
}

type PdfIntakePage = {
  id: string
  fileName: string
}

async function loadPdfIntakePages(
  em: EntityManager,
  ctx: CommandCtx,
  rawInput: MeasureRoomsInput,
): Promise<{ runId: string; pages: PdfIntakePage[] }> {
  const input = measureRoomsInputSchema.parse(rawInput)
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
  const inventoryArtifact = await em.findOne(AgentRunArtifact, {
    ...scope,
    runId: run.id,
    fileName: PAGE_INVENTORY_FILE,
    deletedAt: null,
  })
  if (
    !inventoryArtifact ||
    inventoryArtifact.tenantId !== scope.tenantId ||
    inventoryArtifact.organizationId !== scope.organizationId ||
    inventoryArtifact.runId !== run.id ||
    inventoryArtifact.fileName !== PAGE_INVENTORY_FILE ||
    inventoryArtifact.deletedAt != null ||
    inventoryArtifact.mimeType !== 'application/json'
  ) {
    failIntake('artifact scope mismatch')
  }
  const inventoryReference = parsedResult.data.artifacts[1]
  if (inventoryReference.artifactId != null && inventoryReference.artifactId !== inventoryArtifact.id) {
    failIntake('invalid AgentResult')
  }

  const inventory = parseJsonArtifact(
    await readVerifiedArtifact(ctx, scope, inventoryArtifact),
    pageInventorySchema,
    PAGE_INVENTORY_FILE,
  )
  const artifacts = await em.find(AgentRunArtifact, {
    ...scope,
    runId: run.id,
    deletedAt: null,
  })
  const artifactsByFileName = new Map<string, AgentRunArtifact>()
  for (const artifact of artifacts) {
    if (!inventory.files.includes(artifact.fileName)) continue
    if (
      artifactsByFileName.has(artifact.fileName) ||
      artifact.tenantId !== scope.tenantId ||
      artifact.organizationId !== scope.organizationId ||
      artifact.runId !== run.id ||
      artifact.deletedAt != null ||
      artifact.mimeType !== 'image/png' ||
      !Number.isInteger(artifact.fileSize) ||
      artifact.fileSize < 1 ||
      typeof artifact.storageKey !== 'string' ||
      artifact.storageKey.length === 0 ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256)
    ) {
      failIntake('invalid rendered page artifact')
    }
    artifactsByFileName.set(artifact.fileName, artifact)
  }
  const pages = inventory.files.map((fileName) => {
    const artifact = artifactsByFileName.get(fileName)
    if (!artifact) failIntake('invalid rendered page artifact')
    return { id: artifact.id, fileName }
  })
  return { runId: run.id, pages }
}

async function findSuccessfulGroupedMatcherRun(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  workflowInstanceId: string,
  limits: { maxNeeds: number; limitPerNeed: number },
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
    if (!parsed.success) continue
    try {
      return parseCatalogMatcherGroupedResult(parsed.data, limits)
    } catch {
      continue
    }
  }
  return null
}

const matchRequirementsCommand: CommandHandler<AnalysisInput, GroupedMatcherResult> = {
  id: 'rfq_intake.requirements.match',
  execute: async (rawInput, ctx) => {
    const input = analysisInputSchema.parse(rawInput)
    const scope = trustedScope(input, ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const priorResult = await findSuccessfulGroupedMatcherRun(
      em,
      scope,
      input.workflowInstanceId,
      GROUPED_MATCHER_LIMITS,
    )
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
        maxNeeds: GROUPED_MATCHER_LIMITS.maxNeeds,
        limitPerNeed: GROUPED_MATCHER_LIMITS.limitPerNeed,
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
    return parseCatalogMatcherGroupedResult(result, GROUPED_MATCHER_LIMITS)
  },
}

const measureRoomsCommand: CommandHandler<MeasureRoomsInput, RoomMeasurementFanoutResult> = {
  id: 'rfq_intake.measure-rooms',
  execute: async (rawInput, ctx) => {
    const input = measureRoomsInputSchema.parse(rawInput)
    const scope = trustedScope(input, ctx)
    const userId = ctx.auth?.sub
    if (!userId) failIntake('trusted user is unavailable')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const { runId, pages } = await loadPdfIntakePages(em, ctx, input)
    const agentRuntime = ctx.container.resolve('agentRuntime') as AgentRuntime
    const settled = await Promise.allSettled(
      pages.map(async (page) => {
        const { attachmentId } = await runCommand<
          {
            tenantId: string
            organizationId: string
            artifactId: string
            entityId: string
            recordId: string
            fileName: string
          },
          { attachmentId: string }
        >(ctx, 'agent_orchestrator.artifact.promote', {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          artifactId: page.id,
          entityId: 'customers:customer_deal',
          recordId: input.dealId,
          fileName: page.fileName,
        })
        await agentRuntime.run(
          ROOM_MEASUREMENTS_AGENT_ID,
          {
            __files: {
              attachments: [{ attachmentId, as: page.fileName }],
            },
          },
          {
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            userId,
            workflowInstanceId: input.workflowInstanceId,
            stepId: input.stepId,
            invocationId: `room-measurement:${page.id}`,
          },
        )
      }),
    )
    const failed = settled.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            {
              fileName: pages[index]!.fileName,
              reason: result.reason instanceof Error ? result.reason.message : 'room measurement run failed',
            },
          ]
        : [],
    )
    return {
      intakeRunId: runId,
      totalPages: pages.length,
      succeeded: pages.length - failed.length,
      failed,
    }
  },
}


registerCommand(matchRequirementsCommand)
registerCommand(measureRoomsCommand)

export { matchRequirementsCommand, measureRoomsCommand }

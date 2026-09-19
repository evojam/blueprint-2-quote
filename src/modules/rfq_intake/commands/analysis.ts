import { createHash } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { z } from 'zod'
import {
  AgentRun,
  AgentRunArtifact,
} from '@open-mercato/enterprise/modules/agent_orchestrator/data/entities'
import { getArtifactBytes } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/runtime/artifactFileStore'
import { PDF_AGENT_ID } from '@/modules/property_documents/ai-tools'

const BRIEF_FILE = 'brief.json'
const PAGE_INVENTORY_FILE = 'pdf-pages.json'
const MAX_PDF_PAGES = 48
const DEFERRED_ERROR = '[internal] PDF_INTAKE_DOWNSTREAM_DEFERRED'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const analysisInputSchema = z
  .object({
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    dealId: z.string().uuid(),
    workflowInstanceId: z.string().uuid(),
    stepId: z.string().min(1).optional(),
  })
  .strict()
export type AnalysisInput = z.infer<typeof analysisInputSchema>

type CommandCtx = Parameters<CommandHandler<AnalysisInput, unknown>['execute']>[1]

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
const briefSchema = z.object({ brief: z.string() }).strict()
const pageInventorySchema = z
  .object({
    pageCount: z.number().int().min(1).max(MAX_PDF_PAGES),
    files: z.array(z.string()).min(1).max(MAX_PDF_PAGES),
  })
  .strict()
  .superRefine((inventory, context) => {
    if (inventory.files.length !== inventory.pageCount) {
      context.addIssue({ code: 'custom', message: 'file count must equal pageCount' })
      return
    }
    inventory.files.forEach((fileName, index) => {
      const expected = `pdf-page-${String(index + 1).padStart(4, '0')}.png`
      if (fileName !== expected) {
        context.addIssue({
          code: 'custom',
          message: `page ${index + 1} must be named ${expected}`,
          path: ['files', index],
        })
      }
    })
  })

export type PdfIntakePageArtifact = {
  sourcePage: number
  artifactId: string
  fileName: string
}

export type PdfIntakeArtifactSet = {
  runId: string
  brief: string
  pages: PdfIntakePageArtifact[]
}

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
      agentId: PDF_AGENT_ID,
      deletedAt: null,
    },
    { orderBy: { createdAt: 'DESC' } },
  )
}

export async function loadPdfIntakeArtifactSet(
  em: EntityManager,
  ctx: CommandCtx,
  rawInput: AnalysisInput,
): Promise<PdfIntakeArtifactSet> {
  const input = analysisInputSchema.parse(rawInput)
  const scope = trustedScope(input, ctx)
  const run = await findIntakeRun(em, scope, input.workflowInstanceId)
  if (
    !run ||
    run.tenantId !== scope.tenantId ||
    run.organizationId !== scope.organizationId ||
    run.workflowInstanceId !== input.workflowInstanceId ||
    run.agentId !== PDF_AGENT_ID ||
    run.deletedAt != null ||
    run.status !== 'ok' ||
    run.resultKind !== 'artifact'
  ) {
    failIntake('completed run is unavailable')
  }

  const parsedResult = intakeResultSchema.safeParse(run.output)
  if (!parsedResult.success) failIntake('invalid AgentResult')

  const artifacts = await em.find(AgentRunArtifact, {
    ...scope,
    runId: run.id,
    deletedAt: null,
  })
  const byFileName = new Map<string, AgentRunArtifact>()
  for (const artifact of artifacts) {
    if (
      artifact.tenantId !== scope.tenantId ||
      artifact.organizationId !== scope.organizationId ||
      artifact.runId !== run.id ||
      artifact.deletedAt != null
    ) {
      failIntake('artifact scope mismatch')
    }
    if (byFileName.has(artifact.fileName)) failIntake('artifact set mismatch')
    byFileName.set(artifact.fileName, artifact)
  }

  const briefArtifact = byFileName.get(BRIEF_FILE)
  const inventoryArtifact = byFileName.get(PAGE_INVENTORY_FILE)
  if (!briefArtifact || !inventoryArtifact) failIntake('artifact set mismatch')
  if (
    briefArtifact.mimeType !== 'application/json' ||
    inventoryArtifact.mimeType !== 'application/json'
  ) {
    failIntake('invalid artifact metadata')
  }

  const [briefBytes, inventoryBytes] = await Promise.all([
    readVerifiedArtifact(ctx, scope, briefArtifact),
    readVerifiedArtifact(ctx, scope, inventoryArtifact),
  ])
  const brief = parseJsonArtifact(briefBytes, briefSchema, BRIEF_FILE)
  const inventory = parseJsonArtifact(inventoryBytes, pageInventorySchema, PAGE_INVENTORY_FILE)
  const expectedNames = [BRIEF_FILE, PAGE_INVENTORY_FILE, ...inventory.files]
  if (
    artifacts.length !== expectedNames.length ||
    expectedNames.some((fileName) => !byFileName.has(fileName))
  ) {
    failIntake('artifact set mismatch')
  }

  for (const reference of parsedResult.data.artifacts) {
    const row = byFileName.get(reference.fileName)!
    if (reference.artifactId != null && reference.artifactId !== row.id) {
      failIntake('invalid AgentResult')
    }
  }

  const pages: PdfIntakePageArtifact[] = []
  for (const [index, fileName] of inventory.files.entries()) {
    const artifact = byFileName.get(fileName)!
    if (artifact.mimeType !== 'image/png') failIntake('invalid artifact metadata')
    const bytes = await readVerifiedArtifact(ctx, scope, artifact)
    if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      failIntake('invalid PNG artifact')
    }
    pages.push({ sourcePage: index + 1, artifactId: artifact.id, fileName })
  }

  return { runId: run.id, brief: brief.brief, pages }
}

async function validateThenDefer(rawInput: AnalysisInput, ctx: CommandCtx): Promise<never> {
  const input = analysisInputSchema.parse(rawInput)
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  await loadPdfIntakeArtifactSet(em, ctx, input)
  throw new Error(DEFERRED_ERROR)
}

const analyzePlansCommand: CommandHandler<AnalysisInput, never> = {
  id: 'rfq_intake.plans.analyze',
  execute: validateThenDefer,
}

const matchRequirementsCommand: CommandHandler<AnalysisInput, never> = {
  id: 'rfq_intake.requirements.match',
  execute: validateThenDefer,
}

registerCommand(analyzePlansCommand)
registerCommand(matchRequirementsCommand)

export { analyzePlansCommand, matchRequirementsCommand }

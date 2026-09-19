import { createHash } from 'node:crypto'
import { execFile as nodeExecFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { defineAiTool } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-tool-definition'
import type {
  AiToolDefinition,
  McpToolContext,
} from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'

export const PDF_AGENT_ID = 'property_documents.pdf_intake'
export const PDF_TOOL_ID = 'property_documents.process_pdf'
export const ROOM_DIMENSIONS_AGENT_ID = 'property_documents.room_dimensions'
export const ROOM_DIMENSIONS_TOOL_ID = 'property_documents.extract_room_dimensions'
export const ROOM_DIMENSIONS_VISION_SERVICE = 'propertyRoomDimensionsVisionService' as const
export const MAX_PDF_PAGES = 48
export const MAX_PDF_ARTIFACTS = 50

const SESSION_TOKEN_RE = /^sess_[0-9a-f]{32}$/
const PDFINFO = '/usr/bin/pdfinfo'
const PDFTOTEXT = '/usr/bin/pdftotext'
const PDFTOPPM = '/usr/bin/pdftoppm'
const INSPECTION_FILE = '.inspection.json'
const EXEC_TIMEOUT_MS = 60_000
const OPENCODE_PROJECT_ROOT = '/home/opencode'
const EXEC_MAX_BUFFER = 1024 * 1024
const MAX_ROOM_IMAGE_BYTES = 20 * 1024 * 1024

const pageNumberSchema = z.number().int().min(1).max(MAX_PDF_PAGES)
const sortedPageListSchema = z
  .array(pageNumberSchema)
  .max(MAX_PDF_PAGES)
  .superRefine((pages, context) => {
    for (let index = 0; index < pages.length; index += 1) {
      if (index > 0 && pages[index]! <= pages[index - 1]!) {
        context.addIssue({
          code: 'custom',
          message: 'pages must be sorted and unique',
          path: [index],
        })
      }
    }
  })

const sourcePagesSchema = sortedPageListSchema
const sourceSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    pageCount: z.number().int().min(1).max(MAX_PDF_PAGES),
  })
  .strict()
const briefSourceSchema = sourceSchema
  .extend({ briefPages: sortedPageListSchema })
  .strict()
const warningSchema = z.string().min(1).max(1_000)
const nullableBoundedString = (max: number) => z.string().max(max).nullable()

export const roomDimensionSchema = z
  .object({
    value: z.number().finite(),
    unit: z.enum(['mm', 'cm', 'm', 'in', 'ft']).nullable(),
    orientation: z.enum(['horizontal', 'vertical', 'height', 'unknown']),
    kind: z.enum(['linear', 'ceiling_height', 'unknown']),
    sourceText: z.string().min(1),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()

export const roomDimensionsVisionResultSchema = z
  .object({
    rooms: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1).nullable(),
            location: z.string().min(1),
            dimensions: z.array(roomDimensionSchema),
            confidence: z.number().finite().min(0).max(1),
            warnings: z.array(z.string().min(1)),
          })
          .strict(),
      )
  })
  .strict()

const roomDimensionsVisionInputSchema = z.object({}).strict()

export const briefManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: briefSourceSchema,
    language: z.string().min(1).max(32),
    title: nullableBoundedString(500),
    summary: z.string().max(5_000),
    sections: z
      .array(
        z
          .object({
            heading: nullableBoundedString(500),
            text: z.string().min(1).max(20_000),
            sourcePages: sourcePagesSchema,
          })
          .strict(),
      )
      .max(100),
    requirements: z
      .array(
        z
          .object({
            category: z.string().min(1).max(200),
            text: z.string().min(1).max(4_000),
            sourcePages: sourcePagesSchema,
          })
          .strict(),
      )
      .max(200),
    keyFacts: z
      .array(
        z
          .object({
            label: z.string().min(1).max(200),
            value: z.string().min(1).max(2_000),
            sourcePages: sourcePagesSchema,
          })
          .strict(),
      )
      .max(200),
    unresolvedItems: z
      .array(
        z
          .object({
            text: z.string().min(1).max(2_000),
            sourcePages: sourcePagesSchema,
          })
          .strict(),
      )
      .max(100),
    warnings: z.array(warningSchema).max(100),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()

const planTypeSchema = z.enum([
  'architectural',
  'walls',
  'electrical',
  'plumbing',
  'hvac',
  'lighting',
  'reflected_ceiling',
  'fire_safety',
  'furniture',
  'demolition',
  'site',
  'mixed',
  'unknown',
])
const disciplineSchema = z.enum([
  'architectural',
  'walls',
  'electrical',
  'plumbing',
  'hvac',
  'lighting',
  'reflected_ceiling',
  'fire_safety',
  'furniture',
  'demolition',
  'site',
  'unknown',
])
const planInputSchema = z
  .object({
    sourcePage: pageNumberSchema,
    title: nullableBoundedString(500),
    level: nullableBoundedString(200),
    primaryType: planTypeSchema,
    disciplines: z
      .array(disciplineSchema)
      .max(12)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({ code: 'custom', message: 'disciplines must be unique' })
        }
      }),
    scale: nullableBoundedString(100),
    description: z.string().min(1).max(2_000),
    confidence: z.number().finite().min(0).max(1),
    evidence: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict()
const otherPageSchema = z
  .object({
    sourcePage: pageNumberSchema,
    reason: z.enum([
      'cover',
      'legend',
      'schedule',
      'elevation',
      'section',
      'detail',
      'unrelated',
      'unknown',
    ]),
  })
  .strict()
export const floorPlansInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: sourceSchema,
    plans: z.array(planInputSchema).max(MAX_PDF_PAGES),
    otherPages: z.array(otherPageSchema).max(MAX_PDF_PAGES),
    warnings: z.array(warningSchema).max(100),
  })
  .strict()

const inspectInputSchema = z.object({ operation: z.literal('inspect') }).strict()
const finalizeInputSchema = z
  .object({
    operation: z.literal('finalize'),
    brief: briefManifestSchema,
    floorPlans: floorPlansInputSchema,
  })
  .strict()

export const processPdfInputSchema = z
  .object({
    operation: z.enum(['inspect', 'finalize']),
    brief: briefManifestSchema.optional(),
    floorPlans: floorPlansInputSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.operation === 'inspect') {
      if (input.brief !== undefined || input.floorPlans !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'inspect accepts only the operation field',
        })
      }
      return
    }
    if (input.brief === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'brief is required for finalization',
        path: ['brief'],
      })
    }
    if (input.floorPlans === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'floorPlans is required for finalization',
        path: ['floorPlans'],
      })
    }
  })

type ProcessPdfInput = z.infer<typeof processPdfInputSchema>
type FinalizeInput = z.infer<typeof finalizeInputSchema>
type BriefManifest = z.infer<typeof briefManifestSchema>
type FloorPlansInput = z.infer<typeof floorPlansInputSchema>

type ExecResult = { stdout: string; stderr: string }
type SessionStore = {
  resolveActiveAgentId(sessionToken: string): Promise<string | null>
  resolveActiveRunId(sessionToken: string): Promise<string | null>
}

export interface PdfToolRuntime {
  workspaceRoot: string
  containerWorkspaceRoot: string
  execFile(file: string, args: string[]): Promise<ExecResult>
}

export type RoomDimensionsVisionResult = z.infer<typeof roomDimensionsVisionResultSchema>

export type RoomDimensionsVisionRequest = {
  dataUrl: string
  context: McpToolContext
}

export interface RoomDimensionsVisionRuntime {
  workspaceRoot: string
  containerWorkspaceRoot: string
  analyzeImage(input: RoomDimensionsVisionRequest): Promise<RoomDimensionsVisionResult>
}

export type SessionWorkspace = {
  token: string
  root: string
  inDir: string
  outDir: string
  containerRoot: string
  containerInDir: string
  containerOutDir: string
}

type InspectSuccess = {
  ok: true
  operation: 'inspect'
  fileName: string
  pageCount: number
  pages: Array<{ sourcePage: number; textPath: string; previewPath: string }>
}

type FinalizeSuccess = {
  ok: true
  operation: 'finalize'
  artifacts: Array<{ sourcePage: number; path: string }>
  manifests: string[]
}

type ProcessingFailure = {
  ok: false
  code:
    | 'invalid_attachment_count'
    | 'not_pdf'
    | 'encrypted_pdf'
    | 'malformed_pdf'
    | 'page_limit_exceeded'
    | 'pdf_runtime_unavailable'
    | 'pdf_processing_failed'
    | 'artifact_limit_exceeded'
  message: string
  fileName: string | null
  pageCount: number | null
}

type ProcessPdfResult = InspectSuccess | FinalizeSuccess | ProcessingFailure

type InspectionState = {
  schemaVersion: 1
  fileName: string
  pageCount: number
  sha256: string
}

class PdfRuntimeUnavailableError extends Error {}

function formatManifestValidationMessage(issues: string[]): string {
  const prefix = 'Manifest validation failed: '
  const retry = '. Correct all listed issues and retry finalize once.'
  const details = issues.join('; ')
  const complete = `${prefix}${details}${retry}`
  if (complete.length <= 500) return complete

  const omitted = '; additional validation issues omitted'
  const available = 500 - prefix.length - omitted.length - retry.length
  const candidate = details.slice(0, available)
  const boundary = candidate.lastIndexOf('; ')
  const visible = boundary > 0 ? candidate.slice(0, boundary) : candidate
  return `${prefix}${visible}${omitted}${retry}`
}

class PdfManifestValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(formatManifestValidationMessage(issues))
  }
}

const inspectionStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    fileName: z.string().min(1).max(255),
    pageCount: z.number().int().min(1).max(MAX_PDF_PAGES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

const defaultExecFile = promisify(nodeExecFile)

function defaultRuntime(): PdfToolRuntime {
  return {
    workspaceRoot: process.env.OM_OPENCODE_WORKSPACE_ROOT?.trim() || '/home/opencode/work',
    containerWorkspaceRoot:
      process.env.OM_OPENCODE_WORKSPACE_ROOT_CONTAINER?.trim() || '/home/opencode/work',
    async execFile(file, args) {
      const result = await defaultExecFile(file, args, {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        windowsHide: true,
      })
      return { stdout: result.stdout, stderr: result.stderr }
    },
  }
}

function defaultRoomDimensionsVisionRuntime(): RoomDimensionsVisionRuntime {
  return {
    workspaceRoot: process.env.OM_OPENCODE_WORKSPACE_ROOT?.trim() || '/home/opencode/work',
    containerWorkspaceRoot:
      process.env.OM_OPENCODE_WORKSPACE_ROOT_CONTAINER?.trim() || '/home/opencode/work',
    async analyzeImage(input) {
      const service = input.context.container.resolve<
        Pick<RoomDimensionsVisionRuntime, 'analyzeImage'>
      >(ROOM_DIMENSIONS_VISION_SERVICE)
      return service.analyzeImage(input)
    },
  }
}

function assertContained(parent: string, candidate: string, label: string): void {
  if (candidate === parent || !candidate.startsWith(`${parent}${path.sep}`)) {
    throw new Error(`[internal] PDF tool ${label} is outside configured root`)
  }
}

function toAgentReadPath(containerPath: string): string {
  const relativePath = path.posix.relative(OPENCODE_PROJECT_ROOT, containerPath)
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new Error('[internal] PDF inspection artifact is outside the OpenCode project root')
  }
  return relativePath
}

export async function resolveSessionWorkspace(
  workspaceRoot: string,
  sessionToken: string,
  containerWorkspaceRoot = workspaceRoot,
): Promise<SessionWorkspace> {
  if (!SESSION_TOKEN_RE.test(sessionToken)) {
    throw new Error('[internal] PDF tool received an invalid session token')
  }

  const configuredRoot = await realpath(path.resolve(workspaceRoot))
  const expectedRunRoot = path.resolve(configuredRoot, sessionToken)
  const runRoot = await realpath(expectedRunRoot)
  assertContained(configuredRoot, runRoot, 'run directory')

  const inDir = await realpath(path.join(runRoot, 'in'))
  const outDir = await realpath(path.join(runRoot, 'out'))
  assertContained(runRoot, inDir, 'input directory')
  assertContained(runRoot, outDir, 'output directory')

  const containerRoot = containerWorkspaceRoot.replace(/\/+$/, '') || '/home/opencode/work'
  const containerRunRoot = path.posix.join(containerRoot, sessionToken)
  return {
    token: sessionToken,
    root: runRoot,
    inDir,
    outDir,
    containerRoot: containerRunRoot,
    containerInDir: path.posix.join(containerRunRoot, 'in'),
    containerOutDir: path.posix.join(containerRunRoot, 'out'),
  }
}

export function validateRenderPages(pages: number[], pageCount: number): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PDF_PAGES) {
    throw new Error('[internal] PDF tool has an invalid page count')
  }
  const seen = new Set<number>()
  let previous = 0
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new Error(`render page ${page} is outside the PDF page range`)
    }
    if (seen.has(page)) throw new Error(`render page ${page} must be unique`)
    if (page <= previous) throw new Error('render pages must be sorted in ascending order')
    seen.add(page)
    previous = page
  }
  return [...pages]
}

async function requireActiveWorkspace(
  context: McpToolContext,
  runtime: PdfToolRuntime,
  operation: ProcessPdfInput['operation'],
): Promise<SessionWorkspace> {
  const token = context.sessionId
  if (!token || !SESSION_TOKEN_RE.test(token)) {
    throw new Error('[internal] PDF tool requires an active canonical run session')
  }
  if (!context.tenantId || !context.organizationId || !context.userId) {
    throw new Error('[internal] PDF tool requires tenant, organization, and user scope')
  }

  const store = context.container.resolve<SessionStore>('agentRunSessionStore')
  const [agentId, runId] = await Promise.all([
    store.resolveActiveAgentId(token),
    store.resolveActiveRunId(token),
  ])
  if (!runId) throw new Error('[internal] PDF tool has no active run')
  const canInspect = operation === 'inspect' && agentId === PDF_AGENT_ID
  if (!canInspect && !(operation === 'finalize' && agentId === PDF_AGENT_ID)) {
    throw new Error('[internal] PDF tool active agent mismatch')
  }

  return resolveSessionWorkspace(runtime.workspaceRoot, token, runtime.containerWorkspaceRoot)
}

async function requireRoomDimensionsWorkspace(
  context: McpToolContext,
  runtime: RoomDimensionsVisionRuntime,
): Promise<SessionWorkspace> {
  const token = context.sessionId
  if (!token || !SESSION_TOKEN_RE.test(token)) {
    throw new Error('[internal] Room dimensions tool requires an active canonical run session')
  }
  if (!context.tenantId || !context.organizationId || !context.userId) {
    throw new Error('[internal] Room dimensions tool requires tenant, organization, and user scope')
  }

  const store = context.container.resolve<SessionStore>('agentRunSessionStore')
  const [agentId, runId] = await Promise.all([
    store.resolveActiveAgentId(token),
    store.resolveActiveRunId(token),
  ])
  if (!runId) throw new Error('[internal] Room dimensions tool has no active run')
  if (agentId !== ROOM_DIMENSIONS_AGENT_ID) {
    throw new Error('[internal] Room dimensions tool active agent mismatch')
  }

  return resolveSessionWorkspace(runtime.workspaceRoot, token, runtime.containerWorkspaceRoot)
}

function detectImageMediaType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

async function readSingleRoomImage(workspace: SessionWorkspace): Promise<string> {
  // HACK(hackathon): Enterprise 0.8 exposes no pre-staging count/manifest; two
  // attachments with the same sanitized destination can collapse upstream.
  // Remove this residual once the stager supports per-agent cardinality.
  const entries = (await readdir(workspace.inDir, { withFileTypes: true })).filter((entry) =>
    entry.isFile(),
  )
  if (entries.length !== 1) {
    throw new Error('Room dimensions extraction requires exactly one staged image')
  }

  const inputPath = path.join(workspace.inDir, entries[0]!.name)
  const bytes = await readFile(inputPath)
  if (bytes.length === 0 || bytes.length > MAX_ROOM_IMAGE_BYTES) {
    throw new Error('Room dimensions image must be non-empty and at most 20 MiB')
  }
  const mediaType = detectImageMediaType(bytes)
  if (!mediaType) throw new Error('Room dimensions input must be a PNG, JPEG, or WebP image')
  return `data:${mediaType};base64,${bytes.toString('base64')}`
}

async function findSingleInput(workspace: SessionWorkspace): Promise<string | ProcessingFailure> {
  const entries = await readdir(workspace.inDir, { withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  const names = new Set(files.map((entry) => entry.name))
  const inputs = files.filter(
    (entry) => !(entry.name.endsWith('.txt') && names.has(entry.name.slice(0, -4))),
  )
  if (inputs.length !== 1) {
    return {
      ok: false,
      code: 'invalid_attachment_count',
      message: `Expected exactly one staged PDF; found ${inputs.length}.`,
      fileName: null,
      pageCount: null,
    }
  }
  return path.join(workspace.inDir, inputs[0]!.name)
}

function parsePdfInfo(stdout: string): { pageCount: number; encrypted: boolean } | null {
  const pages = /^Pages:\s+(\d+)\s*$/im.exec(stdout)
  if (!pages) return null
  const pageCount = Number.parseInt(pages[1]!, 10)
  if (!Number.isInteger(pageCount) || pageCount < 1) return null
  const encrypted = /^Encrypted:\s+yes\b/im.test(stdout)
  return { pageCount, encrypted }
}

function isMissingExecutable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
async function execPdf(
  runtime: PdfToolRuntime,
  executable: string,
  args: string[],
): Promise<ExecResult> {
  try {
    return await runtime.execFile(executable, args)
  } catch (error) {
    if (isMissingExecutable(error)) throw new PdfRuntimeUnavailableError()
    throw error
  }
}


async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function clearOutput(workspace: SessionWorkspace): Promise<void> {
  await rm(workspace.outDir, { recursive: true, force: true })
  await mkdir(workspace.outDir, { recursive: true })
}

async function writeProcessingError(
  workspace: SessionWorkspace,
  failure: ProcessingFailure,
): Promise<void> {
  await clearOutput(workspace)
  await writeFile(
    path.join(workspace.outDir, 'processing-error.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: 'rejected',
        code: failure.code,
        message: failure.message,
        source: { fileName: failure.fileName, pageCount: failure.pageCount },
        limits: { maxPages: MAX_PDF_PAGES, maxArtifacts: MAX_PDF_ARTIFACTS },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

async function inspectPdf(
  runtime: PdfToolRuntime,
  workspace: SessionWorkspace,
  inputPath: string,
): Promise<InspectSuccess | ProcessingFailure> {
  const fileName = path.basename(inputPath)
  if (fileName.length > 255) {
    return {
      ok: false,
      code: 'malformed_pdf',
      message: 'The staged PDF file name exceeds 255 characters.',
      fileName: null,
      pageCount: null,
    }
  }

  let infoResult: ExecResult
  try {
    infoResult = await execPdf(runtime, PDFINFO, [inputPath])
  } catch (error) {
    if (error instanceof PdfRuntimeUnavailableError) {
      return {
        ok: false,
        code: 'pdf_runtime_unavailable',
        message: 'The configured PDF processing runtime is unavailable.',
        fileName,
        pageCount: null,
      }
    }
    return {
      ok: false,
      code: 'not_pdf',
      message: 'The staged file is not a readable PDF.',
      fileName,
      pageCount: null,
    }
  }

  const info = parsePdfInfo(infoResult.stdout)
  if (!info) {
    return {
      ok: false,
      code: 'malformed_pdf',
      message: 'PDF metadata could not be parsed.',
      fileName,
      pageCount: null,
    }
  }
  if (info.encrypted) {
    return {
      ok: false,
      code: 'encrypted_pdf',
      message: 'Password-protected PDFs are not supported.',
      fileName,
      pageCount: info.pageCount,
    }
  }
  if (info.pageCount > MAX_PDF_PAGES) {
    return {
      ok: false,
      code: 'page_limit_exceeded',
      message: `PDF has ${info.pageCount} pages; maximum is ${MAX_PDF_PAGES}.`,
      fileName,
      pageCount: info.pageCount,
    }
  }

  const analysisDir = path.join(workspace.root, 'analysis')
  const allTextPath = path.join(analysisDir, 'all-pages.txt')
  const previewPrefix = path.join(analysisDir, 'preview')
  try {
    await rm(analysisDir, { recursive: true, force: true })
    await mkdir(analysisDir, { recursive: true })
    const beforeHash = await sha256File(inputPath)
    await execPdf(runtime, PDFTOTEXT, ['-layout', inputPath, allTextPath])
    await execPdf(runtime, PDFTOPPM, ['-r', '96', '-png', inputPath, previewPrefix])
    const afterHash = await sha256File(inputPath)
    if (beforeHash !== afterHash) throw new Error('PDF changed during inspection')

    const rawText = await readFile(allTextPath, 'utf8')
    const textPages = rawText.split('\f')
    if (textPages.at(-1) === '') textPages.pop()
    while (textPages.length < info.pageCount) textPages.push('')
    if (textPages.length > info.pageCount) {
      textPages[info.pageCount - 1] = textPages.slice(info.pageCount - 1).join('\f')
      textPages.length = info.pageCount
    }

    const previewEntries = await readdir(analysisDir)
    const previews = previewEntries
      .map((name) => ({ name, match: /^preview-(\d+)\.png$/.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
      .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    if (previews.length !== info.pageCount) {
      throw new Error(`rendered ${previews.length} previews for ${info.pageCount} pages`)
    }

    const pages: InspectSuccess['pages'] = []
    for (let index = 0; index < info.pageCount; index += 1) {
      const pageNumber = index + 1
      const suffix = String(pageNumber).padStart(4, '0')
      const textName = `page-${suffix}.txt`
      const previewName = `page-${suffix}.png`
      await writeFile(path.join(analysisDir, textName), textPages[index] ?? '', 'utf8')
      await rename(path.join(analysisDir, previews[index]!.name), path.join(analysisDir, previewName))
      pages.push({
        sourcePage: pageNumber,
        textPath: toAgentReadPath(path.posix.join(workspace.containerRoot, 'analysis', textName)),
        previewPath: toAgentReadPath(
          path.posix.join(workspace.containerRoot, 'analysis', previewName),
        ),
      })
    }
    await rm(allTextPath, { force: true })
    const state: InspectionState = {
      schemaVersion: 1,
      fileName,
      pageCount: info.pageCount,
      sha256: afterHash,
    }
    await writeFile(path.join(analysisDir, INSPECTION_FILE), JSON.stringify(state), 'utf8')
    return { ok: true, operation: 'inspect', fileName, pageCount: info.pageCount, pages }
  } catch (error) {
    await rm(analysisDir, { recursive: true, force: true })
    return {
      ok: false,
      code:
        error instanceof PdfRuntimeUnavailableError
          ? 'pdf_runtime_unavailable'
          : 'pdf_processing_failed',
      message:
        error instanceof PdfRuntimeUnavailableError
          ? 'The configured PDF processing runtime is unavailable.'
          : 'PDF page extraction or preview rendering failed.',
      fileName,
      pageCount: info.pageCount,
    }
  }
}

async function loadInspection(workspace: SessionWorkspace): Promise<InspectionState> {
  const raw = await readFile(path.join(workspace.root, 'analysis', INSPECTION_FILE), 'utf8')
  return inspectionStateSchema.parse(JSON.parse(raw))
}

function collectPageList(
  pages: number[],
  pageCount: number,
  label: string,
  issues: string[],
): number[] | null {
  try {
    return validateRenderPages(pages, pageCount)
  } catch (error) {
    issues.push(`${label}: ${error instanceof Error ? error.message : 'invalid page list'}`)
    return null
  }
}

function validateFinalization(
  input: FinalizeInput,
  inspection: InspectionState,
): { brief: BriefManifest; floorPlans: FloorPlansInput; planPages: number[] } {
  const { brief, floorPlans } = input
  const issues: string[] = []
  if (
    brief.source.fileName !== inspection.fileName ||
    brief.source.pageCount !== inspection.pageCount
  ) {
    issues.push('brief.source does not match the inspected PDF')
  }
  if (
    floorPlans.source.fileName !== inspection.fileName ||
    floorPlans.source.pageCount !== inspection.pageCount
  ) {
    issues.push('floorPlans.source does not match the inspected PDF')
  }

  const briefPages = collectPageList(
    brief.source.briefPages,
    inspection.pageCount,
    'briefPages',
    issues,
  )
  if (briefPages) {
    const briefPageSet = new Set(briefPages)
    for (const [label, entries] of [
      ['sections', brief.sections],
      ['requirements', brief.requirements],
      ['keyFacts', brief.keyFacts],
      ['unresolvedItems', brief.unresolvedItems],
    ] as const) {
      entries.forEach((entry, index) => {
        const sourcePages = collectPageList(
          entry.sourcePages,
          inspection.pageCount,
          `${label}[${index}].sourcePages`,
          issues,
        )
        if (!sourcePages) return
        const outside = sourcePages.filter((page) => !briefPageSet.has(page))
        if (outside.length > 0) {
          issues.push(
            `${label}[${index}] contains ${
              outside.length === 1 ? `page ${outside[0]}` : `pages ${outside.join(', ')}`
            } outside briefPages`,
          )
        }
      })
    }
  }

  const planPages = collectPageList(
    floorPlans.plans.map((plan) => plan.sourcePage),
    inspection.pageCount,
    'floorPlans.plans',
    issues,
  )
  const otherPages = collectPageList(
    floorPlans.otherPages.map((page) => page.sourcePage),
    inspection.pageCount,
    'floorPlans.otherPages',
    issues,
  )
  if (briefPages && planPages && otherPages) {
    const classified = [...briefPages, ...planPages, ...otherPages]
    const counts = new Map<number, number>()
    for (const page of classified) counts.set(page, (counts.get(page) ?? 0) + 1)
    for (const [page, count] of counts) {
      if (count > 1) issues.push(`page ${page} is classified more than once`)
    }
    const missing = Array.from(
      { length: inspection.pageCount },
      (_, index) => index + 1,
    ).filter((page) => !counts.has(page))
    if (missing.length > 0) {
      issues.push(
        `page classifications are missing ${
          missing.length === 1 ? `page ${missing[0]}` : `pages ${missing.join(', ')}`
        }`,
      )
    }
  }
  if (planPages && planPages.length + 2 > MAX_PDF_ARTIFACTS) {
    issues.push('final output exceeds the artifact limit')
  }
  if (issues.length > 0) throw new PdfManifestValidationError(issues)

  return { brief, floorPlans, planPages: planPages! }
}

async function finalizePdf(
  runtime: PdfToolRuntime,
  workspace: SessionWorkspace,
  inputPath: string,
  input: FinalizeInput,
): Promise<FinalizeSuccess | ProcessingFailure> {
  const fileName = path.basename(inputPath)
  let pageCount: number | null = null
  try {
    const inspection = await loadInspection(workspace)
    pageCount = inspection.pageCount
    if (inspection.fileName !== fileName || inspection.sha256 !== (await sha256File(inputPath))) {
      throw new Error('inspected PDF changed before finalization')
    }
    const { brief, floorPlans, planPages } = validateFinalization(input, inspection)
    await clearOutput(workspace)

    const artifacts: FinalizeSuccess['artifacts'] = []
    for (const pageNumber of planPages) {
      const suffix = String(pageNumber).padStart(4, '0')
      const artifactName = `floor-plan-page-${suffix}.png`
      const outputPrefix = path.join(workspace.outDir, `floor-plan-page-${suffix}`)
      await execPdf(runtime, PDFTOPPM, [
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-singlefile',
        '-r',
        '150',
        '-png',
        inputPath,
        outputPrefix,
      ])
      const outputPath = path.join(workspace.outDir, artifactName)
      const outputStat = await stat(outputPath)
      if (!outputStat.isFile() || outputStat.size === 0) throw new Error('empty rendered page')
      artifacts.push({
        sourcePage: pageNumber,
        path: path.posix.join(workspace.containerOutDir, artifactName),
      })
    }

    const floorPlansOutput = {
      ...floorPlans,
      plans: floorPlans.plans.map((plan) => ({
        sourcePage: plan.sourcePage,
        artifactPath: `floor-plan-page-${String(plan.sourcePage).padStart(4, '0')}.png`,
        title: plan.title,
        level: plan.level,
        primaryType: plan.primaryType,
        disciplines: plan.disciplines,
        scale: plan.scale,
        description: plan.description,
        confidence: plan.confidence,
        evidence: plan.evidence,
      })),
    }

    const briefTemp = path.join(workspace.outDir, '.brief.json.tmp')
    const plansTemp = path.join(workspace.outDir, '.floor-plans.json.tmp')
    await writeFile(briefTemp, `${JSON.stringify(brief, null, 2)}\n`, 'utf8')
    await writeFile(plansTemp, `${JSON.stringify(floorPlansOutput, null, 2)}\n`, 'utf8')
    await rename(briefTemp, path.join(workspace.outDir, 'brief.json'))
    await rename(plansTemp, path.join(workspace.outDir, 'floor-plans.json'))

    return {
      ok: true,
      operation: 'finalize',
      artifacts,
      manifests: [
        path.posix.join(workspace.containerOutDir, 'brief.json'),
        path.posix.join(workspace.containerOutDir, 'floor-plans.json'),
      ],
    }
  } catch (error) {
    const failure: ProcessingFailure = {
      ok: false,
      code:
        error instanceof PdfRuntimeUnavailableError
          ? 'pdf_runtime_unavailable'
          : 'pdf_processing_failed',
      message:
        error instanceof PdfRuntimeUnavailableError
          ? 'The configured PDF processing runtime is unavailable.'
          : error instanceof PdfManifestValidationError
            ? error.message
            : 'Validated PDF artifacts could not be finalized.',
      fileName,
      pageCount,
    }
    await writeProcessingError(workspace, failure)
    return failure
  }
}

export function createProcessPdfTool(runtime: PdfToolRuntime = defaultRuntime()): AiToolDefinition {
  return defineAiTool<unknown, ProcessPdfResult>({
    name: PDF_TOOL_ID,
    displayName: 'Property documents — process PDF',
    description:
      'Inspect the one PDF staged for the active property-document run, then atomically validate and finalize schema-bound manifests plus selected plan PNGs. Paths, session, scope, commands, DPI, output names, and artifact bytes are server-owned.',
    tags: ['read', 'property-documents', 'pdf'],
    isMutation: false,
    maxCallsPerTurn: 3,
    requiredFeatures: ['agent_orchestrator.agents.run'],
    inputSchema: processPdfInputSchema,
    async handler(rawInput, context) {
      const input: ProcessPdfInput = processPdfInputSchema.parse(rawInput)
      const workspace = await requireActiveWorkspace(context, runtime, input.operation)
      const inputPath = await findSingleInput(workspace)
      if (typeof inputPath !== 'string') {
        await writeProcessingError(workspace, inputPath)
        return inputPath
      }
      if (input.operation === 'inspect') {
        const result = await inspectPdf(runtime, workspace, inputPath)
        if (!result.ok) await writeProcessingError(workspace, result)
        return result
      }
      return finalizePdf(runtime, workspace, inputPath, {
        operation: 'finalize',
        brief: input.brief!,
        floorPlans: input.floorPlans!,
      })
    },
  })
}

export function createRoomDimensionsVisionTool(
  runtime: RoomDimensionsVisionRuntime = defaultRoomDimensionsVisionRuntime(),
): AiToolDefinition {
  return defineAiTool<unknown, RoomDimensionsVisionResult>({
    name: ROOM_DIMENSIONS_TOOL_ID,
    displayName: 'Property documents — extract room dimensions',
    description:
      'Analyze the single floor-plan image staged for the active room-dimensions run. Returns visible dimensions grouped by room; session, scope, image bytes, and model invocation are server-owned.',
    tags: ['read', 'property-documents', 'image', 'vision'],
    isMutation: false,
    maxCallsPerTurn: 1,
    requiredFeatures: ['agent_orchestrator.agents.run'],
    inputSchema: roomDimensionsVisionInputSchema,
    async handler(rawInput, context) {
      roomDimensionsVisionInputSchema.parse(rawInput)
      const workspace = await requireRoomDimensionsWorkspace(context, runtime)
      const dataUrl = await readSingleRoomImage(workspace)
      return roomDimensionsVisionResultSchema.parse(
        await runtime.analyzeImage({ dataUrl, context }),
      )
    },
  })
}

export const aiTools: AiToolDefinition[] = [
  createProcessPdfTool(),
  createRoomDimensionsVisionTool(),
]
export default aiTools

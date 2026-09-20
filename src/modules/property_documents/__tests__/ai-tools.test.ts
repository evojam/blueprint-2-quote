import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { z } from 'zod'
import { describe, expect, it, jest } from '@jest/globals'
import type { McpToolContext } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { getAgentEntry } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'

jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/lib/agent-registry', () => ({
  getAgent: jest.fn(() => undefined),
}))
import { ROOM_DIMENSIONS_AGENT_ID } from '../ai-agents'
import {
  PDF_AGENT_ID,
  PDF_TOOL_ID,
  ROOM_DIMENSIONS_TOOL_ID,
  ROOM_MEASUREMENTS_AGENT_ID,
  ROOM_MEASUREMENTS_TOOL_ID,
  ROOM_MEASUREMENTS_VISION_SERVICE,
  aiTools,
  createRoomDimensionsVisionTool,
  createRoomMeasurementsVisionTool,
  createProcessPdfTool,
  processPdfInputSchema,
  resolveSessionWorkspace,
  type PdfToolRuntime,
  type RoomDimensionsVisionRuntime,
  type RoomDimensionsVisionResult,
} from '../ai-tools'
import type { RoomMeasurementSet } from '../room-measurements-contract'
import type { RoomMeasurementsVisionRuntime } from '../room-measurements-vision'

const SESSION_TOKEN = `sess_${'a'.repeat(32)}`

async function makeWorkspace(fileName = 'input.pdf'): Promise<{ root: string; input: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'property-pdf-tool-'))
  const runRoot = path.join(root, SESSION_TOKEN)
  await mkdir(path.join(runRoot, 'in'), { recursive: true })
  await mkdir(path.join(runRoot, 'out'), { recursive: true })
  const input = path.join(runRoot, 'in', fileName)
  await writeFile(input, '%PDF-1.4\nfixture')
  return { root, input }
}

type ContextOptions = {
  sessionId?: string | null
  tenantId?: string | null
  organizationId?: string | null
  userId?: string | null
  runId?: string | null
}

function optionOrDefault<T>(
  options: ContextOptions,
  key: keyof ContextOptions,
  fallback: T,
): T | null {
  return key in options ? (options[key] as T | null) : fallback
}

function makeContext(
  agentId: string | null = PDF_AGENT_ID,
  options: ContextOptions = {},
): McpToolContext {
  const store = {
    resolveActiveAgentId: jest.fn(async () => agentId),
    resolveActiveRunId: jest.fn(async () => optionOrDefault(options, 'runId', 'run-1')),
  }
  return {
    tenantId: optionOrDefault(options, 'tenantId', 'tenant-1'),
    organizationId: optionOrDefault(options, 'organizationId', 'organization-1'),
    userId: optionOrDefault(options, 'userId', 'user-1'),
    userFeatures: ['agent_orchestrator.agents.run'],
    isSuperAdmin: false,
    sessionId: optionOrDefault(options, 'sessionId', SESSION_TOKEN),
    container: { resolve: jest.fn(() => store) } as unknown as McpToolContext['container'],
  } as McpToolContext
}

type TestImageFormat = 'png' | 'jpeg' | 'webp'

async function writeTestImage(
  filePath: string,
  format: TestImageFormat,
  width = 13,
  height = 7,
): Promise<void> {
  const canvas = createCanvas(width, height)
  const drawing = canvas.getContext('2d')
  drawing.fillStyle = '#fff'
  drawing.fillRect(0, 0, width, height)
  await writeFile(
    filePath,
    format === 'png' ? canvas.toBuffer('image/png') : await canvas.encode(format),
  )
}

function makeRoomMeasurementResult(
  imageWidthPx = 13,
  imageHeightPx = 7,
): RoomMeasurementSet {
  return {
    schemaVersion: '1',
    analysisStatus: 'not_floor_plan',
    drawing: {
      imageWidthPx,
      imageHeightPx,
      declaredUnit: null,
      declaredScale: null,
      calibrations: [],
      globalCeilingHeight: null,
      confidence: 0.9,
      warnings: [],
    },
    rooms: [],
    warnings: [],
  }
}

const RAW_TEXT = 'Brief page\fElectrical plan\fPlumbing plan\f'
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function makeRuntime(
  root: string,
  pageCount = 3,
  options: { rawText?: string; failRenderPage?: number } = {},
): PdfToolRuntime & { calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = []
  return {
    workspaceRoot: root,
    containerWorkspaceRoot: '/home/opencode/work',
    calls,
    async execFile(file, args) {
      calls.push({ file, args })
      if (file === '/usr/bin/pdfinfo') {
        return { stdout: `Pages:          ${pageCount}\nEncrypted:      no\n`, stderr: '' }
      }
      if (file === '/usr/bin/pdftotext') {
        await writeFile(args.at(-1)!, options.rawText ?? RAW_TEXT)
        return { stdout: '', stderr: '' }
      }
      if (file === '/usr/bin/pdftoppm') {
        const sourcePage = Number(args[args.indexOf('-f') + 1])
        if (sourcePage === options.failRenderPage) throw new Error('render failed')
        await writeFile(`${args.at(-1)!}.png`, PNG_BYTES)
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected executable: ${file}`)
    },
  }
}

function makeFinalizeInput() {
  return { operation: 'finalize' as const }
}

describe('property_documents.process_pdf', () => {
  it('registers the OpenCode agent with file staging, capture, and no bash', () => {
    expect(getAgentEntry(PDF_AGENT_ID)?.files).toEqual({
      enabled: true,
      inputs: true,
      outputs: true,
      bash: false,
    })
  })

  it('generates a tool-only PDF intake profile with the two-control-file outcome', async () => {
    const generated = await readFile(
      path.resolve('docker/opencode/agents/property_documents_pdf_intake.md'),
      'utf8',
    )

    expect(generated).toContain('  "*": false')
    expect(generated).not.toContain('  read: true')
    expect(generated).not.toContain('  write: true')
    expect(generated).not.toContain('  edit: true')
    expect(generated).not.toContain('  bash: true')
    expect(generated.split('\n')).not.toContain('  "*": deny')
    expect(generated).not.toContain('/analysis/**')
    expect(generated).not.toContain('/in/**')
    expect(generated).toContain('open-mercato_agent_orchestrator_load_skill')
    expect(generated).toContain('open-mercato_agent_orchestrator_run_skill_script')
    const outcomeStart = generated.indexOf('Pass a complete outcome object.')
    const outcomeContract = generated.slice(
      outcomeStart,
      generated.indexOf('The PDF processing tool is the only output writer.', outcomeStart),
    )
    expect(outcomeContract).toContain('"kind": "artifact"')
    expect(outcomeContract).toContain('"fileName": "brief.json"')
    expect(outcomeContract).toContain('"fileName": "pdf-pages.json"')
    expect(outcomeContract).not.toContain('"path":')
    expect(outcomeContract).not.toContain('"fileName": "report.pdf"')
    expect(generated).not.toContain('floor-plans.json')
    expect(generated).not.toContain('Classify the page')
  })

  it('publishes a strict object-shaped input schema accepted by the HTTP MCP adapter', () => {
    const schema = z.toJSONSchema(processPdfInputSchema, {
      unrepresentable: 'any',
    }) as Record<string, unknown>

    expect(schema.type).toBe('object')
    expect(schema.properties).toEqual(
      expect.objectContaining({
        operation: expect.any(Object),
      }),
    )
    expect(schema).not.toHaveProperty('oneOf')
    expect(processPdfInputSchema.safeParse({ operation: 'finalize' }).success).toBe(true)
    expect(
      processPdfInputSchema.safeParse({ operation: 'finalize', brief: {} }).success,
    ).toBe(false)
  })

  it('rejects non-canonical session tokens instead of mapping them to a directory', async () => {
    const { root } = await makeWorkspace()

    await expect(resolveSessionWorkspace(root, 'sess_bad/token')).rejects.toThrow('invalid session token')
  })

  it('rejects a symlinked run directory that escapes the workspace root', async () => {
    const { root } = await makeWorkspace()
    const outside = await mkdtemp(path.join(tmpdir(), 'property-pdf-outside-'))
    const token = `sess_${'b'.repeat(32)}`
    await mkdir(path.join(outside, 'in'), { recursive: true })
    await mkdir(path.join(outside, 'out'), { recursive: true })
    await symlink(outside, path.join(root, token))

    await expect(resolveSessionWorkspace(root, token)).rejects.toThrow('outside configured root')
  })


  it('writes a canonical rejection artifact for a 49-page PDF before extraction', async () => {
    const { root } = await makeWorkspace()
    const runtime = makeRuntime(root, 49)
    const tool = createProcessPdfTool(runtime)

    const result = await tool.handler({ operation: 'inspect' }, makeContext())

    expect(result).toEqual({
      ok: false,
      code: 'page_limit_exceeded',
      message: 'PDF has 49 pages; maximum is 48.',
      fileName: 'input.pdf',
      pageCount: 49,
    })
    expect(runtime.calls.map((call) => call.file)).toEqual(['/usr/bin/pdfinfo'])
    expect(
      JSON.parse(
        await readFile(path.join(root, SESSION_TOKEN, 'out', 'processing-error.json'), 'utf8'),
      ),
    ).toEqual({
      schemaVersion: 1,
      status: 'rejected',
      code: 'page_limit_exceeded',
      message: 'PDF has 49 pages; maximum is 48.',
      source: { fileName: 'input.pdf', pageCount: 49 },
      limits: { maxPages: 48, maxArtifacts: 50 },
    })
  })

  it('inspects without exposing document text or rendering previews', async () => {
    const { root } = await makeWorkspace()
    const runtime = makeRuntime(root)
    const tool = createProcessPdfTool(runtime)

    const result = await tool.handler({ operation: 'inspect' }, makeContext())

    expect(result).toEqual({
      ok: true,
      operation: 'inspect',
      fileName: 'input.pdf',
      pageCount: 3,
      pages: [{ sourcePage: 1 }, { sourcePage: 2 }, { sourcePage: 3 }],
    })
    expect(runtime.calls.map((call) => call.file)).toEqual([
      '/usr/bin/pdfinfo',
      '/usr/bin/pdftotext',
    ])
    expect(runtime.calls.every((call) => !call.args.includes('sh') && !call.args.includes('-c'))).toBe(true)
  })

  it('ignores the OCR text sidecar staged beside the single PDF attachment', async () => {
    const { root } = await makeWorkspace()
    await writeFile(
      path.join(root, SESSION_TOKEN, 'in', 'input.pdf.txt'),
      'OCR text extracted by the attachment file plane',
    )
    const tool = createProcessPdfTool(makeRuntime(root))

    const result = await tool.handler({ operation: 'inspect' }, makeContext())

    expect(result).toMatchObject({ ok: true, fileName: 'input.pdf', pageCount: 3 })
  })

  it('rejects multiple staged PDFs before the intake agent can inspect them', async () => {
    const { root } = await makeWorkspace()
    await writeFile(path.join(root, SESSION_TOKEN, 'in', 'second.pdf'), '%PDF-1.4\nsecond')
    const runtime = makeRuntime(root)
    const tool = createProcessPdfTool(runtime)

    const result = await tool.handler({ operation: 'inspect' }, makeContext())

    expect(result).toEqual({
      ok: false,
      code: 'invalid_attachment_count',
      message: 'Expected exactly one staged PDF; found 2.',
      fileName: null,
      pageCount: null,
    })
    expect(runtime.calls).toEqual([])
  })

  it('rejects the retired PDF text reader identity', async () => {
    const { root } = await makeWorkspace()
    const runtime = makeRuntime(root)
    const tool = createProcessPdfTool(runtime)

    await expect(
      tool.handler(
        { operation: 'inspect' },
        makeContext('property_documents.pdf_text_reader'),
      ),
    ).rejects.toThrow('[internal] PDF tool active agent mismatch')
    expect(runtime.calls).toEqual([])
  })

  it('keeps a staged PDF named analysis separate from server inspection files', async () => {
    const { root, input } = await makeWorkspace('analysis')
    const tool = createProcessPdfTool(makeRuntime(root))

    const result = await tool.handler({ operation: 'inspect' }, makeContext())

    expect(result).toMatchObject({ ok: true, fileName: 'analysis', pageCount: 3 })
    expect(await readFile(input, 'utf8')).toBe('%PDF-1.4\nfixture')
  })

  it('writes exact raw text, a strict inventory, and one PNG for every page', async () => {
    const { root } = await makeWorkspace()
    const runtime = makeRuntime(root)
    const tool = createProcessPdfTool(runtime)

    await tool.handler({ operation: 'inspect' }, makeContext())
    const result = await tool.handler(makeFinalizeInput(), makeContext())

    expect(result).toEqual({
      ok: true,
      operation: 'finalize',
      pageCount: 3,
      artifacts: [
        { sourcePage: 1, path: `/home/opencode/work/${SESSION_TOKEN}/out/pdf-page-0001.png` },
        { sourcePage: 2, path: `/home/opencode/work/${SESSION_TOKEN}/out/pdf-page-0002.png` },
        { sourcePage: 3, path: `/home/opencode/work/${SESSION_TOKEN}/out/pdf-page-0003.png` },
      ],
      manifests: [
        `/home/opencode/work/${SESSION_TOKEN}/out/brief.json`,
        `/home/opencode/work/${SESSION_TOKEN}/out/pdf-pages.json`,
      ],
    })
    expect(runtime.calls.filter((call) => call.file === '/usr/bin/pdftoppm')).toHaveLength(3)
    expect(
      runtime.calls
        .filter((call) => call.file === '/usr/bin/pdftoppm')
        .every((call) => call.args.includes('150')),
    ).toBe(true)
    const outputNames = (await readdir(path.join(root, SESSION_TOKEN, 'out'))).sort()
    expect(outputNames).toEqual([
      'brief.json',
      'pdf-page-0001.png',
      'pdf-page-0002.png',
      'pdf-page-0003.png',
      'pdf-pages.json',
    ])
    expect(
      JSON.parse(await readFile(path.join(root, SESSION_TOKEN, 'out', 'brief.json'), 'utf8')),
    ).toEqual({ brief: RAW_TEXT })
    expect(
      JSON.parse(await readFile(path.join(root, SESSION_TOKEN, 'out', 'pdf-pages.json'), 'utf8')),
    ).toEqual({
      pageCount: 3,
      files: ['pdf-page-0001.png', 'pdf-page-0002.png', 'pdf-page-0003.png'],
    })
  })

  it('preserves an empty pdftotext result as an empty raw brief', async () => {
    const { root } = await makeWorkspace()
    const tool = createProcessPdfTool(makeRuntime(root, 3, { rawText: '' }))

    await tool.handler({ operation: 'inspect' }, makeContext())
    await tool.handler(makeFinalizeInput(), makeContext())

    expect(
      JSON.parse(await readFile(path.join(root, SESSION_TOKEN, 'out', 'brief.json'), 'utf8')),
    ).toEqual({ brief: '' })
  })

  it('rejects finalization before inspection and leaves only an error artifact', async () => {
    const { root } = await makeWorkspace()
    const tool = createProcessPdfTool(makeRuntime(root))

    const result = await tool.handler(makeFinalizeInput(), makeContext())

    expect(result).toMatchObject({ ok: false, code: 'pdf_processing_failed' })
    expect(await readdir(path.join(root, SESSION_TOKEN, 'out'))).toEqual([
      'processing-error.json',
    ])
  })

  it('rejects finalization when the inspected PDF bytes changed', async () => {
    const { root, input } = await makeWorkspace()
    const tool = createProcessPdfTool(makeRuntime(root))

    await tool.handler({ operation: 'inspect' }, makeContext())
    await writeFile(input, '%PDF-1.4\nchanged')
    const result = await tool.handler(makeFinalizeInput(), makeContext())

    expect(result).toMatchObject({ ok: false, code: 'pdf_processing_failed' })
    expect(await readdir(path.join(root, SESSION_TOKEN, 'out'))).toEqual([
      'processing-error.json',
    ])
  })

  it('removes partial page renders when any page fails', async () => {
    const { root } = await makeWorkspace()
    const runtime = makeRuntime(root, 3, { failRenderPage: 2 })
    const tool = createProcessPdfTool(runtime)

    await tool.handler({ operation: 'inspect' }, makeContext())
    const result = await tool.handler(makeFinalizeInput(), makeContext())

    expect(result).toMatchObject({ ok: false, code: 'pdf_processing_failed' })
    expect(await readdir(path.join(root, SESSION_TOKEN, 'out'))).toEqual([
      'processing-error.json',
    ])
  })

  it('keeps a 48-page success within the configured 50 captured files', async () => {
    const { root } = await makeWorkspace()
    const tool = createProcessPdfTool(makeRuntime(root, 48, { rawText: '' }))

    await tool.handler({ operation: 'inspect' }, makeContext())
    const result = await tool.handler(makeFinalizeInput(), makeContext())

    expect(result).toMatchObject({ ok: true, pageCount: 48 })
    expect(await readdir(path.join(root, SESSION_TOKEN, 'out'))).toHaveLength(50)
  })

  it('fails closed when the active session belongs to a different agent', async () => {
    const { root } = await makeWorkspace()
    const tool = createProcessPdfTool(makeRuntime(root))

    await expect(tool.handler({ operation: 'inspect' }, makeContext('other.agent'))).rejects.toThrow(
      'active agent mismatch',
    )
  })
})

describe('property_documents.extract_room_dimensions', () => {
  it('analyzes exactly one staged image for the active room-dimensions agent', async () => {
    const { root, input } = await makeWorkspace('floor-plan.png')
    await writeTestImage(input, 'png')
    const resultFixture: RoomDimensionsVisionResult = {
      rooms: [
        {
          id: 'room-001',
          name: null,
          location: 'upper-left room',
          dimensions: [
            {
              value: 275,
              unit: 'cm',
              orientation: 'height',
              kind: 'ceiling_height',
              sourceText: 'H = 275 cm',
              confidence: 0.99,
            },
          ],
          confidence: 0.95,
          warnings: [],
        },
      ],
    }
    const analyzeImage = jest.fn(
      async (_input: Parameters<RoomDimensionsVisionRuntime['analyzeImage']>[0]) => resultFixture,
    )
    const runtime: RoomDimensionsVisionRuntime = {
      workspaceRoot: root,
      containerWorkspaceRoot: '/home/opencode/work',
      analyzeImage,
    }
    const tool = createRoomDimensionsVisionTool(runtime)

    await expect(tool.handler({}, makeContext(ROOM_DIMENSIONS_AGENT_ID))).resolves.toEqual(
      resultFixture,
    )
    expect(tool.name).toBe(ROOM_DIMENSIONS_TOOL_ID)
    expect(analyzeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
      }),
    )
  })

  it('fails closed for a different active agent or multiple staged images', async () => {
    const { root } = await makeWorkspace('floor-plan.png')
    const runtime: RoomDimensionsVisionRuntime = {
      workspaceRoot: root,
      containerWorkspaceRoot: '/home/opencode/work',
      analyzeImage: jest.fn(async () => ({ rooms: [] })),
    }
    const tool = createRoomDimensionsVisionTool(runtime)

    await expect(tool.handler({}, makeContext('other.agent'))).rejects.toThrow(
      'active agent mismatch',
    )
    await writeFile(
      path.join(root, SESSION_TOKEN, 'in', 'second.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    await expect(tool.handler({}, makeContext(ROOM_DIMENSIONS_AGENT_ID))).rejects.toThrow(
      'exactly one staged image',
    )
  })
})

describe('property_documents.extract_room_measurements', () => {
  it('publishes the stable v2 registration with a one-call budget after the v1 tools', () => {
    const tool = createRoomMeasurementsVisionTool({
      workspaceRoot: '/tmp/unused',
      containerWorkspaceRoot: '/home/opencode/work',
      analyzeImage: jest.fn(async () => makeRoomMeasurementResult()),
    })

    expect(ROOM_MEASUREMENTS_AGENT_ID).toBe('property_documents.room_measurements')
    expect(ROOM_MEASUREMENTS_TOOL_ID).toBe('property_documents.extract_room_measurements')
    expect(ROOM_MEASUREMENTS_VISION_SERVICE).toBe('propertyRoomMeasurementsVisionService')
    expect(tool.name).toBe(ROOM_MEASUREMENTS_TOOL_ID)
    expect(tool.maxCallsPerTurn).toBe(1)
    expect(aiTools.map((registeredTool) => registeredTool.name)).toEqual([
      PDF_TOOL_ID,
      ROOM_DIMENSIONS_TOOL_ID,
      ROOM_MEASUREMENTS_TOOL_ID,
    ])
  })

  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ] as const)('forwards decoded %s bytes and pixel dimensions to vision', async (format, mediaType) => {
    const { root, input } = await makeWorkspace(`floor-plan.${format}`)
    await writeTestImage(input, format)
    const resultFixture = makeRoomMeasurementResult()
    const analyzeImage = jest.fn<RoomMeasurementsVisionRuntime['analyzeImage']>(
      async () => resultFixture,
    )
    const runtime: RoomMeasurementsVisionRuntime = {
      workspaceRoot: root,
      containerWorkspaceRoot: '/home/opencode/work',
      analyzeImage,
    }
    const tool = createRoomMeasurementsVisionTool(runtime)
    const context = makeContext(ROOM_MEASUREMENTS_AGENT_ID)

    await expect(tool.handler({}, context)).resolves.toEqual(resultFixture)
    expect(analyzeImage).toHaveBeenCalledTimes(1)
    expect(analyzeImage).toHaveBeenCalledWith({
      dataUrl: expect.stringMatching(new RegExp(`^data:${mediaType};base64,`)),
      imageWidthPx: 13,
      imageHeightPx: 7,
      context,
    })
  })

  it('rejects zero or two staged files before vision analysis', async () => {
    const emptyWorkspace = await makeWorkspace('floor-plan.png')
    await rm(emptyWorkspace.input)
    const emptyAnalyzeImage = jest.fn<RoomMeasurementsVisionRuntime['analyzeImage']>(
      async () => makeRoomMeasurementResult(),
    )
    const emptyTool = createRoomMeasurementsVisionTool({
      workspaceRoot: emptyWorkspace.root,
      containerWorkspaceRoot: '/home/opencode/work',
      analyzeImage: emptyAnalyzeImage,
    })

    await expect(
      emptyTool.handler({}, makeContext(ROOM_MEASUREMENTS_AGENT_ID)),
    ).rejects.toThrow('exactly one staged image')
    expect(emptyAnalyzeImage).not.toHaveBeenCalled()

    const twoFileWorkspace = await makeWorkspace('first.png')
    await writeTestImage(twoFileWorkspace.input, 'png')
    await writeTestImage(
      path.join(twoFileWorkspace.root, SESSION_TOKEN, 'in', 'second.png'),
      'png',
    )
    const twoFileAnalyzeImage = jest.fn<RoomMeasurementsVisionRuntime['analyzeImage']>(
      async () => makeRoomMeasurementResult(),
    )
    const twoFileTool = createRoomMeasurementsVisionTool({
      workspaceRoot: twoFileWorkspace.root,
      containerWorkspaceRoot: '/home/opencode/work',
      analyzeImage: twoFileAnalyzeImage,
    })

    await expect(
      twoFileTool.handler({}, makeContext(ROOM_MEASUREMENTS_AGENT_ID)),
    ).rejects.toThrow('exactly one staged image')
    expect(twoFileAnalyzeImage).not.toHaveBeenCalled()
  })

  it.each([
    ['empty', () => Buffer.alloc(0), 'non-empty and at most 20 MiB'],
    ['oversize', () => Buffer.alloc(20 * 1024 * 1024 + 1), 'non-empty and at most 20 MiB'],
    ['unsupported', () => Buffer.from('not an image'), 'PNG, JPEG, or WebP'],
    [
      'corrupt',
      () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'decodable PNG, JPEG, or WebP',
    ],
  ])('rejects %s image bytes before vision analysis', async (_label, bytes, message) => {
    const { root, input } = await makeWorkspace('floor-plan.png')
    await writeFile(input, bytes())
    const analyzeImage = jest.fn<RoomMeasurementsVisionRuntime['analyzeImage']>(
      async () => makeRoomMeasurementResult(),
    )
    const tool = createRoomMeasurementsVisionTool({
      workspaceRoot: root,
      containerWorkspaceRoot: '/home/opencode/work',
      analyzeImage,
    })

    await expect(tool.handler({}, makeContext(ROOM_MEASUREMENTS_AGENT_ID))).rejects.toThrow(
      message,
    )
    expect(analyzeImage).not.toHaveBeenCalled()
  })

  it.each([
    ['session', ROOM_MEASUREMENTS_AGENT_ID, { sessionId: null }, 'active canonical run session'],
    [
      'tenant scope',
      ROOM_MEASUREMENTS_AGENT_ID,
      { tenantId: null },
      'tenant, organization, and user scope',
    ],
    [
      'organization scope',
      ROOM_MEASUREMENTS_AGENT_ID,
      { organizationId: null },
      'tenant, organization, and user scope',
    ],
    [
      'user scope',
      ROOM_MEASUREMENTS_AGENT_ID,
      { userId: null },
      'tenant, organization, and user scope',
    ],
    ['run', ROOM_MEASUREMENTS_AGENT_ID, { runId: null }, 'no active run'],
    ['matching agent', 'other.agent', {}, 'active agent mismatch'],
  ] satisfies Array<[string, string, ContextOptions, string]>)(
    'requires an active trusted %s',
    async (_label, agentId, options, message) => {
      const { root, input } = await makeWorkspace('floor-plan.png')
      await writeTestImage(input, 'png')
      const analyzeImage = jest.fn<RoomMeasurementsVisionRuntime['analyzeImage']>(
        async () => makeRoomMeasurementResult(),
      )
      const tool = createRoomMeasurementsVisionTool({
        workspaceRoot: root,
        containerWorkspaceRoot: '/home/opencode/work',
        analyzeImage,
      })

      await expect(tool.handler({}, makeContext(agentId, options))).rejects.toThrow(message)
      expect(analyzeImage).not.toHaveBeenCalled()
    },
  )

  it('keeps v1 and v2 active-run authorization mutually exclusive', async () => {
    const { root, input } = await makeWorkspace('floor-plan.png')
    await writeTestImage(input, 'png')
    const v1AnalyzeImage = jest.fn<RoomDimensionsVisionRuntime['analyzeImage']>(
      async () => ({ rooms: [] }),
    )
    const v2AnalyzeImage = jest.fn<RoomMeasurementsVisionRuntime['analyzeImage']>(
      async () => makeRoomMeasurementResult(),
    )
    const v1Tool = createRoomDimensionsVisionTool({
      workspaceRoot: root,
      containerWorkspaceRoot: '/home/opencode/work',
      analyzeImage: v1AnalyzeImage,
    })
    const v2Tool = createRoomMeasurementsVisionTool({
      workspaceRoot: root,
      containerWorkspaceRoot: '/home/opencode/work',
      analyzeImage: v2AnalyzeImage,
    })

    await expect(v1Tool.handler({}, makeContext(ROOM_MEASUREMENTS_AGENT_ID))).rejects.toThrow(
      'active agent mismatch',
    )
    await expect(v2Tool.handler({}, makeContext(ROOM_DIMENSIONS_AGENT_ID))).rejects.toThrow(
      'active agent mismatch',
    )
    expect(v1AnalyzeImage).not.toHaveBeenCalled()
    expect(v2AnalyzeImage).not.toHaveBeenCalled()
  })

  it('rejects extra input fields and invalid service output', async () => {
    const { root, input } = await makeWorkspace('floor-plan.png')
    await writeTestImage(input, 'png')
    const invalidResult = { ...makeRoomMeasurementResult(), modelVerdict: true }
    const analyzeImage = jest.fn<RoomMeasurementsVisionRuntime['analyzeImage']>(
      async () => invalidResult as RoomMeasurementSet,
    )
    const tool = createRoomMeasurementsVisionTool({
      workspaceRoot: root,
      containerWorkspaceRoot: '/home/opencode/work',
      analyzeImage,
    })
    const context = makeContext(ROOM_MEASUREMENTS_AGENT_ID)

    await expect(tool.handler({ unexpected: true }, context)).rejects.toBeInstanceOf(z.ZodError)
    expect(analyzeImage).not.toHaveBeenCalled()
    await expect(tool.handler({}, context)).rejects.toBeInstanceOf(z.ZodError)
    expect(analyzeImage).toHaveBeenCalledTimes(1)
  })
})

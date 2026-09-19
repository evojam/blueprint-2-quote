import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, jest } from '@jest/globals'
import { z } from 'zod'
import type { McpToolContext } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { getAgentEntry } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'

jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/lib/agent-registry', () => ({
  getAgent: jest.fn(() => undefined),
}))
import { ROOM_DIMENSIONS_AGENT_ID } from '../ai-agents'
import {
  PDF_AGENT_ID,
  ROOM_DIMENSIONS_TOOL_ID,
  createRoomDimensionsVisionTool,
  createProcessPdfTool,
  processPdfInputSchema,
  resolveSessionWorkspace,
  type PdfToolRuntime,
  type RoomDimensionsVisionRuntime,
  type RoomDimensionsVisionResult,
} from '../ai-tools'

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

function makeContext(agentId = PDF_AGENT_ID): McpToolContext {
  const store = {
    resolveActiveAgentId: jest.fn(async () => agentId),
    resolveActiveRunId: jest.fn(async () => 'run-1'),
  }
  return {
    tenantId: 'tenant-1',
    organizationId: 'organization-1',
    userId: 'user-1',
    userFeatures: ['agent_orchestrator.agents.run'],
    isSuperAdmin: false,
    sessionId: SESSION_TOKEN,
    container: { resolve: jest.fn(() => store) } as unknown as McpToolContext['container'],
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

    expect(generated).not.toContain('  read: true')
    expect(generated).toContain('  read: deny')
    expect(generated).toContain('  write: deny')
    expect(generated).toContain('  edit: deny')
    expect(generated).toContain('  bash: deny')
    expect(generated).toContain('  "*": false')
    expect(generated.split('\n')).not.toContain('  "*": deny')
    expect(generated).not.toContain('/analysis/**')
    expect(generated).not.toContain('/in/**')
    expect(generated).not.toContain('  write: true')
    expect(generated).not.toContain('  edit: true')
    expect(generated).not.toContain('open-mercato_agent_orchestrator_load_skill')
    expect(generated).not.toContain('open-mercato_agent_orchestrator_run_skill_script')
    const outcomeContract = generated.slice(
      generated.indexOf('## Outcome contract'),
      generated.indexOf('The PDF processing tool is the only output writer.'),
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
    await writeFile(input, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
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

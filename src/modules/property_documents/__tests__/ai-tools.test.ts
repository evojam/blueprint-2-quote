import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, jest } from '@jest/globals'
import { z } from 'zod'
import type { McpToolContext } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { getAgentEntry } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'
import { ROOM_DIMENSIONS_AGENT_ID } from '../ai-agents'
import {
  PDF_AGENT_ID,
  PDF_TEXT_READER_AGENT_ID,
  ROOM_DIMENSIONS_TOOL_ID,
  createRoomDimensionsVisionTool,
  createProcessPdfTool,
  processPdfInputSchema,
  resolveSessionWorkspace,
  validateRenderPages,
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

function makeRuntime(root: string, pageCount = 3): PdfToolRuntime & { calls: Array<{ file: string; args: string[] }> } {
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
        await writeFile(args.at(-1)!, 'Brief page\fElectrical plan\fPlumbing plan\f')
        return { stdout: '', stderr: '' }
      }
      if (file === '/usr/bin/pdftoppm') {
        const outputPrefix = args.at(-1)!
        const selectedPageIndex = args.indexOf('-f')
        if (selectedPageIndex >= 0) {
          await writeFile(`${outputPrefix}.png`, 'rendered-page')
        } else {
          await writeFile(`${outputPrefix}-1.png`, 'preview-1')
          await writeFile(`${outputPrefix}-2.png`, 'preview-2')
          await writeFile(`${outputPrefix}-3.png`, 'preview-3')
        }
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected executable: ${file}`)
    },
  }
}
function makeFinalizeInput() {
  return {
    operation: 'finalize',
    brief: {
      schemaVersion: 1,
      source: { fileName: 'input.pdf', pageCount: 3, briefPages: [1] },
      language: 'en',
      title: 'Sample project',
      summary: 'A concise project brief.',
      sections: [{ heading: 'Scope', text: 'Prepare the plans.', sourcePages: [1] }],

      requirements: [],
      keyFacts: [],
      unresolvedItems: [],
      warnings: [],
      confidence: 0.9,
    },
    floorPlans: {
      schemaVersion: 1,
      source: { fileName: 'input.pdf', pageCount: 3 },
      plans: [
        {
          sourcePage: 2,
          title: 'Electrical plan',
          level: null,
          primaryType: 'electrical',
          disciplines: ['electrical'],
          scale: null,
          description: 'Electrical plan view.',
          confidence: 0.95,
          evidence: ['Plan-view symbols and circuits'],
        },
        {
          sourcePage: 3,
          title: 'Plumbing plan',
          level: null,
          primaryType: 'plumbing',
          disciplines: ['plumbing'],
          scale: null,
          description: 'Plumbing plan view.',
          confidence: 0.95,
          evidence: ['Plan-view piping routes'],
        },
      ],
      otherPages: [],
      warnings: [],
    },
  }
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

  it('generates a read-only workspace policy with no shell or file mutation tools', async () => {
    const generated = await readFile(
      path.resolve('docker/opencode/agents/property_documents_pdf_intake.md'),
      'utf8',
    )

    expect(generated).toContain('  read: true')
    expect(generated).toContain('  write: deny')
    expect(generated).toContain('  edit: deny')
    expect(generated).toContain('  bash: deny')
    expect(generated).toContain('  "*": false')
    expect(generated.split('\n')).not.toContain('  "*": deny')
    expect(generated).not.toContain('  write: true')
    expect(generated).not.toContain('  edit: true')
    expect(generated.indexOf('    "*": deny')).toBeLessThan(
      generated.indexOf('    "work/*/analysis/**": allow'),
    )
    expect(generated).toContain('    "/home/opencode/work/*/analysis/**": allow')
    expect(generated).not.toContain('open-mercato_agent_orchestrator_load_skill')
    expect(generated).not.toContain('open-mercato_agent_orchestrator_run_skill_script')
    const outcomeContract = generated.slice(
      generated.indexOf('## Outcome contract'),
      generated.indexOf('The PDF processing tool is the only output writer.'),
    )
    expect(outcomeContract).toContain('"kind": "artifact"')
    expect(outcomeContract).toContain('"path": "brief.json"')
    expect(outcomeContract).not.toContain('"fileName": "report.pdf"')
  })

  it('publishes an object-shaped input schema accepted by the HTTP MCP adapter', () => {
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

  it('requires sorted unique in-range render pages', () => {
    expect(validateRenderPages([1, 3], 3)).toEqual([1, 3])
    expect(() => validateRenderPages([2, 1], 3)).toThrow('sorted')
    expect(() => validateRenderPages([1, 1], 3)).toThrow('unique')
    expect(() => validateRenderPages([4], 3)).toThrow('outside')
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

  it('returns project-relative inspect paths that the sandboxed read tool can access', async () => {
    const { root } = await makeWorkspace()
    const runtime = makeRuntime(root)
    const tool = createProcessPdfTool(runtime)

    const result = await tool.handler({ operation: 'inspect' }, makeContext())

    expect(result).toEqual({
      ok: true,
      operation: 'inspect',
      fileName: 'input.pdf',
      pageCount: 3,
      pages: [
        {
          sourcePage: 1,
          textPath: `work/${SESSION_TOKEN}/analysis/page-0001.txt`,
          previewPath: `work/${SESSION_TOKEN}/analysis/page-0001.png`,
        },
        {
          sourcePage: 2,
          textPath: `work/${SESSION_TOKEN}/analysis/page-0002.txt`,
          previewPath: `work/${SESSION_TOKEN}/analysis/page-0002.png`,
        },
        {
          sourcePage: 3,
          textPath: `work/${SESSION_TOKEN}/analysis/page-0003.txt`,
          previewPath: `work/${SESSION_TOKEN}/analysis/page-0003.png`,
        },
      ],
    })
    expect(runtime.calls.map((call) => call.file)).toEqual([
      '/usr/bin/pdfinfo',
      '/usr/bin/pdftotext',
      '/usr/bin/pdftoppm',
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

  it('rejects multiple staged PDFs before the text-reader model can inspect them', async () => {
    const { root } = await makeWorkspace()
    await writeFile(path.join(root, SESSION_TOKEN, 'in', 'second.pdf'), '%PDF-1.4\nsecond')
    const runtime = makeRuntime(root)
    const tool = createProcessPdfTool(runtime)

    const result = await tool.handler(
      { operation: 'inspect' },
      makeContext(PDF_TEXT_READER_AGENT_ID),
    )

    expect(result).toEqual({
      ok: false,
      code: 'invalid_attachment_count',
      message: 'Expected exactly one staged PDF; found 2.',
      fileName: null,
      pageCount: null,
    })
    expect(runtime.calls).toEqual([])
  })

  it('keeps a staged PDF named analysis separate from server inspection files', async () => {
    const { root, input } = await makeWorkspace('analysis')
    const tool = createProcessPdfTool(makeRuntime(root))

    const result = await tool.handler({ operation: 'inspect' }, makeContext())

    expect(result).toMatchObject({ ok: true, fileName: 'analysis', pageCount: 3 })
    expect(await readFile(input, 'utf8')).toBe('%PDF-1.4\nfixture')
  })

  it('finalizes validated manifests and renders only their plan pages', async () => {
    const { root } = await makeWorkspace()
    const runtime = makeRuntime(root)
    const tool = createProcessPdfTool(runtime)

    await tool.handler({ operation: 'inspect' }, makeContext())
    const result = await tool.handler(makeFinalizeInput(), makeContext())

    expect(result).toEqual({
      ok: true,
      operation: 'finalize',
      artifacts: [
        { sourcePage: 2, path: `/home/opencode/work/${SESSION_TOKEN}/out/floor-plan-page-0002.png` },
        { sourcePage: 3, path: `/home/opencode/work/${SESSION_TOKEN}/out/floor-plan-page-0003.png` },
      ],
      manifests: [
        `/home/opencode/work/${SESSION_TOKEN}/out/brief.json`,
        `/home/opencode/work/${SESSION_TOKEN}/out/floor-plans.json`,
      ],
    })
    expect(runtime.calls.filter((call) => call.file === '/usr/bin/pdftoppm')).toHaveLength(3)
    const outputNames = (await readdir(path.join(root, SESSION_TOKEN, 'out'))).sort()
    expect(outputNames).toEqual([
      'brief.json',
      'floor-plan-page-0002.png',
      'floor-plan-page-0003.png',
      'floor-plans.json',
    ])
    const floorPlans = JSON.parse(
      await readFile(path.join(root, SESSION_TOKEN, 'out', 'floor-plans.json'), 'utf8'),
    )
    expect(floorPlans.plans.map((plan: { artifactPath: string }) => plan.artifactPath)).toEqual([
      'floor-plan-page-0002.png',
      'floor-plan-page-0003.png',
    ])
  })

  it('reports every manifest invariant needed for one corrected finalization retry', async () => {
    const { root } = await makeWorkspace()
    const runtime = makeRuntime(root)
    const tool = createProcessPdfTool(runtime)
    const base = makeFinalizeInput()
    const input = {
      ...base,
      brief: {
        ...base.brief,
        source: base.brief.source,
        keyFacts: [{ label: 'Address from drawing', value: 'Example Street', sourcePages: [2] }],
      },
      floorPlans: {
        ...base.floorPlans,
        source: base.floorPlans.source,
        plans: base.floorPlans.plans,
        otherPages: [{ sourcePage: 1, reason: 'unrelated' as const }],
      },
    }

    await tool.handler({ operation: 'inspect' }, makeContext())
    const failure = await tool.handler(input, makeContext())

    expect(failure).toMatchObject({
      ok: false,
      code: 'pdf_processing_failed',
      fileName: 'input.pdf',
      pageCount: 3,
    })
    const failureMessage = (failure as { message: string }).message
    expect(failureMessage).toContain('keyFacts[0] contains page 2 outside briefPages')
    expect(failureMessage).toContain('page 1 is classified more than once')
    expect(runtime.calls.filter((call) => call.file === '/usr/bin/pdftoppm')).toHaveLength(1)
    expect(await readdir(path.join(root, SESSION_TOKEN, 'out'))).toEqual([
      'processing-error.json',
    ])

    input.brief.keyFacts[0]!.sourcePages = [1]
    input.floorPlans.otherPages = []
    const retry = await tool.handler(input, makeContext())

    expect(retry).toMatchObject({ ok: true, operation: 'finalize' })
    expect(runtime.calls.filter((call) => call.file === '/usr/bin/pdftoppm')).toHaveLength(3)
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

  it('rejects incomplete page partitions before rendering and removes partial outputs', async () => {
    const { root } = await makeWorkspace()
    const runtime = makeRuntime(root)
    const tool = createProcessPdfTool(runtime)
    const input = makeFinalizeInput()
    input.floorPlans.plans = input.floorPlans.plans.slice(0, 1)

    await tool.handler({ operation: 'inspect' }, makeContext())
    const result = await tool.handler(input, makeContext())

    expect(result).toMatchObject({ ok: false, code: 'pdf_processing_failed' })
    expect(runtime.calls.filter((call) => call.file === '/usr/bin/pdftoppm')).toHaveLength(1)
    expect(await readdir(path.join(root, SESSION_TOKEN, 'out'))).toEqual([
      'processing-error.json',
    ])
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

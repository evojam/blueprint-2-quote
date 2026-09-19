import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, jest } from '@jest/globals'

jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/lib/agent-registry', () => ({
  getAgent: jest.fn(() => undefined),
}))
import { ensureAgentsLoaded, getAgentEntry } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'
import { PDF_TEXT_READER_AGENT_ID } from '../ai-agents'
import '../ai-agents'
import { PDF_TOOL_ID } from '../ai-tools'

const execFileAsync = promisify(execFile)
describe('property_documents.pdf_text_reader', () => {
  it('keeps file-plane options after generated file-agent loading', async () => {
    await ensureAgentsLoaded()
    expect(getAgentEntry(PDF_TEXT_READER_AGENT_ID)?.files).toEqual({
      enabled: true,
      inputs: true,
      outputs: false,
      bash: false,
    })
  })

  it('registers a read-only file-plane research agent', () => {
    const entry = getAgentEntry(PDF_TEXT_READER_AGENT_ID)
    expect(entry).toMatchObject({
      id: PDF_TEXT_READER_AGENT_ID,
      moduleId: 'property_documents',
      runtime: 'opencode',
      resultKind: 'research',
      files: { enabled: true, inputs: true, outputs: false, bash: false },
    })
    expect(entry?.tools).toEqual([PDF_TOOL_ID])
    expect(entry?.outcomeSchema).toBeDefined()
    expect(entry?.tokenUsage?.total).toBeGreaterThan(0)
    expect(entry?.sourceFiles?.map((file) => file.path)).toEqual(
      expect.arrayContaining(['AGENT.md', 'OUTCOME.md', 'SAMPLE.json']),
    )
  })

  it('accepts exactly the brief payload and rejects extra fields', () => {
    const entry = getAgentEntry(PDF_TEXT_READER_AGENT_ID)
    expect(entry?.schema.safeParse({ kind: 'research', data: { brief: 'tekst PDF' } }).success).toBe(true)
    expect(entry?.schema.safeParse({ kind: 'research', data: { brief: 'tekst PDF', extra: true } }).success).toBe(false)
    expect(entry?.schema.safeParse({ kind: 'research', data: {} }).success).toBe(false)
  })
  it('hardens property document profiles to their scoped read-only roots', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'property-pdf-policy-'))
    const agentsDir = path.join(cwd, 'docker', 'opencode', 'agents')
    await mkdir(agentsDir, { recursive: true })
    const generatedProfile = [
      '---',
      'tools:',
      '  "*": false',
      '  "open-mercato_agent_orchestrator_load_skill": true',
      '  "open-mercato_agent_orchestrator_run_skill_script": true',
      '  write: true',
      '  edit: true',
      'permission:',
      '  write: allow',
      '  edit: allow',
      '  read:',
      '    "*": allow',
      '  bash: allow',
      '  task: deny',
      '---',
      '',
    ].join('\n')
    const generatedIntakeProfile = `${generatedProfile}## Outcome contract
Write the files you produce into out/, then pass this outcome:

\`\`\`json
{
  "artifacts": [
    {
      "fileName": "report.pdf",
      "mimeType": "application/pdf",
      "caption": "What this file is"
    }
  ],
  "summary": "One sentence about what you produced."
}
\`\`\`

The PDF processing tool is the only output writer.
`
    const generatedRoomProfile = `${generatedProfile}## Outcome contract
Your result MUST match this JSON Schema (the \`data\` object). Pass it as the \`outcome\` argument of the submit_outcome tool, as a JSON object (not a string):

\`\`\`json
{"type":"array","items":{"type":"string"}}
\`\`\`
`
    await Promise.all([
      writeFile(
        path.join(agentsDir, 'property_documents_pdf_intake.md'),
        generatedIntakeProfile,
      ),
      writeFile(path.join(agentsDir, 'property_documents_pdf_text_reader.md'), generatedProfile),
      writeFile(
        path.join(agentsDir, 'property_documents_room_dimensions.md'),
        generatedRoomProfile,
      ),
    ])
    const sourceDir = path.join(cwd, 'src', 'modules', 'property_documents')
    const generatedDir = path.join(cwd, '.mercato', 'generated')
    await Promise.all([
      mkdir(sourceDir, { recursive: true }),
      mkdir(generatedDir, { recursive: true }),
    ])
    const bundlePaths = [
      path.join(generatedDir, 'ai-tools.generated.bundled.mjs'),
      path.join(generatedDir, 'di.generated.mjs'),
    ]
    const sourcePaths = [
      path.join(sourceDir, 'ai-tools.ts'),
      path.join(sourceDir, 'di.ts'),
      path.join(sourceDir, 'room-dimensions-vision.ts'),
    ]
    await Promise.all([
      ...bundlePaths.flatMap((bundlePath) => [
        writeFile(bundlePath, 'stale bundle'),
        writeFile(`${bundlePath}.cache.json`, '{}'),
      ]),
      ...sourcePaths.map((sourcePath) => writeFile(sourcePath, 'new source')),
    ])
    const staleTime = new Date('2000-01-01T00:00:00.000Z')
    const sourceTime = new Date('2030-01-01T00:00:00.000Z')
    await Promise.all([
      ...bundlePaths.map((bundlePath) => utimes(bundlePath, staleTime, staleTime)),
      ...sourcePaths.map((sourcePath) => utimes(sourcePath, sourceTime, sourceTime)),
    ])

    await execFileAsync('node', [path.resolve(process.cwd(), 'scripts/enable-property-pdf-agent-files.mjs')], {
      cwd,
      env: { ...process.env, OM_OPENCODE_WORKSPACE_ROOT_CONTAINER: '/home/opencode/work' },
    })

    const hardened = await readFile(
      path.join(agentsDir, 'property_documents_pdf_text_reader.md'),
      'utf8',
    )
    expect(hardened).toContain('  read: true')
    expect(hardened).toContain('  write: deny')
    expect(hardened).toContain('  edit: deny')
    expect(hardened).toContain('  bash: deny')
    expect(hardened).toContain('    "/home/opencode/work/*/analysis/**": allow')
    expect(hardened).toContain('    "home/opencode/work/*/analysis/**": allow')
    expect(hardened).not.toContain('  write: true')
    expect(hardened).not.toContain('  edit: true')
    expect(hardened).not.toContain('open-mercato_agent_orchestrator_load_skill')
    expect(hardened).not.toContain('open-mercato_agent_orchestrator_run_skill_script')
    const hardenedRoomDimensions = await readFile(
      path.join(agentsDir, 'property_documents_room_dimensions.md'),
      'utf8',
    )
    expect(hardenedRoomDimensions).toContain('    "/home/opencode/work/*/in/**": allow')
    expect(hardenedRoomDimensions).toContain('    "home/opencode/work/*/in/**": allow')
    expect(hardenedRoomDimensions).not.toContain('/analysis/**')
    expect(hardenedRoomDimensions).not.toContain('  write: true')
    expect(hardenedRoomDimensions).not.toContain('  edit: true')
    expect(hardenedRoomDimensions).not.toContain('  bash: allow')
    expect(hardenedRoomDimensions).toContain('the `data` array')
    expect(hardenedRoomDimensions).toContain('`{ "kind": "research", "data": [...] }`')
    expect(hardenedRoomDimensions).not.toContain('as a JSON array (not a string)')
    expect(hardenedRoomDimensions).not.toContain('the `data` object')
    const hardenedIntake = await readFile(
      path.join(agentsDir, 'property_documents_pdf_intake.md'),
      'utf8',
    )
    expect(hardenedIntake).toContain('"kind": "artifact"')
    expect(hardenedIntake).toContain('"path": "brief.json"')
    expect(hardenedIntake).not.toContain('"fileName": "report.pdf"')
    for (const bundlePath of bundlePaths) {
      await expect(access(bundlePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(`${bundlePath}.cache.json`)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})

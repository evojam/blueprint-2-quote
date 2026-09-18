import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from '@jest/globals'
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
  it('hardens both property PDF profiles to workspace-scoped read-only access', async () => {
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
    await Promise.all([
      writeFile(
        path.join(agentsDir, 'property_documents_pdf_intake.md'),
        generatedIntakeProfile,
      ),
      writeFile(path.join(agentsDir, 'property_documents_pdf_text_reader.md'), generatedProfile),
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
    const hardenedIntake = await readFile(
      path.join(agentsDir, 'property_documents_pdf_intake.md'),
      'utf8',
    )
    expect(hardenedIntake).toContain('"kind": "artifact"')
    expect(hardenedIntake).toContain('"path": "brief.json"')
    expect(hardenedIntake).not.toContain('"fileName": "report.pdf"')
  })
})

import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from '@jest/globals'

const execFileAsync = promisify(execFile)
describe('property document agent profile hardening', () => {
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
    expect(hardenedIntake).toContain('  read: true')
    expect(hardenedIntake).toContain('  write: deny')
    expect(hardenedIntake).toContain('  edit: deny')
    expect(hardenedIntake).toContain('  bash: deny')
    expect(hardenedIntake).toContain('    "/home/opencode/work/*/analysis/**": allow')
    expect(hardenedIntake).toContain('    "home/opencode/work/*/analysis/**": allow')
    expect(hardenedIntake).not.toContain('open-mercato_agent_orchestrator_load_skill')
    expect(hardenedIntake).not.toContain('open-mercato_agent_orchestrator_run_skill_script')
    expect(hardenedIntake).toContain('"kind": "artifact"')
    expect(hardenedIntake).toContain('"path": "brief.json"')
    expect(hardenedIntake).not.toContain('"fileName": "report.pdf"')
    for (const bundlePath of bundlePaths) {
      await expect(access(bundlePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(`${bundlePath}.cache.json`)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})

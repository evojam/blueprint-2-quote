import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from '@jest/globals'

const execFileAsync = promisify(execFile)
const temporaryRoots: string[] = []
const hardenerPath = path.resolve(process.cwd(), 'scripts/enable-property-pdf-agent-files.mjs')

function generatedProfile(toolId: string, outcomeContract = ''): string {
  return [
    '---',
    'tools:',
    '  "*": false',
    `  ${JSON.stringify(toolId)}: true`,
    '  "open-mercato_agent_orchestrator_submit_outcome": true',
    '  "open-mercato_agent_orchestrator_load_skill": true',
    '  "open-mercato_agent_orchestrator_run_skill_script": true',
    '  "open-mercato_agent_orchestrator_delegate_agent": true',
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
    outcomeContract,
    '',
  ].join('\n')
}

async function makeFixture(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'property-agent-policy-'))
  temporaryRoots.push(cwd)
  const agentsDir = path.join(cwd, 'docker', 'opencode', 'agents')
  await mkdir(agentsDir, { recursive: true })
  const intakeOutcome = `## Outcome contract
Write the files you produce into out/, then pass this outcome:

\`\`\`json
{"artifacts":[{"fileName":"report.pdf","mimeType":"application/pdf","caption":"Report"}]}
\`\`\`

The PDF processing tool is the only output writer.`
  const arrayOutcome = `## Outcome contract
Your result MUST match this JSON Schema (the \`data\` object). Pass it as the \`outcome\` argument of the submit_outcome tool, as a JSON object (not a string):

\`\`\`json
{"type":"array","items":{"type":"string"}}
\`\`\``
  const objectOutcome = `## Outcome contract
Your result MUST match this JSON Schema (the \`data\` object). Pass it as the \`outcome\` argument of the submit_outcome tool, as a JSON object (not a string):

\`\`\`json
{"type":"object","additionalProperties":false,"required":["schemaVersion"],"properties":{"schemaVersion":{"const":"1"}}}
\`\`\``
  await Promise.all([
    writeFile(
      path.join(agentsDir, 'property_documents_pdf_intake.md'),
      generatedProfile('open-mercato_property_documents_process_pdf', intakeOutcome),
    ),
    writeFile(
      path.join(agentsDir, 'property_documents_room_dimensions.md'),
      generatedProfile('open-mercato_property_documents_extract_room_dimensions', arrayOutcome),
    ),
    writeFile(
      path.join(agentsDir, 'property_documents_room_measurements.md'),
      generatedProfile('open-mercato_property_documents_extract_room_measurements', objectOutcome),
    ),
  ])
  return cwd
}

async function runHardener(cwd: string): Promise<void> {
  await execFileAsync('node', [hardenerPath], {
    cwd,
    env: { ...process.env, OM_OPENCODE_WORKSPACE_ROOT_CONTAINER: '/home/opencode/work' },
  })
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
}

async function expectPresent(filePath: string): Promise<void> {
  await expect(access(filePath)).resolves.toBeUndefined()
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('property document generated profile hardening', () => {
  it('limits the v2 profile to one read-only input root and object outcome submission', async () => {
    const cwd = await makeFixture()
    const profilePath = path.join(
      cwd,
      'docker',
      'opencode',
      'agents',
      'property_documents_room_measurements.md',
    )

    await runHardener(cwd)
    const hardened = await readFile(profilePath, 'utf8')
    await runHardener(cwd)

    expect(await readFile(profilePath, 'utf8')).toBe(hardened)
    expect(hardened).toContain('  "open-mercato_property_documents_extract_room_measurements": true')
    expect(hardened).toContain('  "open-mercato_agent_orchestrator_submit_outcome": true')
    expect(hardened).toContain('  read: true')
    expect(hardened).toContain('  write: deny')
    expect(hardened).toContain('  edit: deny')
    expect(hardened).toContain('  bash: deny')
    expect(hardened).toContain('  task: deny')
    expect(hardened).toContain('    "*": deny')
    expect(hardened).toContain('    "/home/opencode/work/*/in/**": allow')
    expect(hardened).toContain('    "home/opencode/work/*/in/**": allow')
    expect(hardened).toContain('    "work/*/in/**": allow')
    expect(hardened).not.toContain('/analysis/**')
    expect(hardened).not.toMatch(/  (?:write|edit): true/)
    expect(hardened).not.toContain('  bash: allow')
    expect(hardened).not.toContain('open-mercato_agent_orchestrator_load_skill')
    expect(hardened).not.toContain('open-mercato_agent_orchestrator_run_skill_script')
    expect(hardened).not.toContain('open-mercato_agent_orchestrator_delegate_agent')
    expect(hardened).toContain('the `data` object')
    expect(hardened).toContain('`{ "kind": "research", "data": { ... } }`')
    expect(hardened).not.toContain(
      'Pass it as the `outcome` argument of the submit_outcome tool, as a JSON object (not a string):',
    )
    expect(hardened).not.toContain('the `data` array')
  })

  it.each([
    ['room-measurements-contract.ts', ['ai-tools.generated.bundled.mjs', 'di.generated.mjs']],
    ['room-measurements-vision.ts', ['di.generated.mjs']],
    ['property-documents-vision-provider.ts', ['di.generated.mjs']],
  ] as const)('invalidates the owning generated bundle when %s is newer', async (sourceName, removedBundles) => {
    const cwd = await makeFixture()
    const sourceDir = path.join(cwd, 'src', 'modules', 'property_documents')
    const generatedDir = path.join(cwd, '.mercato', 'generated')
    await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(generatedDir, { recursive: true })])
    const sourceNames = [
      'ai-tools.ts',
      'di.ts',
      'room-dimensions-vision.ts',
      'room-measurements-contract.ts',
      'room-measurements-vision.ts',
      'property-documents-vision-provider.ts',
    ]
    const bundleNames = ['ai-tools.generated.bundled.mjs', 'di.generated.mjs']
    const sourcePaths = sourceNames.map((name) => path.join(sourceDir, name))
    const bundlePaths = bundleNames.map((name) => path.join(generatedDir, name))
    await Promise.all([
      ...sourcePaths.map((sourcePath) => writeFile(sourcePath, 'source')),
      ...bundlePaths.flatMap((bundlePath) => [
        writeFile(bundlePath, 'bundle'),
        writeFile(`${bundlePath}.cache.json`, '{}'),
      ]),
    ])
    const oldTime = new Date('2000-01-01T00:00:00.000Z')
    const bundleTime = new Date('2020-01-01T00:00:00.000Z')
    const newTime = new Date('2030-01-01T00:00:00.000Z')
    await Promise.all([
      ...sourcePaths.map((sourcePath) => utimes(sourcePath, oldTime, oldTime)),
      ...bundlePaths.map((bundlePath) => utimes(bundlePath, bundleTime, bundleTime)),
      utimes(path.join(sourceDir, sourceName), newTime, newTime),
    ])

    await runHardener(cwd)

    for (const [index, bundleName] of bundleNames.entries()) {
      const bundlePath = bundlePaths[index]
      if (removedBundles.some((candidate) => candidate === bundleName)) {
        await expectMissing(bundlePath)
        await expectMissing(`${bundlePath}.cache.json`)
      } else {
        await expectPresent(bundlePath)
        await expectPresent(`${bundlePath}.cache.json`)
      }
    }
  })
})

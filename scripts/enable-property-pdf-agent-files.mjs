import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFile = fileURLToPath(import.meta.url)

const PROPERTY_PDF_AGENT_FILES = [
  'property_documents_pdf_intake.md',
  'property_documents_pdf_text_reader.md',
]

const PDF_INTAKE_AGENT_FILE = 'property_documents_pdf_intake.md'
const OUTCOME_CONTRACT_MARKER = '## Outcome contract\n'
const OUTCOME_PROSE_MARKER = '\nThe PDF processing tool is the only output writer.'
const PDF_INTAKE_OUTCOME_EXAMPLE = `\`\`\`json
{
  "kind": "artifact",
  "artifacts": [
    {
      "path": "brief.json",
      "fileName": "brief.json",
      "mimeType": "application/json",
      "caption": "Validated property brief manifest."
    },
    {
      "path": "floor-plans.json",
      "fileName": "floor-plans.json",
      "mimeType": "application/json",
      "caption": "Validated floor-plan manifest."
    }
  ],
  "summary": "Processed the PDF into a property brief and floor-plan artifacts."
}
\`\`\``

function hardenPdfIntakeOutcomeContract(source, agentPath) {
  const outcomeStart = source.indexOf(OUTCOME_CONTRACT_MARKER)
  const proseStart = source.indexOf(OUTCOME_PROSE_MARKER, outcomeStart)
  if (outcomeStart < 0 || proseStart < 0) {
    throw new Error(`Cannot find the generated artifact outcome contract in ${agentPath}`)
  }

  const contract = source.slice(outcomeStart, proseStart)
  if (
    contract.includes('"kind": "artifact"') &&
    contract.includes('"path": "brief.json"') &&
    !contract.includes('"fileName": "report.pdf"')
  ) {
    return source
  }

  const fenceStart = contract.indexOf('```json\n')
  const fenceEnd = contract.indexOf('\n```', fenceStart + 8)
  if (fenceStart < 0 || fenceEnd < 0) {
    throw new Error(`Cannot find the generated artifact outcome example in ${agentPath}`)
  }
  const hardenedContract = `${contract.slice(0, fenceStart)}${PDF_INTAKE_OUTCOME_EXAMPLE}${contract.slice(fenceEnd + 4)}`
  return `${source.slice(0, outcomeStart)}${hardenedContract}${source.slice(proseStart)}`
}

function hardenGeneratedAgentFile(cwd, fileName) {
  const agentPath = path.resolve(cwd, 'docker/opencode/agents', fileName)
  const workspaceRoot = (
    process.env.OM_OPENCODE_WORKSPACE_ROOT_CONTAINER || '/home/opencode/work'
  ).replace(/\/+$/, '')
  const relativeWorkspaceRoot = path.posix.relative('/home/opencode', workspaceRoot)
  const workspaceRelativeGlob =
    relativeWorkspaceRoot && !relativeWorkspaceRoot.startsWith('../')
      ? `${relativeWorkspaceRoot}/*/analysis/**`
      : null
  const workspaceGlob = `${workspaceRoot}/*/analysis/**`
  const workspaceContainerGlob = `${workspaceRoot.replace(/^\/+/, '')}/*/analysis/**`
  const permissionMarker = 'permission:\n'
  const taskPermissionMarker = '  task: deny\n'

  let source
  try {
    source = fs.readFileSync(agentPath, 'utf8')
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
  const permissionStart = source.indexOf(permissionMarker)
  const taskPermissionStart = source.indexOf(taskPermissionMarker, permissionStart)
  if (permissionStart < 0 || taskPermissionStart < 0) {
    throw new Error(`Cannot find the generated OpenCode permission block in ${agentPath}`)
  }

  let toolsBlock = source.slice(0, permissionStart)
  toolsBlock = toolsBlock
    .replace('  write: true\n', '')
    .replace('  edit: true\n', '')
    .replace('  "open-mercato_agent_orchestrator_load_skill": true\n', '')
    .replace('  "open-mercato_agent_orchestrator_run_skill_script": true\n', '')
  if (!toolsBlock.includes('  "*": false\n')) {
    toolsBlock = toolsBlock.replace('tools:\n', 'tools:\n  "*": false\n')
  }
  if (!toolsBlock.includes('  read: true\n')) {
    toolsBlock += '  read: true\n'
  }

  const filePolicy = [
    'permission:',
    '  write: deny',
    '  edit: deny',
    '  read:',
    '    "*": deny',
    `    ${JSON.stringify(workspaceGlob)}: allow`,
    `    ${JSON.stringify(workspaceContainerGlob)}: allow`,
    ...(workspaceRelativeGlob
      ? [`    ${JSON.stringify(workspaceRelativeGlob)}: allow`]
      : []),
    '  bash: deny',
    '',
  ].join('\n')
  let hardenedSource = `${toolsBlock}${filePolicy}${source.slice(taskPermissionStart)}`
  if (fileName === PDF_INTAKE_AGENT_FILE) {
    hardenedSource = hardenPdfIntakeOutcomeContract(hardenedSource, agentPath)
  }

  for (const required of [
    '  read: true',
    '  "*": false',
    '  write: deny',
    '  edit: deny',
    `    ${JSON.stringify(workspaceGlob)}: allow`,
    `    ${JSON.stringify(workspaceContainerGlob)}: allow`,
    '  bash: deny',
  ]) {
    if (!hardenedSource.includes(required)) {
      throw new Error(`Generated PDF agent ${fileName} is missing required policy: ${required}`)
    }
  }
  for (const forbidden of [
    '  write: true',
    '  edit: true',
    '  bash: true',
    '  bash: allow',
    'open-mercato_agent_orchestrator_load_skill',
    'open-mercato_agent_orchestrator_run_skill_script',
  ]) {
    if (hardenedSource.includes(forbidden)) {
      throw new Error(`Generated PDF agent ${fileName} unexpectedly grants: ${forbidden.trim()}`)
    }
  }

  if (hardenedSource !== source) fs.writeFileSync(agentPath, hardenedSource, 'utf8')
  return true
}

export function hardenPropertyPdfAgentFile(cwd = process.cwd()) {
  const results = PROPERTY_PDF_AGENT_FILES.map((fileName) =>
    hardenGeneratedAgentFile(cwd, fileName),
  )
  // The standalone MCP loader keys its app-local bundle only by the generated
  // registry mtime. Invalidate once when the tool source is newer; after the
  // watcher rebuilds the bundle, repeated hardening remains idempotent.
  const toolSource = path.resolve(cwd, 'src/modules/property_documents/ai-tools.ts')
  const toolBundle = path.resolve(cwd, '.mercato/generated/ai-tools.generated.bundled.mjs')
  try {
    if (fs.statSync(toolSource).mtimeMs > fs.statSync(toolBundle).mtimeMs) {
      fs.rmSync(toolBundle)
    }
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error
    }
  }
  return results.some(Boolean)
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  hardenPropertyPdfAgentFile()
}

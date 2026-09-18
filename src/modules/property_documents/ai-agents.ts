import type { AiAgentDefinition } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-agent-definition'
import {
  getAgentEntry,
  registerFileAgent,
  type AgentRegistryEntry,
  type FileAgentFilesConfig,
} from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'
import { compileOutcome } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/outcomeSchema'
import {
  fileAgentDescriptors,
  type FileAgentDescriptor,
} from '../../../.mercato/generated/file-agents.generated'
import { PDF_AGENT_ID, PDF_TEXT_READER_AGENT_ID } from './ai-tools'

const FILE_CONFIGS: Record<string, FileAgentFilesConfig> = {
  [PDF_AGENT_ID]: { enabled: true, inputs: true, outputs: true, bash: false },
  [PDF_TEXT_READER_AGENT_ID]: { enabled: true, inputs: true, outputs: false, bash: false },
}

function registerGeneratedFileAgent(descriptor: FileAgentDescriptor): void {
  const entry: AgentRegistryEntry = {
    id: descriptor.id,
    moduleId: descriptor.moduleId,
    resultKind: descriptor.resultKind,
    schema: compileOutcome({
      kind: descriptor.resultKind,
      schema: descriptor.outcomeSchema,
    }).resultSchema,
    tools: descriptor.tools,
    skills: descriptor.skills,
    subAgents: descriptor.subAgents,
    label: descriptor.label,
    description: descriptor.description,
    instructions: descriptor.instructions,
    defaultProvider: descriptor.provider,
    defaultModel: descriptor.model,
    loop: descriptor.maxSteps == null ? undefined : { maxSteps: descriptor.maxSteps },
    runtime: 'opencode',
    outcomeSchema: descriptor.outcomeSchema,
    sampleInput: descriptor.sampleInput,
    facts: descriptor.facts,
    files: FILE_CONFIGS[descriptor.id],
    tokenUsage: descriptor.tokenUsage,
    sourceFiles: descriptor.sourceFiles,
  }

  const existing = getAgentEntry(descriptor.id)
  if (existing) {
    Object.assign(existing, entry)
  } else {
    registerFileAgent(entry)
  }
}

for (const agentId of [PDF_AGENT_ID, PDF_TEXT_READER_AGENT_ID]) {
  const descriptor = fileAgentDescriptors.find((candidate) => candidate.id === agentId)
  if (!descriptor) {
    throw new Error(`[internal] missing generated file-agent descriptor "${agentId}"`)
  }
  registerGeneratedFileAgent(descriptor)
}

export { PDF_TEXT_READER_AGENT_ID }
export const aiAgents: AiAgentDefinition[] = []
export default aiAgents

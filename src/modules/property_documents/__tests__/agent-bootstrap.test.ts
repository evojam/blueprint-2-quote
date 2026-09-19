import { describe, expect, it, jest } from '@jest/globals'

jest.mock('../room-dimensions-vision', () => ({
  roomDimensionsVisionService: { analyzeImage: jest.fn() },
}))
jest.mock('../litellm-provider', () => ({
  registerLiteLlmChatProvider: jest.fn(),
}))
jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/lib/agent-registry', () => ({
  getAgent: jest.fn(() => undefined),
}))


import '../../../modules'
import '../di'
import { ensureAgentsLoaded, getAgentEntry } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'

describe('property document file-agent bootstrap', () => {
  it('loads file-plane options into the runtime registry', async () => {
    await ensureAgentsLoaded()
    expect(getAgentEntry('property_documents.pdf_text_reader')?.files).toEqual({
      enabled: true,
      inputs: true,
      outputs: false,
      bash: false,
    })
    expect(getAgentEntry('property_documents.pdf_text_reader')?.sourceFiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'AGENT.md' })]),
    )
  })
})

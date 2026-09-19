import { describe, expect, it, jest } from '@jest/globals'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'

jest.mock('../room-dimensions-vision', () => ({
  roomDimensionsVisionService: { analyzeImage: jest.fn() },
}))
jest.mock('../room-measurements-vision', () => ({
  roomMeasurementsVisionService: { analyzeImage: jest.fn() },
}))
jest.mock('../litellm-provider', () => ({
  registerLiteLlmChatProvider: jest.fn(),
}))
jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/lib/agent-registry', () => ({
  getAgent: jest.fn(() => undefined),
}))

import '../../../modules'
import { register } from '../di'
import {
  ensureAgentsLoaded,
  getAgentEntry,
} from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'
import {
  PDF_AGENT_ID,
  PDF_TEXT_READER_AGENT_ID,
  ROOM_DIMENSIONS_AGENT_ID,
  ROOM_DIMENSIONS_VISION_SERVICE,
  ROOM_MEASUREMENTS_AGENT_ID,
  ROOM_MEASUREMENTS_VISION_SERVICE,
} from '../ai-tools'
describe('property document file-agent bootstrap', () => {
  it('loads supported file agents and excludes the retired text reader', async () => {
    await ensureAgentsLoaded()
    expect(getAgentEntry('property_documents.pdf_intake')?.files).toEqual({
      enabled: true,
      inputs: true,
      outputs: true,
      bash: false,
    })
    expect(getAgentEntry('property_documents.pdf_intake')?.sourceFiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'AGENT.md' })]),
    )
    expect(getAgentEntry('property_documents.pdf_text_reader')).toBeUndefined()
  })
})

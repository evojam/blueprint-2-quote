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
import '../ai-agents'
import { register } from '../di'
import {
  ensureAgentsLoaded,
  getAgentEntry,
} from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'
import {
  PDF_AGENT_ID,
  ROOM_DIMENSIONS_AGENT_ID,
  ROOM_DIMENSIONS_VISION_SERVICE,
  ROOM_MEASUREMENTS_AGENT_ID,
  ROOM_MEASUREMENTS_VISION_SERVICE,
} from '../ai-tools'

describe('property document file-agent bootstrap', () => {
  it('loads supported file agents, adds room measurements, and excludes the retired text reader', async () => {
    await ensureAgentsLoaded()

    for (const agentId of [PDF_AGENT_ID, ROOM_DIMENSIONS_AGENT_ID, ROOM_MEASUREMENTS_AGENT_ID]) {
      expect(getAgentEntry(agentId)?.files).toEqual({
        enabled: true,
        inputs: true,
        outputs: true,
        bash: false,
      })
      expect(getAgentEntry(agentId)?.sourceFiles).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'AGENT.md' })]),
      )
    }

    expect(getAgentEntry('property_documents.pdf_text_reader')).toBeUndefined()
  })

  it('registers both room vision services without replacing either one', () => {
    const registerServices = jest.fn()

    register({ register: registerServices } as unknown as AppContainer)

    expect(registerServices).toHaveBeenCalledTimes(1)
    expect(registerServices.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        [ROOM_DIMENSIONS_VISION_SERVICE]: expect.anything(),
        [ROOM_MEASUREMENTS_VISION_SERVICE]: expect.anything(),
      }),
    )
  })
})

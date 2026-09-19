import { describe, expect, it, jest } from '@jest/globals'

jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/lib/agent-registry', () => ({
  getAgent: jest.fn(() => undefined),
}))
import {
  ensureAgentsLoaded,
  getAgentEntry,
} from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'
import { ROOM_DIMENSIONS_AGENT_ID } from '../ai-agents'
import '../ai-agents'
import { ROOM_DIMENSIONS_TOOL_ID } from '../ai-tools'

const validRoom = {
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
}

describe('property_documents.room_dimensions', () => {
  it('registers a read-only image file agent', async () => {
    await ensureAgentsLoaded()

    const entry = getAgentEntry(ROOM_DIMENSIONS_AGENT_ID)
    expect(entry).toMatchObject({
      id: ROOM_DIMENSIONS_AGENT_ID,
      moduleId: 'property_documents',
      runtime: 'opencode',
      resultKind: 'research',
      files: { enabled: true, inputs: true, outputs: true, bash: false },
    })
    expect(entry?.tools).toEqual([ROOM_DIMENSIONS_TOOL_ID])
    expect(entry?.sourceFiles?.map((file) => file.path)).toEqual(
      expect.arrayContaining(['AGENT.md', 'OUTCOME.md', 'SAMPLE.json']),
    )
  })

  it('accepts a top-level room array and rejects wrappers or ungrouped dimensions', () => {
    const schema = getAgentEntry(ROOM_DIMENSIONS_AGENT_ID)?.schema

    expect(schema?.safeParse({ kind: 'research', data: [validRoom] }).success).toBe(true)
    expect(schema?.safeParse({ kind: 'research', data: { rooms: [validRoom] } }).success).toBe(
      false,
    )
    expect(
      schema?.safeParse({
        kind: 'research',
        data: [{ ...validRoom, dimensions: undefined }],
      }).success,
    ).toBe(false)
    expect(
      schema?.safeParse({
        kind: 'research',
        data: [{ ...validRoom, extra: true }],
      }).success,
    ).toBe(false)
    expect(
      schema?.safeParse({
        kind: 'research',
        data: [
          {
            ...validRoom,
            dimensions: [{ ...validRoom.dimensions[0], extra: true }],
          },
        ],
      }).success,
    ).toBe(false)
    for (const invalidRoom of [
      { ...validRoom, confidence: 1.1 },
      {
        ...validRoom,
        dimensions: [{ ...validRoom.dimensions[0], orientation: 'diagonal' }],
      },
      {
        ...validRoom,
        dimensions: [{ ...validRoom.dimensions[0], unit: 'px' }],
      },
    ]) {
      expect(schema?.safeParse({ kind: 'research', data: [invalidRoom] }).success).toBe(false)
    }
  })
})

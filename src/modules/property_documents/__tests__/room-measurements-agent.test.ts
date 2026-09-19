import { describe, expect, it, jest } from '@jest/globals'

jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/lib/agent-registry', () => ({
  getAgent: jest.fn(() => undefined),
}))
import {
  ensureAgentsLoaded,
  getAgentEntry,
} from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'
import { ROOM_MEASUREMENTS_AGENT_ID } from '../ai-agents'
import '../ai-agents'
import { ROOM_MEASUREMENTS_TOOL_ID } from '../ai-tools'
import type { RoomMeasurementSet } from '../room-measurements-contract'

const evidenceBox = { x: 0.1, y: 0.1, width: 0.1, height: 0.1 }
const linearMeasurement: NonNullable<RoomMeasurementSet['drawing']['globalCeilingHeight']> = {
  id: 'height-1',
  value: 2.7,
  unit: 'm',
  unitSource: 'label',
  method: 'printed',
  sourceText: '2.70 m',
  evidence: [evidenceBox],
  calibrationId: null,
  confidence: 0.98,
  calculationEligibility: 'eligible',
}
const completeResult: RoomMeasurementSet = {
  schemaVersion: '1',
  analysisStatus: 'complete',
  drawing: {
    imageWidthPx: 1600,
    imageHeightPx: 900,
    declaredUnit: {
      value: 'm',
      sourceText: 'dimensions in metres',
      evidence: [evidenceBox],
      confidence: 0.96,
    },
    declaredScale: null,
    calibrations: [],
    globalCeilingHeight: linearMeasurement,
    confidence: 0.97,
    warnings: [],
  },
  rooms: [
    {
      id: 'room-1',
      printedName: 'Living room',
      location: 'centre of plan',
      floor: {
        outerBoundary: [
          { x: 0.1, y: 0.1 },
          { x: 0.6, y: 0.1 },
          { x: 0.6, y: 0.6 },
          { x: 0.1, y: 0.6 },
        ],
        holes: [],
        printedArea: {
          id: 'area-1',
          value: 24,
          unit: 'm2',
          unitSource: 'label',
          method: 'printed',
          basis: 'net',
          sourceText: '24 m2',
          evidence: [evidenceBox],
          confidence: 0.98,
          calculationEligibility: 'eligible',
        },
        calculationEligibility: 'eligible',
      },
      walls: [],
      openings: [],
      confidence: 0.96,
      warnings: [],
      readiness: {
        floorArea: 'eligible',
        grossWallArea: 'eligible',
        netWallArea: 'eligible',
      },
      missingInputs: [],
    },
  ],
  warnings: [],
}

function outcome(data: unknown, extra: Record<string, unknown> = {}) {
  return { kind: 'research', data, ...extra }
}

function assertEveryObjectIsStrict(node: unknown): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return
  const record = node as Record<string, unknown>
  if (record.type === 'object') expect(record.additionalProperties).toBe(false)
  for (const value of Object.values(record)) assertEveryObjectIsStrict(value)
}

describe('property_documents.room_measurements', () => {
  it('registers the exact bounded read-only file-agent descriptor', async () => {
    await ensureAgentsLoaded()

    const entry = getAgentEntry(ROOM_MEASUREMENTS_AGENT_ID)
    expect(ROOM_MEASUREMENTS_AGENT_ID).toBe('property_documents.room_measurements')
    expect(entry).toMatchObject({
      id: ROOM_MEASUREMENTS_AGENT_ID,
      moduleId: 'property_documents',
      runtime: 'opencode',
      resultKind: 'research',
      loop: { maxSteps: 4 },
      files: { enabled: true, inputs: true, outputs: true, bash: false },
    })
    expect(entry?.tools).toEqual([ROOM_MEASUREMENTS_TOOL_ID])
    expect(entry?.skills).toEqual([])
    expect(entry?.subAgents).toEqual([])
    expect(entry?.sourceFiles?.map((file) => file.path)).toEqual(
      expect.arrayContaining(['AGENT.md', 'OUTCOME.md', 'SAMPLE.json']),
    )
    expect(entry?.sourceFiles).toHaveLength(3)
    expect(entry?.tokenUsage?.total).toBeGreaterThan(0)
    expect(entry?.outcomeSchema).toBeDefined()
    assertEveryObjectIsStrict(entry?.outcomeSchema)
    expect(JSON.stringify(entry?.outcomeSchema)).not.toMatch(
      /"(?:\$ref|oneOf|anyOf|allOf|format)"/,
    )
  })

  it('accepts complete, partial, and non-plan final measurement sets', () => {
    const schema = getAgentEntry(ROOM_MEASUREMENTS_AGENT_ID)?.schema
    const partialResult = structuredClone(completeResult)
    partialResult.analysisStatus = 'partial'
    partialResult.rooms[0].floor.calculationEligibility = 'review_required'
    partialResult.rooms[0].readiness = {
      floorArea: 'review_required',
      grossWallArea: 'review_required',
      netWallArea: 'review_required',
    }
    partialResult.rooms[0].missingInputs = [{ code: 'scale_missing', targetId: 'room-1' }]
    const nonPlanResult = {
      ...structuredClone(completeResult),
      analysisStatus: 'not_floor_plan',
      rooms: [],
    }

    expect(schema?.safeParse(outcome(completeResult)).success).toBe(true)
    expect(schema?.safeParse(outcome(partialResult)).success).toBe(true)
    expect(schema?.safeParse(outcome(nonPlanResult)).success).toBe(true)
  })

  it('requires the strict research envelope and every final result property', () => {
    const schema = getAgentEntry(ROOM_MEASUREMENTS_AGENT_ID)?.schema
    const missingDrawing = structuredClone(completeResult) as Record<string, unknown>
    delete missingDrawing.drawing

    for (const invalid of [
      completeResult,
      { kind: 'research', data: { measurementSet: completeResult } },
      { kind: 'research', data: [completeResult] },
      outcome(completeResult, { extra: true }),
      outcome({ ...completeResult, extra: true }),
      outcome(missingDrawing),
    ]) {
      expect(schema?.safeParse(invalid).success).toBe(false)
    }
  })

  it('rejects invalid enums, coordinates, dimensions, and evidence bounds', () => {
    const schema = getAgentEntry(ROOM_MEASUREMENTS_AGENT_ID)?.schema
    const invalidStatus = structuredClone(completeResult)
    Reflect.set(invalidStatus, 'analysisStatus', 'ready')
    const invalidEligibility = structuredClone(completeResult)
    Reflect.set(invalidEligibility.rooms[0].readiness, 'floorArea', 'unknown')
    const invalidUnit = structuredClone(completeResult)
    Reflect.set(invalidUnit.drawing.globalCeilingHeight!, 'unit', 'px')
    const invalidPoint = structuredClone(completeResult)
    invalidPoint.rooms[0].floor.outerBoundary[0].x = 1.01
    const invalidEvidence = structuredClone(completeResult)
    invalidEvidence.drawing.declaredUnit.evidence[0] = {
      x: 0.95,
      y: 0.1,
      width: 0.1,
      height: 0.1,
    }
    const invalidPixels = structuredClone(completeResult)
    invalidPixels.drawing.imageWidthPx = 0

    for (const invalid of [
      invalidStatus,
      invalidEligibility,
      invalidUnit,
      invalidPoint,
      invalidEvidence,
      invalidPixels,
    ]) {
      expect(schema?.safeParse(outcome(invalid)).success).toBe(false)
    }
  })

  it('rejects collection and string bound overflow from the final contract', () => {
    const schema = getAgentEntry(ROOM_MEASUREMENTS_AGENT_ID)?.schema
    const tooManyRooms = structuredClone(completeResult)
    tooManyRooms.rooms = Array.from({ length: 101 }, () => structuredClone(completeResult.rooms[0]))
    const tooManyWalls = structuredClone(completeResult)
    tooManyWalls.rooms[0].walls = Array.from({ length: 129 }, (_, index) => ({
      id: `wall-${index}`,
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      length: null,
      heightProfile: 'unknown',
      startHeight: null,
      endHeight: null,
      usesGlobalHeight: false,
      calculationEligibility: 'review_required',
    }))
    const tooManyWarnings = structuredClone(completeResult)
    tooManyWarnings.warnings = Array.from({ length: 101 }, () => 'warning')
    const longWarning = structuredClone(completeResult)
    longWarning.warnings = ['w'.repeat(501)]
    const longId = structuredClone(completeResult)
    longId.rooms[0].id = 'r'.repeat(129)

    for (const invalid of [tooManyRooms, tooManyWalls, tooManyWarnings, longWarning, longId]) {
      expect(schema?.safeParse(outcome(invalid)).success).toBe(false)
    }
  })
})

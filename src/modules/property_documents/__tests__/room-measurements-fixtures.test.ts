import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import type { McpToolContext } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { ROOM_MEASUREMENTS_AGENT_ID, createRoomMeasurementsVisionTool } from '../ai-tools'
import {
  finalizeRoomMeasurementCandidate,
  roomMeasurementSetSchema,
  type RoomMeasurementCandidate,
  type RoomMeasurementSet,
} from '../room-measurements-contract'
import type { RoomMeasurementsVisionRuntime } from '../room-measurements-vision'

const SESSION_TOKEN = `sess_${'d'.repeat(32)}`
const FIXTURE_DIR = path.join(
  process.cwd(),
  'src/modules/property_documents/__tests__/fixtures/room-measurements',
)
const temporaryRoots: string[] = []

type CandidateLinearMeasurement = NonNullable<
  RoomMeasurementCandidate['drawing']['globalCeilingHeight']
>
type EvidenceBox = CandidateLinearMeasurement['evidence'][number]
type Point = RoomMeasurementCandidate['rooms'][number]['floor']['outerBoundary'][number]
type FixtureCase = {
  fileName: string
  sha256: string
  width: number
  height: number
  candidate: () => RoomMeasurementCandidate
  assertResult: (result: RoomMeasurementSet) => void
}

function evidence(x: number, y: number, width: number, height: number): EvidenceBox[] {
  return [{ x, y, width, height }]
}

function printedLength(
  id: string,
  value: number,
  sourceText: string,
  measurementEvidence: EvidenceBox[],
): CandidateLinearMeasurement {
  return {
    id,
    value,
    unit: 'm',
    unitSource: 'label',
    method: 'printed',
    sourceText,
    evidence: measurementEvidence,
    calibrationId: null,
    confidence: 0.99,
  }
}

function wall(
  id: string,
  start: Point,
  end: Point,
  length: CandidateLinearMeasurement,
): RoomMeasurementCandidate['rooms'][number]['walls'][number] {
  return {
    id,
    start,
    end,
    length,
    heightProfile: 'constant',
    startHeight: null,
    endHeight: null,
    usesGlobalHeight: true,
  }
}

function completeRectangleCandidate(): RoomMeasurementCandidate {
  const boundary = [
    { x: 220 / 1200, y: 190 / 800 },
    { x: 980 / 1200, y: 190 / 800 },
    { x: 980 / 1200, y: 610 / 800 },
    { x: 220 / 1200, y: 610 / 800 },
  ]
  const horizontalEvidence = evidence(0.45, 0.1, 0.1, 0.05)
  const verticalEvidence = evidence(0.08, 0.43, 0.06, 0.14)
  return {
    sceneKind: 'floor_plan',
    drawing: {
      declaredUnit: {
        value: 'm',
        sourceText: 'DIMENSIONS IN METRES',
        evidence: evidence(0.04, 0.91, 0.23, 0.05),
        confidence: 0.99,
      },
      declaredScale: null,
      calibrations: [],
      globalCeilingHeight: printedLength(
        'rectangle-ceiling',
        2.7,
        'CEILING 2.70 m',
        evidence(0.42, 0.52, 0.17, 0.05),
      ),
      confidence: 0.99,
      warnings: [],
    },
    rooms: [
      {
        id: 'living-room',
        printedName: 'LIVING ROOM',
        location: 'centre of the drawing',
        floor: {
          outerBoundary: boundary,
          holes: [],
          printedArea: {
            id: 'living-room-area',
            value: 31.92,
            unit: 'm2',
            unitSource: 'label',
            method: 'printed',
            basis: 'net',
            sourceText: '31.92 m2',
            evidence: evidence(0.44, 0.45, 0.13, 0.05),
            confidence: 0.99,
          },
        },
        walls: [
          wall(
            'rectangle-top',
            boundary[0]!,
            boundary[1]!,
            printedLength('rectangle-top-length', 7.6, '7.60 m', horizontalEvidence),
          ),
          wall(
            'rectangle-right',
            boundary[1]!,
            boundary[2]!,
            printedLength(
              'rectangle-right-length',
              4.2,
              '4.20 m',
              evidence(0.89, 0.43, 0.06, 0.14),
            ),
          ),
          wall(
            'rectangle-bottom',
            boundary[2]!,
            boundary[3]!,
            printedLength(
              'rectangle-bottom-length',
              7.6,
              '7.60 m',
              evidence(0.45, 0.84, 0.1, 0.05),
            ),
          ),
          wall(
            'rectangle-left',
            boundary[3]!,
            boundary[0]!,
            printedLength('rectangle-left-length', 4.2, '4.20 m', verticalEvidence),
          ),
        ],
        openings: [],
        confidence: 0.99,
        warnings: [],
      },
    ],
    warnings: [],
  }
}

function irregularScaledCandidate(): RoomMeasurementCandidate {
  const boundary = [
    { x: 210 / 1400, y: 180 / 900 },
    { x: 910 / 1400, y: 180 / 900 },
    { x: 910 / 1400, y: 390 / 900 },
    { x: 700 / 1400, y: 390 / 900 },
    { x: 700 / 1400, y: 670 / 900 },
    { x: 210 / 1400, y: 670 / 900 },
  ]
  const lengths = [10, 3, 3, 4, 7, 7]
  const sourceTexts = ['10.00 m', '3.00 m', '3.00 m', '4.00 m', '7.00 m', '7.00 m']
  const measurementEvidence = [
    evidence(0.35, 0.08, 0.1, 0.05),
    evidence(0.7, 0.26, 0.06, 0.14),
    evidence(0.54, 0.5, 0.09, 0.05),
    evidence(0.55, 0.54, 0.06, 0.14),
    evidence(0.29, 0.81, 0.08, 0.05),
    evidence(0.06, 0.4, 0.05, 0.14),
  ]
  return {
    sceneKind: 'floor_plan',
    drawing: {
      declaredUnit: {
        value: 'm',
        sourceText: 'DIMENSIONS IN METRES',
        evidence: evidence(0.75, 0.77, 0.2, 0.05),
        confidence: 0.99,
      },
      declaredScale: {
        sourceText: 'SCALE 1:50',
        evidence: evidence(0.75, 0.68, 0.14, 0.05),
        confidence: 0.99,
      },
      calibrations: [
        {
          id: 'printed-scale-bar',
          kind: 'scale_bar',
          sourceText: '0 1 2 3 4 metres',
          evidence: evidence(0.09, 0.85, 0.29, 0.09),
          start: { x: 140 / 1400, y: 790 / 900 },
          end: { x: 420 / 1400, y: 790 / 900 },
          realLength: printedLength(
            'scale-bar-length',
            4,
            '0 1 2 3 4 metres',
            evidence(0.09, 0.85, 0.29, 0.09),
          ),
          confidence: 0.99,
        },
      ],
      globalCeilingHeight: printedLength(
        'studio-ceiling',
        2.8,
        'CEILING 2.80 m',
        evidence(0.28, 0.43, 0.17, 0.05),
      ),
      confidence: 0.99,
      warnings: [],
    },
    rooms: [
      {
        id: 'studio',
        printedName: 'STUDIO',
        location: 'left and centre of the drawing',
        floor: { outerBoundary: boundary, holes: [], printedArea: null },
        walls: boundary.map((start, index) =>
          wall(
            `irregular-wall-${index + 1}`,
            start,
            boundary[(index + 1) % boundary.length]!,
            printedLength(
              `irregular-wall-${index + 1}-length`,
              lengths[index]!,
              sourceTexts[index]!,
              measurementEvidence[index]!,
            ),
          ),
        ),
        openings: [],
        confidence: 0.99,
        warnings: [],
      },
    ],
    warnings: [],
  }
}

function notFloorPlanCandidate(): RoomMeasurementCandidate {
  return {
    sceneKind: 'not_floor_plan',
    drawing: {
      declaredUnit: null,
      declaredScale: null,
      calibrations: [],
      globalCeilingHeight: null,
      confidence: 0.99,
      warnings: [],
    },
    rooms: [],
    warnings: [],
  }
}

const fixtures: FixtureCase[] = [
  {
    fileName: 'complete-rectangle.png',
    sha256: '3b1d87de7e33eb9f75b598683038fc42573687a12becd6fbb89d572c5ddb7ca0',
    width: 1200,
    height: 800,
    candidate: completeRectangleCandidate,
    assertResult(result) {
      expect(result.analysisStatus).toBe('complete')
      expect(result.rooms).toHaveLength(1)
      expect(result.rooms[0]?.floor.printedArea).toMatchObject({
        value: 31.92,
        sourceText: '31.92 m2',
        calculationEligibility: 'eligible',
      })
      expect(result.rooms[0]?.walls.map((item) => item.length?.evidence.length)).toEqual([1, 1, 1, 1])
    },
  },
  {
    fileName: 'irregular-scaled-room.png',
    sha256: 'f8c9287c2f8d145178aabc4701d3cf7e2f75a7d09a5c02c774320b55da08e130',
    width: 1400,
    height: 900,
    candidate: irregularScaledCandidate,
    assertResult(result) {
      expect(result.analysisStatus).toBe('complete')
      expect(result.rooms[0]?.floor.outerBoundary).toHaveLength(6)
      expect(result.drawing.declaredScale).toMatchObject({ sourceText: 'SCALE 1:50' })
      expect(result.drawing.calibrations).toEqual([
        expect.objectContaining({
          kind: 'scale_bar',
          sourceText: '0 1 2 3 4 metres',
          calculationEligibility: 'eligible',
        }),
      ])
      expect(result.drawing.calibrations[0]?.evidence).toHaveLength(1)
    },
  },
  {
    fileName: 'not-floor-plan.png',
    sha256: '99e3583168b18226c62851b3b5a63d7942730ce47c6bde25f208eb1678b4e6c8',
    width: 1100,
    height: 700,
    candidate: notFloorPlanCandidate,
    assertResult(result) {
      expect(result.analysisStatus).toBe('not_floor_plan')
      expect(result.rooms).toEqual([])
      expect(result.drawing).toMatchObject({ declaredScale: null, calibrations: [] })
    },
  },
]

function context(): McpToolContext {
  const store = {
    resolveActiveAgentId: jest.fn(async () => ROOM_MEASUREMENTS_AGENT_ID),
    resolveActiveRunId: jest.fn(async () => 'fixture-run'),
  }
  return {
    tenantId: 'fixture-tenant',
    organizationId: 'fixture-organization',
    userId: 'fixture-user',
    userFeatures: ['agent_orchestrator.agents.run'],
    isSuperAdmin: false,
    sessionId: SESSION_TOKEN,
    container: { resolve: jest.fn(() => store) } as unknown as McpToolContext['container'],
  } as McpToolContext
}

async function stage(fileName: string): Promise<{ root: string; bytes: Buffer }> {
  const root = await mkdtemp(path.join(tmpdir(), 'room-measurement-fixture-'))
  temporaryRoots.push(root)
  const inputDirectory = path.join(root, SESSION_TOKEN, 'in')
  await mkdir(path.join(root, SESSION_TOKEN, 'out'), { recursive: true })
  await mkdir(inputDirectory, { recursive: true })
  const fixturePath = path.join(FIXTURE_DIR, fileName)
  const bytes = await readFile(fixturePath)
  await copyFile(fixturePath, path.join(inputDirectory, 'floor-plan.png'))
  return { root, bytes }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('room measurement PNG fixtures', () => {
  it.each(fixtures)(
    'loads $fileName through the scoped tool and returns its strict observable outcome',
    async (fixture) => {
      const staged = await stage(fixture.fileName)
      expect(createHash('sha256').update(staged.bytes).digest('hex')).toBe(fixture.sha256)

      const analyzeImage = jest.fn<RoomMeasurementsVisionRuntime['analyzeImage']>(async (input) => {
        const encodedBytes = Buffer.from(input.dataUrl.split(',', 2)[1]!, 'base64')
        expect(input.dataUrl).toMatch(/^data:image\/png;base64,/)
        expect(createHash('sha256').update(encodedBytes).digest('hex')).toBe(fixture.sha256)
        expect(input.imageWidthPx).toBe(fixture.width)
        expect(input.imageHeightPx).toBe(fixture.height)
        return finalizeRoomMeasurementCandidate({
          candidate: fixture.candidate(),
          imageWidthPx: input.imageWidthPx,
          imageHeightPx: input.imageHeightPx,
        })
      })
      const tool = createRoomMeasurementsVisionTool({
        workspaceRoot: staged.root,
        containerWorkspaceRoot: '/home/opencode/work',
        analyzeImage,
      })

      const result = await tool.handler({}, context())

      expect(analyzeImage).toHaveBeenCalledTimes(1)
      expect(result.drawing).toMatchObject({
        imageWidthPx: fixture.width,
        imageHeightPx: fixture.height,
      })
      expect(roomMeasurementSetSchema.safeParse(result).success).toBe(true)
      fixture.assertResult(result)
    },
  )
})

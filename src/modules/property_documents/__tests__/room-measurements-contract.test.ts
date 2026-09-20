import { describe, expect, it } from '@jest/globals'
import {
  RoomMeasurementSemanticError,
  finalizeRoomMeasurementCandidate,
  roomMeasurementCandidateSchema,
  roomMeasurementSetSchema,
} from '../room-measurements-contract'
import type { RoomMeasurementCandidate, RoomMeasurementSet } from '../room-measurements-contract'

type CandidateLinearMeasurement = NonNullable<
  RoomMeasurementCandidate['drawing']['globalCeilingHeight']
>
type CandidateCalibration = RoomMeasurementCandidate['drawing']['calibrations'][number]
type CandidateWall = RoomMeasurementCandidate['rooms'][number]['walls'][number]
type CandidateRoom = RoomMeasurementCandidate['rooms'][number]

const IMAGE = { imageWidthPx: 1000, imageHeightPx: 1000 }
const evidence = [{ x: 0.02, y: 0.02, width: 0.08, height: 0.03 }]
const rectangle = [
  { x: 0.1, y: 0.1 },
  { x: 0.5, y: 0.1 },
  { x: 0.5, y: 0.4 },
  { x: 0.1, y: 0.4 },
]

function printedLength(
  id: string,
  value: number,
  unit: CandidateLinearMeasurement['unit'] = 'm',
): CandidateLinearMeasurement {
  return {
    id,
    value,
    unit,
    unitSource: 'label',
    method: 'printed',
    sourceText: `${value} ${unit}`,
    evidence,
    calibrationId: null,
    confidence: 0.95,
  }
}

function derivedLength(
  id: string,
  value: number,
  calibrationId = 'cal-1',
): CandidateLinearMeasurement {
  return {
    id,
    value,
    unit: 'm',
    unitSource: 'drawing',
    method: 'scale_derived',
    sourceText: null,
    evidence: [],
    calibrationId,
    confidence: 0.9,
  }
}

function calibration(id = 'cal-1', y = 0.8): CandidateCalibration {
  return {
    id,
    kind: 'dimension_anchor',
    sourceText: '4 m',
    evidence,
    start: { x: 0.1, y },
    end: { x: 0.5, y },
    realLength: printedLength(`${id}-length`, 4),
    confidence: 0.96,
  }
}

function wall(
  id: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  length: CandidateLinearMeasurement | null,
): CandidateWall {
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

function completeCandidate(): RoomMeasurementCandidate {
  return {
    sceneKind: 'floor_plan',
    drawing: {
      declaredUnit: {
        value: 'm',
        sourceText: 'Dimensions in metres',
        evidence,
        confidence: 0.98,
      },
      declaredScale: null,
      calibrations: [calibration()],
      globalCeilingHeight: printedLength('global-height', 2.5),
      confidence: 0.97,
      warnings: [],
    },
    rooms: [
      {
        id: 'room-1',
        printedName: 'Living room',
        location: 'centre',
        floor: {
          outerBoundary: rectangle,
          holes: [],
          printedArea: {
            id: 'area-1',
            value: 12,
            unit: 'm2',
            unitSource: 'label',
            method: 'printed',
            basis: 'net',
            sourceText: '12 m²',
            evidence,
            confidence: 0.99,
          },
        },
        walls: [
          wall('wall-1', rectangle[0], rectangle[1], derivedLength('wall-length-1', 4)),
          wall('wall-2', rectangle[1], rectangle[2], derivedLength('wall-length-2', 3)),
          wall('wall-3', rectangle[2], rectangle[3], derivedLength('wall-length-3', 4)),
          wall('wall-4', rectangle[3], rectangle[0], derivedLength('wall-length-4', 3)),
        ],
        openings: [
          {
            id: 'door-1',
            kind: 'door',
            wallId: 'wall-1',
            start: { x: 0.2, y: 0.1 },
            end: { x: 0.3, y: 0.1 },
            width: printedLength('door-width', 1),
            height: printedLength('door-height', 2.1),
            sillHeight: null,
          },
          {
            id: 'window-1',
            kind: 'window',
            wallId: 'wall-2',
            start: { x: 0.5, y: 0.2 },
            end: { x: 0.5, y: 0.3 },
            width: printedLength('window-width', 1),
            height: printedLength('window-height', 1.2),
            sillHeight: printedLength('window-sill', 0.8),
          },
        ],
        confidence: 0.96,
        warnings: [],
      },
    ],
    warnings: [],
  }
}

function secondRoomFrom(candidate: RoomMeasurementCandidate): CandidateRoom {
  const room = structuredClone(candidate.rooms[0])
  room.id = 'room-2'
  room.floor.printedArea = room.floor.printedArea
    ? { ...room.floor.printedArea, id: 'room-2-area' }
    : null
  room.floor.holes = room.floor.holes.map((hole, index) => ({
    ...hole,
    id: `room-2-hole-${index}`,
  }))
  const wallIdByOriginal = new Map<string, string>()
  room.walls = room.walls.map((item, index) => {
    const id = `room-2-wall-${index}`
    wallIdByOriginal.set(item.id, id)
    return {
      ...item,
      id,
      length: item.length ? { ...item.length, id: `room-2-wall-length-${index}` } : null,
      startHeight: item.startHeight
        ? { ...item.startHeight, id: `room-2-wall-start-height-${index}` }
        : null,
      endHeight: item.endHeight
        ? { ...item.endHeight, id: `room-2-wall-end-height-${index}` }
        : null,
    }
  })
  room.openings = room.openings.map((opening, index) => ({
    ...opening,
    id: `room-2-opening-${index}`,
    wallId: opening.wallId ? (wallIdByOriginal.get(opening.wallId) ?? null) : null,
    width: opening.width ? { ...opening.width, id: `room-2-opening-width-${index}` } : null,
    height: opening.height ? { ...opening.height, id: `room-2-opening-height-${index}` } : null,
    sillHeight: opening.sillHeight
      ? { ...opening.sillHeight, id: `room-2-opening-sill-${index}` }
      : null,
  }))
  return room
}

function finalize(candidate: RoomMeasurementCandidate): RoomMeasurementSet {
  return finalizeRoomMeasurementCandidate({ candidate, ...IMAGE })
}

function expectSemanticCode(candidate: unknown, code: string) {
  try {
    finalizeRoomMeasurementCandidate({ candidate: candidate as never, ...IMAGE })
    throw new Error('Expected semantic rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(RoomMeasurementSemanticError)
    expect((error as RoomMeasurementSemanticError).issues.map((issue) => issue.code)).toContain(code)
    expect((error as RoomMeasurementSemanticError).issues.length).toBeLessThanOrEqual(50)
  }
}

describe('room measurement schemas', () => {
  it('accepts only model-observable candidate fields and keeps the final result strict', () => {
    const candidate = completeCandidate()
    expect(roomMeasurementCandidateSchema.safeParse(candidate).success).toBe(true)
    expect(
      roomMeasurementCandidateSchema.safeParse({
        ...candidate,
        analysisStatus: 'complete',
      }).success,
    ).toBe(false)
    expect(
      roomMeasurementCandidateSchema.safeParse({
        ...candidate,
        rooms: [
          {
            ...candidate.rooms[0],
            readiness: { floorArea: 'eligible' },
          },
        ],
      }).success,
    ).toBe(false)

    const result = finalize(candidate)
    expect(roomMeasurementSetSchema.safeParse(result).success).toBe(true)
    expect(roomMeasurementSetSchema.safeParse({ ...result, modelVerdict: true }).success).toBe(false)
  })

  it('rejects invalid quantity kinds, non-positive or non-finite values, and out-of-bounds geometry', () => {
    const candidate = completeCandidate()
    expect(
      roomMeasurementCandidateSchema.safeParse({
        ...candidate,
        drawing: {
          ...candidate.drawing,
          globalCeilingHeight: { ...candidate.drawing.globalCeilingHeight, unit: 'm2' },
        },
      }).success,
    ).toBe(false)
    expect(
      roomMeasurementCandidateSchema.safeParse({
        ...candidate,
        drawing: {
          ...candidate.drawing,
          globalCeilingHeight: { ...candidate.drawing.globalCeilingHeight, value: 0 },
        },
      }).success,
    ).toBe(false)
    expect(
      roomMeasurementCandidateSchema.safeParse({
        ...candidate,
        drawing: {
          ...candidate.drawing,
          globalCeilingHeight: {
            ...candidate.drawing.globalCeilingHeight,
            value: Number.POSITIVE_INFINITY,
          },
        },
      }).success,
    ).toBe(false)
    expect(
      roomMeasurementCandidateSchema.safeParse({
        ...candidate,
        rooms: [
          {
            ...candidate.rooms[0],
            floor: {
              ...candidate.rooms[0].floor,
              outerBoundary: [{ x: 1.01, y: 0.1 }],
            },
          },
        ],

      }).success,
    ).toBe(false)
    expect(
      roomMeasurementCandidateSchema.safeParse({
        ...candidate,
        drawing: {
          ...candidate.drawing,
          declaredUnit: {
            ...candidate.drawing.declaredUnit,
            evidence: [{ x: 0.95, y: 0.1, width: 0.1, height: 0.1 }],
          },
        },
      }).success,
    ).toBe(false)
  })
})

describe('deterministic finalization', () => {
  it('makes an evidence-bearing net printed floor, ordered walls, door, and window complete', () => {
    const result = finalize(completeCandidate())

    expect(result).toMatchObject({
      schemaVersion: '1',
      analysisStatus: 'complete',
      drawing: { imageWidthPx: 1000, imageHeightPx: 1000 },
    })
    expect(result.rooms[0].readiness).toEqual({
      floorArea: 'eligible',
      grossWallArea: 'eligible',
      netWallArea: 'eligible',
    })
    expect(result.rooms[0].missingInputs).toEqual([])
    expect(result.rooms[0].floor.printedArea?.calculationEligibility).toBe('eligible')
    expect(result.rooms[0].walls.every((item) => item.calculationEligibility === 'eligible')).toBe(
      true,
    )
    expect(
      result.rooms[0].openings.every((item) => item.calculationEligibility === 'eligible'),
    ).toBe(true)
  })

  it('accepts a calibrated irregular polygon with one hole and matching calibrations', () => {
    const candidate = completeCandidate()
    const outerBoundary = [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.6, y: 0.35 },
      { x: 0.35, y: 0.55 },
      { x: 0.1, y: 0.4 },
    ]
    candidate.drawing.calibrations = [calibration('cal-1', 0.75), calibration('cal-2', 0.85)]
    candidate.rooms[0].floor = {
      outerBoundary,
      holes: [
        {
          id: 'shaft-1',
          boundary: [
            { x: 0.25, y: 0.2 },
            { x: 0.35, y: 0.2 },
            { x: 0.3, y: 0.3 },
          ],
        },
      ],
      printedArea: null,
    }
    candidate.rooms[0].walls = outerBoundary.map((start, index) => {
      const end = outerBoundary[(index + 1) % outerBoundary.length]
      const metres = Math.hypot((end.x - start.x) * 1000, (end.y - start.y) * 1000) * 0.01
      return wall(`wall-${index + 1}`, start, end, derivedLength(`wall-length-${index + 1}`, metres))
    })
    candidate.rooms[0].openings = []

    const result = finalize(candidate)
    expect(result.rooms[0].floor.calculationEligibility).toBe('eligible')
    expect(result.rooms[0].readiness).toEqual({
      floorArea: 'eligible',
      grossWallArea: 'eligible',
      netWallArea: 'eligible',
    })
    expect(result.drawing.calibrations.map((item) => item.calculationEligibility)).toEqual([
      'eligible',
      'eligible',
    ])
  })

  it('accepts replayed sloped wall heights', () => {
    const candidate = completeCandidate()
    candidate.rooms[0].walls[0] = {
      ...candidate.rooms[0].walls[0],
      heightProfile: 'sloped',
      startHeight: printedLength('slope-start', 2.4),
      endHeight: printedLength('slope-end', 3.1),
      usesGlobalHeight: false,
    }

    const result = finalize(candidate)
    expect(result.rooms[0].walls[0].calculationEligibility).toBe('eligible')
    expect(result.rooms[0].readiness.grossWallArea).toBe('eligible')
  })

  it.each([
    {
      name: 'missing scale',
      mutate(candidate: RoomMeasurementCandidate) {
        candidate.rooms[0].floor.printedArea = null
        candidate.drawing.calibrations = []
        candidate.rooms[0].walls = [
          wall('wall-1', rectangle[0], rectangle[1], printedLength('wall-length-1', 4)),
          wall('wall-2', rectangle[1], rectangle[2], printedLength('wall-length-2', 3)),
          wall('wall-3', rectangle[2], rectangle[3], printedLength('wall-length-3', 4)),
          wall('wall-4', rectangle[3], rectangle[0], printedLength('wall-length-4', 3)),
        ]
      },
      readiness: { floorArea: 'review_required' },
      codes: ['scale_missing'],
    },
    {
      name: 'incomplete floor boundary',
      mutate(candidate: RoomMeasurementCandidate) {
        candidate.rooms[0].floor.printedArea = null
        candidate.rooms[0].floor.outerBoundary = []
        candidate.rooms[0].walls = []
        candidate.rooms[0].openings = []
      },
      readiness: {
        floorArea: 'review_required',
        grossWallArea: 'review_required',
        netWallArea: 'review_required',
      },
      codes: ['floor_boundary_incomplete', 'wall_length_missing'],
    },
    {
      name: 'missing height',
      mutate(candidate: RoomMeasurementCandidate) {
        candidate.drawing.globalCeilingHeight = null
      },
      readiness: { grossWallArea: 'review_required', netWallArea: 'review_required' },
      codes: ['ceiling_height_missing'],
    },
    {
      name: 'ambiguous height scope',
      mutate(candidate: RoomMeasurementCandidate) {
        candidate.rooms[0].walls[0].usesGlobalHeight = false
      },
      readiness: { grossWallArea: 'review_required', netWallArea: 'review_required' },
      codes: ['height_scope_ambiguous'],
    },
    {
      name: 'missing wall length',
      mutate(candidate: RoomMeasurementCandidate) {
        candidate.rooms[0].walls[0].length = null
      },
      readiness: { grossWallArea: 'review_required', netWallArea: 'review_required' },
      codes: ['wall_length_missing'],
    },
    {
      name: 'incomplete opening',
      mutate(candidate: RoomMeasurementCandidate) {
        candidate.rooms[0].openings[0].width = null
        candidate.rooms[0].openings[0].height = null
        candidate.rooms[0].openings[0].wallId = null
      },
      readiness: { netWallArea: 'review_required' },
      codes: ['opening_width_missing', 'opening_height_missing', 'opening_wall_ambiguous'],
    },
  ])('returns partial with exact readiness and missing codes for $name', ({ mutate, readiness, codes }) => {
    const candidate = completeCandidate()
    mutate(candidate)

    const result = finalize(candidate)
    expect(result.analysisStatus).toBe('partial')
    expect(result.rooms[0].readiness).toMatchObject(readiness)
    expect(result.rooms[0].missingInputs.map((item) => item.code)).toEqual(codes)
  })

  it('reports a missing boundary when printed floor evidence cannot establish wall order', () => {
    const candidate = completeCandidate()
    candidate.rooms[0].floor.outerBoundary = []

    const result = finalize(candidate)
    expect(result.rooms[0].readiness).toEqual({
      floorArea: 'eligible',
      grossWallArea: 'review_required',
      netWallArea: 'review_required',
    })
    expect(result.rooms[0].missingInputs).toEqual([
      { code: 'floor_boundary_incomplete', targetId: 'room-1' },
    ])
  })

  it('computes scene statuses server-side', () => {
    const notPlan = completeCandidate()
    notPlan.sceneKind = 'not_floor_plan'
    notPlan.rooms = []
    expect(finalize(notPlan).analysisStatus).toBe('not_floor_plan')

    const unreadable = completeCandidate()
    unreadable.sceneKind = 'unreadable'
    unreadable.rooms = []
    expect(finalize(unreadable).analysisStatus).toBe('unreadable')

    const invalid = completeCandidate()
    invalid.sceneKind = 'not_floor_plan'
    expectSemanticCode(invalid, 'invalid_scene_rooms')
  })

  it('refuses a readable floor plan that traced no room', () => {
    const empty = completeCandidate()
    empty.rooms = []
    expectSemanticCode(empty, 'empty_floor_plan_rooms')
  })
})

describe('controlled semantic failures', () => {
  it('rejects duplicate IDs and invalid calibration references', () => {
    const duplicate = completeCandidate()
    duplicate.rooms[0].walls[1].id = duplicate.rooms[0].walls[0].id
    expectSemanticCode(duplicate, 'duplicate_id')

    const duplicateMeasurement = completeCandidate()
    duplicateMeasurement.rooms[0].floor.printedArea!.id = 'global-height'
    expectSemanticCode(duplicateMeasurement, 'duplicate_id')

    const unresolved = completeCandidate()
    unresolved.rooms[0].walls[0].length = derivedLength('wall-length-1', 4, 'missing')
    expectSemanticCode(unresolved, 'unresolved_reference')

    const selfReference = completeCandidate()
    selfReference.drawing.calibrations[0].realLength.calibrationId = 'cal-1'
    expectSemanticCode(selfReference, 'self_reference')
  })

  it('rejects wall, opening, and hole IDs duplicated across rooms', () => {
    const duplicateWall = completeCandidate()
    const wallRoom = secondRoomFrom(duplicateWall)
    wallRoom.walls[0].id = duplicateWall.rooms[0].walls[0].id
    wallRoom.openings = []
    duplicateWall.rooms.push(wallRoom)
    expectSemanticCode(duplicateWall, 'duplicate_id')

    const duplicateOpening = completeCandidate()
    const openingRoom = secondRoomFrom(duplicateOpening)
    openingRoom.openings[0].id = duplicateOpening.rooms[0].openings[0].id
    duplicateOpening.rooms.push(openingRoom)
    expectSemanticCode(duplicateOpening, 'duplicate_id')

    const duplicateHole = completeCandidate()
    duplicateHole.rooms[0].floor.holes = [
      {
        id: 'shaft-1',
        boundary: [
          { x: 0.2, y: 0.2 },
          { x: 0.3, y: 0.2 },
          { x: 0.25, y: 0.3 },
        ],
      },
    ]
    const holeRoom = secondRoomFrom(duplicateHole)
    holeRoom.floor.holes[0].id = 'shaft-1'
    duplicateHole.rooms.push(holeRoom)
    expectSemanticCode(duplicateHole, 'duplicate_id')
  })

  it('rejects false printed and drawing-unit provenance', () => {
    const noEvidence = completeCandidate()
    noEvidence.rooms[0].walls[0].length = {
      ...printedLength('wall-length-1', 4),
      evidence: [],
    }
    expectSemanticCode(noEvidence, 'invalid_provenance')

    const wrongDrawingUnit = completeCandidate()
    wrongDrawingUnit.rooms[0].walls[0].length = {
      ...derivedLength('wall-length-1', 4),
      unit: 'cm',
    }
    expectSemanticCode(wrongDrawingUnit, 'invalid_provenance')
  })

  it('rejects self-intersection, zero area, duplicate vertices, and invalid holes', () => {
    const selfIntersecting = completeCandidate()
    selfIntersecting.rooms[0].floor.outerBoundary = [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.5 },
      { x: 0.1, y: 0.5 },
      { x: 0.5, y: 0.1 },
    ]
    expectSemanticCode(selfIntersecting, 'invalid_topology')

    const zeroArea = completeCandidate()
    zeroArea.rooms[0].floor.outerBoundary = [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.2 },
      { x: 0.3, y: 0.3 },
    ]
    expectSemanticCode(zeroArea, 'invalid_topology')

    const duplicateVertex = completeCandidate()
    duplicateVertex.rooms[0].floor.outerBoundary = [rectangle[0], rectangle[1], rectangle[1]]
    expectSemanticCode(duplicateVertex, 'invalid_topology')

    const outsideHole = completeCandidate()
    outsideHole.rooms[0].floor.holes = [
      {
        id: 'outside',
        boundary: [
          { x: 0.6, y: 0.6 },
          { x: 0.7, y: 0.6 },
          { x: 0.65, y: 0.7 },
        ],
      },
    ]
    expectSemanticCode(outsideHole, 'invalid_topology')

    const intersectingHoles = completeCandidate()
    intersectingHoles.rooms[0].floor.holes = [
      {
        id: 'hole-1',
        boundary: [
          { x: 0.2, y: 0.2 },
          { x: 0.35, y: 0.2 },
          { x: 0.3, y: 0.32 },
        ],
      },
      {
        id: 'hole-2',
        boundary: [
          { x: 0.25, y: 0.18 },
          { x: 0.4, y: 0.25 },
          { x: 0.25, y: 0.3 },
        ],
      },
    ]
    expectSemanticCode(intersectingHoles, 'invalid_topology')

    const holeWithoutOuter = completeCandidate()
    holeWithoutOuter.rooms[0].floor.outerBoundary = []
    holeWithoutOuter.rooms[0].floor.holes = [
      {
        id: 'orphan-hole',
        boundary: [
          { x: 0.2, y: 0.2 },
          { x: 0.3, y: 0.2 },
          { x: 0.25, y: 0.3 },
        ],
      },
    ]
    expectSemanticCode(holeWithoutOuter, 'invalid_topology')
  })

  it('rejects unordered walls and cross-room opening references', () => {
    const unordered = completeCandidate()
    ;[unordered.rooms[0].walls[0], unordered.rooms[0].walls[1]] = [
      unordered.rooms[0].walls[1],
      unordered.rooms[0].walls[0],
    ]
    expectSemanticCode(unordered, 'unordered_walls')

    const crossRoom = completeCandidate()
    const secondRoom = structuredClone(crossRoom.rooms[0])
    secondRoom.id = 'room-2'
    secondRoom.walls = secondRoom.walls.map((item, index) => ({
      ...item,
      id: `room-2-wall-${index}`,
      length: item.length ? { ...item.length, id: `room-2-length-${index}` } : null,
    }))
    secondRoom.openings = []
    secondRoom.floor.printedArea = {
      ...secondRoom.floor.printedArea!,
      id: 'room-2-area',
    }
    crossRoom.rooms.push(secondRoom)
    crossRoom.rooms[0].openings[0].wallId = secondRoom.walls[0].id
    expectSemanticCode(crossRoom, 'cross_room_reference')
  })

  it('rejects calibration disagreement and derived-length replay beyond three percent', () => {
    const disagreement = completeCandidate()
    const second = calibration('cal-2', 0.85)
    second.realLength.value = 5
    disagreement.drawing.calibrations.push(second)
    expectSemanticCode(disagreement, 'calibration_disagreement')

    const replayMismatch = completeCandidate()
    replayMismatch.rooms[0].walls[0].length = derivedLength('wall-length-1', 4.2)
    expectSemanticCode(replayMismatch, 'measurement_replay_mismatch')
  })
})

describe('contract bounds', () => {
  it('enforces every collection maximum and max plus one', () => {
    const candidate = completeCandidate()
    const cases: Array<{
      maximum: number
      apply(value: unknown[]): unknown
      make(index: number): unknown
    }> = [
      {
        maximum: 100,
        apply: (value) => ({ ...candidate, rooms: value }),
        make: (index) => ({ ...candidate.rooms[0], id: `room-${index}` }),
      },
      {
        maximum: 20,
        apply: (value) => ({
          ...candidate,
          drawing: { ...candidate.drawing, calibrations: value },
        }),
        make: (index) => calibration(`cal-${index}`, 0.7 + index / 1000),
      },
      {
        maximum: 128,
        apply: (value) => ({
          ...candidate,
          rooms: [{ ...candidate.rooms[0], walls: value }],
        }),
        make: (index) => ({ ...candidate.rooms[0].walls[0], id: `wall-${index}` }),
      },
      {
        maximum: 64,
        apply: (value) => ({
          ...candidate,
          rooms: [{ ...candidate.rooms[0], openings: value }],
        }),
        make: (index) => ({ ...candidate.rooms[0].openings[0], id: `opening-${index}` }),
      },
      {
        maximum: 32,
        apply: (value) => ({
          ...candidate,
          rooms: [
            {
              ...candidate.rooms[0],
              floor: { ...candidate.rooms[0].floor, holes: value },
            },
          ],
        }),
        make: (index) => ({ id: `hole-${index}`, boundary: rectangle.slice(0, 3) }),
      },
      {
        maximum: 128,
        apply: (value) => ({
          ...candidate,
          rooms: [
            {
              ...candidate.rooms[0],
              floor: { ...candidate.rooms[0].floor, outerBoundary: value },
            },
          ],
        }),
        make: (index) => ({ x: index / 1000, y: 0.6 }),
      },
      {
        maximum: 128,
        apply: (value) => ({
          ...candidate,
          rooms: [
            {
              ...candidate.rooms[0],
              floor: {
                ...candidate.rooms[0].floor,
                holes: [{ id: 'bounded-hole', boundary: value }],
              },
            },
          ],
        }),
        make: (index) => ({ x: index / 1000, y: 0.6 }),
      },
    ]

    for (const { maximum, apply, make } of cases) {
      expect(
        roomMeasurementCandidateSchema.safeParse(apply(Array.from({ length: maximum }, (_, i) => make(i))))
          .success,
      ).toBe(true)
      expect(
        roomMeasurementCandidateSchema.safeParse(
          apply(Array.from({ length: maximum + 1 }, (_, i) => make(i))),
        ).success,
      ).toBe(false)
    }
  })

  it('enforces ring vertex bounds in the final caller schema', () => {
    const result = finalize(completeCandidate())
    const vertices = Array.from({ length: 128 }, (_, index) => ({
      x: index / 1000,
      y: 0.6,
    }))

    const outerAtMaximum = structuredClone(result)
    outerAtMaximum.rooms[0].floor.outerBoundary = vertices
    expect(roomMeasurementSetSchema.safeParse(outerAtMaximum).success).toBe(true)
    outerAtMaximum.rooms[0].floor.outerBoundary = [
      ...vertices,
      { x: 0.128, y: 0.6 },
    ]
    expect(roomMeasurementSetSchema.safeParse(outerAtMaximum).success).toBe(false)

    const holeAtMaximum = structuredClone(result)
    holeAtMaximum.rooms[0].floor.holes = [{ id: 'bounded-hole', boundary: vertices }]
    expect(roomMeasurementSetSchema.safeParse(holeAtMaximum).success).toBe(true)
    holeAtMaximum.rooms[0].floor.holes[0].boundary = [
      ...vertices,
      { x: 0.128, y: 0.6 },
    ]
    expect(roomMeasurementSetSchema.safeParse(holeAtMaximum).success).toBe(false)
  })

  it('enforces top-level, drawing, and room warning bounds', () => {
    const candidate = completeCandidate()
    for (const target of ['top', 'drawing', 'room'] as const) {
      const withWarnings = (warnings: string[]) => {
        const copy = structuredClone(candidate)
        if (target === 'top') copy.warnings = warnings
        if (target === 'drawing') copy.drawing.warnings = warnings
        if (target === 'room') copy.rooms[0].warnings = warnings
        return copy
      }
      expect(roomMeasurementCandidateSchema.safeParse(withWarnings(Array(100).fill('w'))).success).toBe(
        true,
      )
      expect(roomMeasurementCandidateSchema.safeParse(withWarnings(Array(101).fill('w'))).success).toBe(
        false,
      )
    }
  })

  it('enforces 128-character IDs and 500-character source and warning text', () => {
    const candidate = completeCandidate()
    candidate.rooms[0].id = 'i'.repeat(128)
    candidate.rooms[0].floor.printedArea!.sourceText = 's'.repeat(500)
    candidate.warnings = ['w'.repeat(500)]
    expect(roomMeasurementCandidateSchema.safeParse(candidate).success).toBe(true)

    const longId = structuredClone(candidate)
    longId.rooms[0].id = 'i'.repeat(129)
    expect(roomMeasurementCandidateSchema.safeParse(longId).success).toBe(false)

    const longSource = structuredClone(candidate)
    longSource.rooms[0].floor.printedArea!.sourceText = 's'.repeat(501)
    expect(roomMeasurementCandidateSchema.safeParse(longSource).success).toBe(false)

    const longWarning = structuredClone(candidate)
    longWarning.warnings = ['w'.repeat(501)]
    expect(roomMeasurementCandidateSchema.safeParse(longWarning).success).toBe(false)
  })
})

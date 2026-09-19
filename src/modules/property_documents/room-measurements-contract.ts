import { z } from 'zod'

const MAX_ROOMS = 100
const MAX_CALIBRATIONS = 20
const MAX_WALLS = 128
const MAX_OPENINGS = 64
const MAX_HOLES = 32
const MAX_WARNINGS = 100
const MAX_WARNING_LENGTH = 500
const MAX_ID_LENGTH = 128
const MAX_SOURCE_TEXT_LENGTH = 500
const MAX_ISSUES = 50
const RELATIVE_ERROR_TOLERANCE = 0.03
const WALL_ENDPOINT_TOLERANCE_PX = 2

const confidenceSchema = z.number().finite().min(0).max(1)
const idSchema = z.string().min(1).max(MAX_ID_LENGTH)
const sourceTextSchema = z.string().min(1).max(MAX_SOURCE_TEXT_LENGTH)
const optionalSourceTextSchema = z.string().max(MAX_SOURCE_TEXT_LENGTH).nullable()
const warningSchema = z.string().min(1).max(MAX_WARNING_LENGTH)
const warningsSchema = z.array(warningSchema).max(MAX_WARNINGS)
const positiveNumberSchema = z.number().finite().positive()
const normalizedNumberSchema = z.number().finite().min(0).max(1)
const linearUnitSchema = z.enum(['mm', 'cm', 'm', 'in', 'ft'])
const areaUnitSchema = z.enum(['mm2', 'cm2', 'm2', 'in2', 'ft2'])
const eligibilitySchema = z.enum(['eligible', 'review_required'])

const imagePointSchema = z
  .object({
    x: normalizedNumberSchema,
    y: normalizedNumberSchema,
  })
  .strict()

const evidenceBoxSchema = z
  .object({
    x: normalizedNumberSchema,
    y: normalizedNumberSchema,
    width: normalizedNumberSchema.refine((value) => value > 0, 'Width must be positive'),
    height: normalizedNumberSchema.refine((value) => value > 0, 'Height must be positive'),
  })
  .strict()
  .superRefine((box, context) => {
    if (box.x + box.width > 1) {
      context.addIssue({ code: 'custom', path: ['width'], message: 'Evidence box exceeds image width' })
    }
    if (box.y + box.height > 1) {
      context.addIssue({ code: 'custom', path: ['height'], message: 'Evidence box exceeds image height' })
    }
  })

const candidateLinearMeasurementSchema = z
  .object({
    id: idSchema,
    value: positiveNumberSchema,
    unit: linearUnitSchema,
    unitSource: z.enum(['label', 'drawing']),
    method: z.enum(['printed', 'scale_derived']),
    sourceText: optionalSourceTextSchema,
    evidence: z.array(evidenceBoxSchema),
    calibrationId: idSchema.nullable(),
    confidence: confidenceSchema,
  })
  .strict()

const candidateAreaMeasurementSchema = z
  .object({
    id: idSchema,
    value: positiveNumberSchema,
    unit: areaUnitSchema,
    unitSource: z.enum(['label', 'drawing']),
    method: z.literal('printed'),
    basis: z.enum(['gross', 'net', 'unknown']),
    sourceText: z.string().max(MAX_SOURCE_TEXT_LENGTH),
    evidence: z.array(evidenceBoxSchema),
    confidence: confidenceSchema,
  })
  .strict()

const candidateCalibrationSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['scale_bar', 'dimension_anchor']),
    sourceText: z.string().max(MAX_SOURCE_TEXT_LENGTH),
    evidence: z.array(evidenceBoxSchema),
    start: imagePointSchema,
    end: imagePointSchema,
    realLength: candidateLinearMeasurementSchema,
    confidence: confidenceSchema,
  })
  .strict()

const candidateHoleSchema = z
  .object({
    id: idSchema,
    boundary: z.array(imagePointSchema),
  })
  .strict()

const candidateWallSchema = z
  .object({
    id: idSchema,
    start: imagePointSchema,
    end: imagePointSchema,
    length: candidateLinearMeasurementSchema.nullable(),
    heightProfile: z.enum(['constant', 'sloped', 'unknown']),
    startHeight: candidateLinearMeasurementSchema.nullable(),
    endHeight: candidateLinearMeasurementSchema.nullable(),
    usesGlobalHeight: z.boolean(),
  })
  .strict()

const candidateOpeningSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['door', 'window', 'opening', 'unknown']),
    wallId: idSchema.nullable(),
    start: imagePointSchema.nullable(),
    end: imagePointSchema.nullable(),
    width: candidateLinearMeasurementSchema.nullable(),
    height: candidateLinearMeasurementSchema.nullable(),
    sillHeight: candidateLinearMeasurementSchema.nullable(),
  })
  .strict()

const candidateRoomSchema = z
  .object({
    id: idSchema,
    printedName: z.string().min(1).max(MAX_SOURCE_TEXT_LENGTH).nullable(),
    location: sourceTextSchema,
    floor: z
      .object({
        outerBoundary: z.array(imagePointSchema),
        holes: z.array(candidateHoleSchema).max(MAX_HOLES),
        printedArea: candidateAreaMeasurementSchema.nullable(),
      })
      .strict(),
    walls: z.array(candidateWallSchema).max(MAX_WALLS),
    openings: z.array(candidateOpeningSchema).max(MAX_OPENINGS),
    confidence: confidenceSchema,
    warnings: warningsSchema,
  })
  .strict()

const candidateSchema = z
  .object({
    sceneKind: z.enum(['floor_plan', 'not_floor_plan', 'unreadable']),
    drawing: z
      .object({
        declaredUnit: z
          .object({
            value: linearUnitSchema,
            sourceText: z.string().max(MAX_SOURCE_TEXT_LENGTH),
            evidence: z.array(evidenceBoxSchema),
            confidence: confidenceSchema,
          })
          .strict()
          .nullable(),
        declaredScale: z
          .object({
            sourceText: z.string().max(MAX_SOURCE_TEXT_LENGTH),
            evidence: z.array(evidenceBoxSchema),
            confidence: confidenceSchema,
          })
          .strict()
          .nullable(),
        calibrations: z.array(candidateCalibrationSchema).max(MAX_CALIBRATIONS),
        globalCeilingHeight: candidateLinearMeasurementSchema.nullable(),
        confidence: confidenceSchema,
        warnings: warningsSchema,
      })
      .strict(),
    rooms: z.array(candidateRoomSchema).max(MAX_ROOMS),
    warnings: warningsSchema,
  })
  .strict()

export type RoomMeasurementCandidate = z.infer<typeof candidateSchema>
export const roomMeasurementCandidateSchema: z.ZodType<RoomMeasurementCandidate> = candidateSchema

const linearMeasurementSchema = candidateLinearMeasurementSchema
  .extend({ calculationEligibility: eligibilitySchema })
  .strict()
const areaMeasurementSchema = candidateAreaMeasurementSchema
  .extend({ calculationEligibility: eligibilitySchema })
  .strict()
const calibrationSchema = candidateCalibrationSchema
  .omit({ realLength: true })
  .extend({
    realLength: linearMeasurementSchema,
    calculationEligibility: eligibilitySchema,
  })
  .strict()
const holeSchema = candidateHoleSchema
const wallSchema = candidateWallSchema
  .omit({ length: true, startHeight: true, endHeight: true })
  .extend({
    length: linearMeasurementSchema.nullable(),
    startHeight: linearMeasurementSchema.nullable(),
    endHeight: linearMeasurementSchema.nullable(),
    calculationEligibility: eligibilitySchema,
  })
  .strict()
const openingSchema = candidateOpeningSchema
  .omit({ width: true, height: true, sillHeight: true })
  .extend({
    width: linearMeasurementSchema.nullable(),
    height: linearMeasurementSchema.nullable(),
    sillHeight: linearMeasurementSchema.nullable(),
    calculationEligibility: eligibilitySchema,
  })
  .strict()
const missingInputSchema = z
  .object({
    code: z.enum([
      'scale_missing',
      'floor_boundary_incomplete',
      'ceiling_height_missing',
      'height_scope_ambiguous',
      'wall_length_missing',
      'opening_width_missing',
      'opening_height_missing',
      'opening_wall_ambiguous',
    ]),
    targetId: idSchema.nullable(),
  })
  .strict()
const roomSchema = candidateRoomSchema
  .omit({ floor: true, walls: true, openings: true })
  .extend({
    floor: z
      .object({
        outerBoundary: z.array(imagePointSchema),
        holes: z.array(holeSchema).max(MAX_HOLES),
        printedArea: areaMeasurementSchema.nullable(),
        calculationEligibility: eligibilitySchema,
      })
      .strict(),
    walls: z.array(wallSchema).max(MAX_WALLS),
    openings: z.array(openingSchema).max(MAX_OPENINGS),
    readiness: z
      .object({
        floorArea: eligibilitySchema,
        grossWallArea: eligibilitySchema,
        netWallArea: eligibilitySchema,
      })
      .strict(),
    missingInputs: z.array(missingInputSchema),
  })
  .strict()

const resultSchema = z
  .object({
    schemaVersion: z.literal('1'),
    analysisStatus: z.enum(['complete', 'partial', 'not_floor_plan', 'unreadable']),
    drawing: z
      .object({
        imageWidthPx: z.number().int().positive(),
        imageHeightPx: z.number().int().positive(),
        declaredUnit: candidateSchema.shape.drawing.shape.declaredUnit,
        declaredScale: candidateSchema.shape.drawing.shape.declaredScale,
        calibrations: z.array(calibrationSchema).max(MAX_CALIBRATIONS),
        globalCeilingHeight: linearMeasurementSchema.nullable(),
        confidence: confidenceSchema,
        warnings: warningsSchema,
      })
      .strict(),
    rooms: z.array(roomSchema).max(MAX_ROOMS),
    warnings: warningsSchema,
  })
  .strict()

export type RoomMeasurementSet = z.infer<typeof resultSchema>
export const roomMeasurementSetSchema: z.ZodType<RoomMeasurementSet> = resultSchema

type ImagePoint = z.infer<typeof imagePointSchema>
type EvidenceBox = z.infer<typeof evidenceBoxSchema>
type CandidateLinearMeasurement = z.infer<typeof candidateLinearMeasurementSchema>
type CandidateAreaMeasurement = z.infer<typeof candidateAreaMeasurementSchema>
type CandidateRoom = z.infer<typeof candidateRoomSchema>
type SemanticIssue = { code: string; path: string; message: string }
type MissingInput = z.infer<typeof missingInputSchema>

export class RoomMeasurementSemanticError extends Error {
  readonly issues: ReadonlyArray<SemanticIssue>

  constructor(issues: ReadonlyArray<SemanticIssue>) {
    super('Room measurement candidate violates semantic invariants')
    this.name = 'RoomMeasurementSemanticError'
    this.issues = issues.slice(0, MAX_ISSUES)
  }
}

function issue(code: string, path: string, message: string): SemanticIssue {
  return { code, path, message: message.slice(0, MAX_WARNING_LENGTH) }
}

function pathOf(parts: PropertyKey[]): string {
  if (parts.length === 0) return '$'
  return parts.reduce<string>((path, part) => {
    if (typeof part === 'number') return `${path}[${part}]`
    return path === '$' ? `$.${String(part)}` : `${path}.${String(part)}`
  }, '$')
}

function throwIssues(issues: SemanticIssue[]): void {
  if (issues.length > 0) throw new RoomMeasurementSemanticError(issues)
}

function hasVisibleEvidence(sourceText: string | null, evidenceBoxes: EvidenceBox[]): boolean {
  return sourceText !== null && sourceText.trim().length > 0 && evidenceBoxes.length > 0
}

function toMetres(value: number, unit: z.infer<typeof linearUnitSchema>): number {
  switch (unit) {
    case 'mm':
      return value / 1000
    case 'cm':
      return value / 100
    case 'm':
      return value
    case 'in':
      return value * 0.0254
    case 'ft':
      return value * 0.3048
  }
}

function relativeError(actual: number, replayed: number): number {
  return Math.abs(actual - replayed) / Math.max(Math.abs(actual), Math.abs(replayed))
}

function pixelDistance(
  first: ImagePoint,
  second: ImagePoint,
  imageWidthPx: number,
  imageHeightPx: number,
): number {
  return Math.hypot(
    (second.x - first.x) * imageWidthPx,
    (second.y - first.y) * imageHeightPx,
  )
}

function signedRingArea(points: ImagePoint[]): number {
  let twiceArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    twiceArea += current.x * next.y - next.x * current.y
  }
  return twiceArea / 2
}

function orientation(first: ImagePoint, second: ImagePoint, third: ImagePoint): number {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x)
}

function pointOnSegment(point: ImagePoint, start: ImagePoint, end: ImagePoint): boolean {
  const epsilon = 1e-12
  return (
    Math.abs(orientation(start, end, point)) <= epsilon &&
    point.x >= Math.min(start.x, end.x) - epsilon &&
    point.x <= Math.max(start.x, end.x) + epsilon &&
    point.y >= Math.min(start.y, end.y) - epsilon &&
    point.y <= Math.max(start.y, end.y) + epsilon
  )
}

function segmentsIntersect(
  firstStart: ImagePoint,
  firstEnd: ImagePoint,
  secondStart: ImagePoint,
  secondEnd: ImagePoint,
): boolean {
  const firstSideStart = orientation(firstStart, firstEnd, secondStart)
  const firstSideEnd = orientation(firstStart, firstEnd, secondEnd)
  const secondSideStart = orientation(secondStart, secondEnd, firstStart)
  const secondSideEnd = orientation(secondStart, secondEnd, firstEnd)
  const epsilon = 1e-12

  if (
    ((firstSideStart > epsilon && firstSideEnd < -epsilon) ||
      (firstSideStart < -epsilon && firstSideEnd > epsilon)) &&
    ((secondSideStart > epsilon && secondSideEnd < -epsilon) ||
      (secondSideStart < -epsilon && secondSideEnd > epsilon))
  ) {
    return true
  }

  return (
    (Math.abs(firstSideStart) <= epsilon && pointOnSegment(secondStart, firstStart, firstEnd)) ||
    (Math.abs(firstSideEnd) <= epsilon && pointOnSegment(secondEnd, firstStart, firstEnd)) ||
    (Math.abs(secondSideStart) <= epsilon && pointOnSegment(firstStart, secondStart, secondEnd)) ||
    (Math.abs(secondSideEnd) <= epsilon && pointOnSegment(firstEnd, secondStart, secondEnd))
  )
}

function ringSelfIntersects(points: ImagePoint[]): boolean {
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length
      if (first === second || firstNext === second || secondNext === first) continue
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext])) {
        return true
      }
    }
  }
  return false
}

function ringsIntersect(first: ImagePoint[], second: ImagePoint[]): boolean {
  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
    const firstNext = (firstIndex + 1) % first.length
    for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
      const secondNext = (secondIndex + 1) % second.length
      if (
        segmentsIntersect(
          first[firstIndex],
          first[firstNext],
          second[secondIndex],
          second[secondNext],
        )
      ) {
        return true
      }
    }
  }
  return false
}

function pointStrictlyInsideRing(point: ImagePoint, ring: ImagePoint[]): boolean {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentPoint = ring[index]
    const previousPoint = ring[previous]
    if (pointOnSegment(point, previousPoint, currentPoint)) return false
    const crosses =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x
    if (crosses) inside = !inside
  }
  return inside
}

function validateCompleteRing(points: ImagePoint[], path: string, issues: SemanticIssue[]): void {
  if (points.length < 3) {
    issues.push(issue('invalid_topology', path, 'A returned boundary must contain at least three vertices'))
    return
  }
  const unique = new Set(points.map((point) => `${point.x}:${point.y}`))
  if (unique.size !== points.length) {
    issues.push(issue('invalid_topology', path, 'Boundary vertices must be unique'))
  }
  if (Math.abs(signedRingArea(points)) <= 1e-12) {
    issues.push(issue('invalid_topology', path, 'Boundary has zero area'))
  }
  if (ringSelfIntersects(points)) {
    issues.push(issue('invalid_topology', path, 'Boundary self-intersects'))
  }
}

function validateRoomTopology(room: CandidateRoom, roomIndex: number, issues: SemanticIssue[]): void {
  const outer = room.floor.outerBoundary
  const floorPath = `$.rooms[${roomIndex}].floor`
  if (outer.length > 0) validateCompleteRing(outer, `${floorPath}.outerBoundary`, issues)

  for (let holeIndex = 0; holeIndex < room.floor.holes.length; holeIndex += 1) {
    const hole = room.floor.holes[holeIndex]
    validateCompleteRing(hole.boundary, `${floorPath}.holes[${holeIndex}].boundary`, issues)
    if (
      outer.length >= 3 &&
      (hole.boundary.some((point) => !pointStrictlyInsideRing(point, outer)) ||
        ringsIntersect(outer, hole.boundary))
    ) {
      issues.push(
        issue('invalid_topology', `${floorPath}.holes[${holeIndex}]`, 'Hole must lie inside the outer boundary'),
      )
    }
  }

  for (let first = 0; first < room.floor.holes.length; first += 1) {
    for (let second = first + 1; second < room.floor.holes.length; second += 1) {
      const firstBoundary = room.floor.holes[first].boundary
      const secondBoundary = room.floor.holes[second].boundary
      if (
        firstBoundary.length >= 3 &&
        secondBoundary.length >= 3 &&
        (ringsIntersect(firstBoundary, secondBoundary) ||
          pointStrictlyInsideRing(firstBoundary[0], secondBoundary) ||
          pointStrictlyInsideRing(secondBoundary[0], firstBoundary))
      ) {
        issues.push(
          issue(
            'invalid_topology',
            `${floorPath}.holes[${second}]`,
            'Room holes must not intersect or overlap',
          ),
        )
      }
    }
  }
}

function checkUniqueIds(
  items: ReadonlyArray<{ id: string }>,
  path: string,
  issues: SemanticIssue[],
): void {
  const seen = new Set<string>()
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      issues.push(issue('duplicate_id', `${path}[${index}].id`, `Duplicate ID '${item.id}'`))
    }
    seen.add(item.id)
  })
}

function allMeasurements(
  candidate: RoomMeasurementCandidate,
): Array<CandidateLinearMeasurement | CandidateAreaMeasurement> {
  const measurements: Array<CandidateLinearMeasurement | CandidateAreaMeasurement> = []
  for (const calibration of candidate.drawing.calibrations) measurements.push(calibration.realLength)
  if (candidate.drawing.globalCeilingHeight) measurements.push(candidate.drawing.globalCeilingHeight)
  for (const room of candidate.rooms) {
    if (room.floor.printedArea) measurements.push(room.floor.printedArea)
    for (const wallItem of room.walls) {
      if (wallItem.length) measurements.push(wallItem.length)
      if (wallItem.startHeight) measurements.push(wallItem.startHeight)
      if (wallItem.endHeight) measurements.push(wallItem.endHeight)
    }
    for (const opening of room.openings) {
      if (opening.width) measurements.push(opening.width)
      if (opening.height) measurements.push(opening.height)
      if (opening.sillHeight) measurements.push(opening.sillHeight)
    }
  }
  return measurements
}

function validateIdsAndReferences(candidate: RoomMeasurementCandidate, issues: SemanticIssue[]): void {
  checkUniqueIds(candidate.drawing.calibrations, '$.drawing.calibrations', issues)
  checkUniqueIds(candidate.rooms, '$.rooms', issues)
  checkUniqueIds(allMeasurements(candidate), '$.measurements', issues)

  const calibrationIds = new Set(candidate.drawing.calibrations.map((item) => item.id))
  const wallOwners = new Map<string, Set<string>>()
  candidate.rooms.forEach((room, roomIndex) => {
    checkUniqueIds(room.floor.holes, `$.rooms[${roomIndex}].floor.holes`, issues)
    checkUniqueIds(room.walls, `$.rooms[${roomIndex}].walls`, issues)
    checkUniqueIds(room.openings, `$.rooms[${roomIndex}].openings`, issues)
    for (const wallItem of room.walls) {
      const owners = wallOwners.get(wallItem.id) ?? new Set<string>()
      owners.add(room.id)
      wallOwners.set(wallItem.id, owners)
    }
  })

  for (const calibration of candidate.drawing.calibrations) {
    if (calibration.realLength.calibrationId === calibration.id) {
      issues.push(
        issue(
          'self_reference',
          `$.drawing.calibrations.${calibration.id}.realLength.calibrationId`,
          'A calibration cannot reference itself',
        ),
      )
    }
  }

  for (const measurement of allMeasurements(candidate)) {
    if (
      'calibrationId' in measurement &&
      measurement.calibrationId !== null &&
      !calibrationIds.has(measurement.calibrationId)
    ) {
      issues.push(
        issue(
          'unresolved_reference',
          `$.measurements.${measurement.id}.calibrationId`,
          `Unknown calibration '${measurement.calibrationId}'`,
        ),
      )
    }
  }

  candidate.rooms.forEach((room, roomIndex) => {
    const localWallIds = new Set(room.walls.map((item) => item.id))
    room.openings.forEach((opening, openingIndex) => {
      if (opening.wallId === null || localWallIds.has(opening.wallId)) return
      const owners = wallOwners.get(opening.wallId)
      issues.push(
        issue(
          owners && !owners.has(room.id) ? 'cross_room_reference' : 'unresolved_reference',
          `$.rooms[${roomIndex}].openings[${openingIndex}].wallId`,
          owners ? 'Opening wall belongs to another room' : `Unknown wall '${opening.wallId}'`,
        ),
      )
    })
  })
}

function validateDrawingProvenance(
  candidate: RoomMeasurementCandidate,
  issues: SemanticIssue[],
): void {
  const { declaredUnit, declaredScale } = candidate.drawing
  if (declaredUnit && !hasVisibleEvidence(declaredUnit.sourceText, declaredUnit.evidence)) {
    issues.push(
      issue('invalid_provenance', '$.drawing.declaredUnit', 'A declared unit needs visible source text and evidence'),
    )
  }
  if (declaredScale && !hasVisibleEvidence(declaredScale.sourceText, declaredScale.evidence)) {
    issues.push(
      issue('invalid_provenance', '$.drawing.declaredScale', 'A declared scale needs visible source text and evidence'),
    )
  }
  candidate.drawing.calibrations.forEach((calibration, index) => {
    if (!hasVisibleEvidence(calibration.sourceText, calibration.evidence)) {
      issues.push(
        issue(
          'invalid_provenance',
          `$.drawing.calibrations[${index}]`,
          'A calibration needs visible source text and evidence',
        ),
      )
    }
    if (
      calibration.realLength.method !== 'printed' ||
      calibration.realLength.calibrationId !== null ||
      !hasVisibleEvidence(calibration.realLength.sourceText, calibration.realLength.evidence)
    ) {
      issues.push(
        issue(
          'invalid_provenance',
          `$.drawing.calibrations[${index}].realLength`,
          'Calibration real length must be visibly printed and cannot cite a calibration',
        ),
      )
    }
  })
  const globalHeight = candidate.drawing.globalCeilingHeight
  if (
    globalHeight &&
    (globalHeight.method !== 'printed' ||
      globalHeight.calibrationId !== null ||
      !hasVisibleEvidence(globalHeight.sourceText, globalHeight.evidence))
  ) {
    issues.push(
      issue(
        'invalid_provenance',
        '$.drawing.globalCeilingHeight',
        'Global ceiling height must be visibly printed',
      ),
    )
  }
}

function expectedDrawingUnit(
  unit: CandidateLinearMeasurement['unit'] | CandidateAreaMeasurement['unit'],
): CandidateLinearMeasurement['unit'] {
  if (unit.endsWith('2')) return unit.slice(0, -1) as CandidateLinearMeasurement['unit']
  return unit as CandidateLinearMeasurement['unit']
}

function validateMeasurementProvenance(
  measurement: CandidateLinearMeasurement | CandidateAreaMeasurement,
  path: string,
  declaredUnit: RoomMeasurementCandidate['drawing']['declaredUnit'],
  issues: SemanticIssue[],
): void {
  if (measurement.method === 'printed') {
    const calibrationId = 'calibrationId' in measurement ? measurement.calibrationId : null
    if (!hasVisibleEvidence(measurement.sourceText, measurement.evidence) || calibrationId !== null) {
      issues.push(
        issue(
          'invalid_provenance',
          path,
          'A printed measurement needs exact source text and visible evidence without a calibration reference',
        ),
      )
    }
  } else if (measurement.calibrationId === null) {
    issues.push(
      issue('unresolved_reference', `${path}.calibrationId`, 'A scale-derived measurement needs a calibration'),
    )
  }

  if (
    measurement.unitSource === 'drawing' &&
    (!declaredUnit ||
      !hasVisibleEvidence(declaredUnit.sourceText, declaredUnit.evidence) ||
      expectedDrawingUnit(measurement.unit) !== declaredUnit.value)
  ) {
    issues.push(
      issue(
        'invalid_provenance',
        `${path}.unitSource`,
        'Drawing-sourced measurement unit must match an evidence-bearing declared unit',
      ),
    )
  }
}

function validateAllMeasurementProvenance(
  candidate: RoomMeasurementCandidate,
  issues: SemanticIssue[],
): void {
  const declaredUnit = candidate.drawing.declaredUnit
  candidate.drawing.calibrations.forEach((item, index) =>
    validateMeasurementProvenance(
      item.realLength,
      `$.drawing.calibrations[${index}].realLength`,
      declaredUnit,
      issues,
    ),
  )
  if (candidate.drawing.globalCeilingHeight) {
    validateMeasurementProvenance(
      candidate.drawing.globalCeilingHeight,
      '$.drawing.globalCeilingHeight',
      declaredUnit,
      issues,
    )
  }
  candidate.rooms.forEach((room, roomIndex) => {
    if (room.floor.printedArea) {
      validateMeasurementProvenance(
        room.floor.printedArea,
        `$.rooms[${roomIndex}].floor.printedArea`,
        declaredUnit,
        issues,
      )
    }
    room.walls.forEach((wallItem, wallIndex) => {
      for (const [field, measurement] of [
        ['length', wallItem.length],
        ['startHeight', wallItem.startHeight],
        ['endHeight', wallItem.endHeight],
      ] as const) {
        if (measurement) {
          validateMeasurementProvenance(
            measurement,
            `$.rooms[${roomIndex}].walls[${wallIndex}].${field}`,
            declaredUnit,
            issues,
          )
        }
      }
    })
    room.openings.forEach((opening, openingIndex) => {
      for (const [field, measurement] of [
        ['width', opening.width],
        ['height', opening.height],
        ['sillHeight', opening.sillHeight],
      ] as const) {
        if (measurement) {
          validateMeasurementProvenance(
            measurement,
            `$.rooms[${roomIndex}].openings[${openingIndex}].${field}`,
            declaredUnit,
            issues,
          )
        }
      }
    })
  })
}

function calibrationScales(
  candidate: RoomMeasurementCandidate,
  imageWidthPx: number,
  imageHeightPx: number,
  issues: SemanticIssue[],
): Map<string, number> {
  const scales = new Map<string, number>()
  candidate.drawing.calibrations.forEach((calibration, index) => {
    const pixels = pixelDistance(calibration.start, calibration.end, imageWidthPx, imageHeightPx)
    if (pixels <= 0) {
      issues.push(
        issue(
          'invalid_topology',
          `$.drawing.calibrations[${index}]`,
          'Calibration endpoints must be distinct',
        ),
      )
      return
    }
    scales.set(calibration.id, toMetres(calibration.realLength.value, calibration.realLength.unit) / pixels)
  })
  const entries = [...scales.entries()]
  for (let first = 0; first < entries.length; first += 1) {
    for (let second = first + 1; second < entries.length; second += 1) {
      if (relativeError(entries[first][1], entries[second][1]) > RELATIVE_ERROR_TOLERANCE) {
        issues.push(
          issue(
            'calibration_disagreement',
            '$.drawing.calibrations',
            `Calibrations '${entries[first][0]}' and '${entries[second][0]}' disagree`,
          ),
        )
      }
    }
  }
  return scales
}

function replayDerivedLength(
  measurement: CandidateLinearMeasurement | null,
  start: ImagePoint | null,
  end: ImagePoint | null,
  path: string,
  scales: Map<string, number>,
  imageWidthPx: number,
  imageHeightPx: number,
  issues: SemanticIssue[],
): void {
  if (!measurement || measurement.method !== 'scale_derived') return
  if (!start || !end || measurement.calibrationId === null) {
    issues.push(
      issue(
        'invalid_provenance',
        path,
        'A scale-derived segment length needs visible segment endpoints and one calibration',
      ),
    )
    return
  }
  const scale = scales.get(measurement.calibrationId)
  if (scale === undefined) return
  const actual = toMetres(measurement.value, measurement.unit)
  const replayed = pixelDistance(start, end, imageWidthPx, imageHeightPx) * scale
  if (relativeError(actual, replayed) > RELATIVE_ERROR_TOLERANCE) {
    issues.push(
      issue(
        'measurement_replay_mismatch',
        path,
        'Scale-derived length differs from geometry replay by more than three percent',
      ),
    )
  }
}

function validateReplays(
  candidate: RoomMeasurementCandidate,
  scales: Map<string, number>,
  imageWidthPx: number,
  imageHeightPx: number,
  issues: SemanticIssue[],
): void {
  candidate.rooms.forEach((room, roomIndex) => {
    room.walls.forEach((wallItem, wallIndex) => {
      replayDerivedLength(
        wallItem.length,
        wallItem.start,
        wallItem.end,
        `$.rooms[${roomIndex}].walls[${wallIndex}].length`,
        scales,
        imageWidthPx,
        imageHeightPx,
        issues,
      )
      for (const [field, measurement] of [
        ['startHeight', wallItem.startHeight],
        ['endHeight', wallItem.endHeight],
      ] as const) {
        if (measurement?.method === 'scale_derived') {
          issues.push(
            issue(
              'invalid_provenance',
              `$.rooms[${roomIndex}].walls[${wallIndex}].${field}`,
              'Scale-derived heights require explicit geometry that this contract does not expose',
            ),
          )
        }
      }
    })
    room.openings.forEach((opening, openingIndex) => {
      replayDerivedLength(
        opening.width,
        opening.start,
        opening.end,
        `$.rooms[${roomIndex}].openings[${openingIndex}].width`,
        scales,
        imageWidthPx,
        imageHeightPx,
        issues,
      )
      for (const [field, measurement] of [
        ['height', opening.height],
        ['sillHeight', opening.sillHeight],
      ] as const) {
        if (measurement?.method === 'scale_derived') {
          issues.push(
            issue(
              'invalid_provenance',
              `$.rooms[${roomIndex}].openings[${openingIndex}].${field}`,
              'Scale-derived heights require explicit geometry that this contract does not expose',
            ),
          )
        }
      }
    })
  })
}

function validateWallOrder(
  room: CandidateRoom,
  roomIndex: number,
  imageWidthPx: number,
  imageHeightPx: number,
  issues: SemanticIssue[],
): boolean {
  const boundary = room.floor.outerBoundary
  if (boundary.length < 3 || room.walls.length === 0) return false
  if (room.walls.length !== boundary.length) {
    issues.push(
      issue(
        'unordered_walls',
        `$.rooms[${roomIndex}].walls`,
        'Returned walls must cover every outer boundary edge exactly once',
      ),
    )
    return false
  }
  for (let index = 0; index < boundary.length; index += 1) {
    const wallItem = room.walls[index]
    const expectedStart = boundary[index]
    const expectedEnd = boundary[(index + 1) % boundary.length]
    if (
      pixelDistance(wallItem.start, expectedStart, imageWidthPx, imageHeightPx) >
        WALL_ENDPOINT_TOLERANCE_PX ||
      pixelDistance(wallItem.end, expectedEnd, imageWidthPx, imageHeightPx) >
        WALL_ENDPOINT_TOLERANCE_PX
    ) {
      issues.push(
        issue(
          'unordered_walls',
          `$.rooms[${roomIndex}].walls[${index}]`,
          'Wall endpoints do not match the corresponding boundary edge within two pixels',
        ),
      )
    }
  }
  return !issues.some((item) => item.code === 'unordered_walls')
}

function eligibleLinear(measurement: CandidateLinearMeasurement | null) {
  if (!measurement) return null
  return { ...measurement, calculationEligibility: 'eligible' as const }
}

function addMissing(missing: MissingInput[], entry: MissingInput): void {
  if (!missing.some((item) => item.code === entry.code && item.targetId === entry.targetId)) {
    missing.push(entry)
  }
}

function wallHeightEligible(
  wallItem: CandidateRoom['walls'][number],
  globalHeight: CandidateLinearMeasurement | null,
  missing: MissingInput[],
): boolean {
  if (wallItem.usesGlobalHeight) {
    if (
      wallItem.heightProfile !== 'constant' ||
      wallItem.startHeight !== null ||
      wallItem.endHeight !== null
    ) {
      throw new RoomMeasurementSemanticError([
        issue(
          'invalid_height_profile',
          `$.walls.${wallItem.id}`,
          'A wall using global height must be constant and omit local heights',
        ),
      ])
    }
    if (!globalHeight) {
      addMissing(missing, { code: 'ceiling_height_missing', targetId: null })
      return false
    }
    return true
  }

  if (wallItem.heightProfile === 'unknown') {
    addMissing(missing, { code: 'height_scope_ambiguous', targetId: wallItem.id })
    return false
  }
  if (!wallItem.startHeight || !wallItem.endHeight) {
    addMissing(missing, {
      code: globalHeight ? 'height_scope_ambiguous' : 'ceiling_height_missing',
      targetId: globalHeight ? wallItem.id : null,
    })
    return false
  }
  if (wallItem.heightProfile === 'constant') {
    const start = toMetres(wallItem.startHeight.value, wallItem.startHeight.unit)
    const end = toMetres(wallItem.endHeight.value, wallItem.endHeight.unit)
    if (relativeError(start, end) > RELATIVE_ERROR_TOLERANCE) {
      addMissing(missing, { code: 'height_scope_ambiguous', targetId: wallItem.id })
      return false
    }
  }
  return true
}

function finalizeRoom(
  room: CandidateRoom,
  wallsOrdered: boolean,
  hasCalibration: boolean,
  globalHeight: CandidateLinearMeasurement | null,
): RoomMeasurementSet['rooms'][number] {
  const missingInputs: MissingInput[] = []
  const printedAreaEligible = room.floor.printedArea?.basis === 'net'
  const completeBoundary = room.floor.outerBoundary.length >= 3
  let floorEligible = printedAreaEligible || (completeBoundary && hasCalibration)
  if (!printedAreaEligible && !completeBoundary) {
    addMissing(missingInputs, { code: 'floor_boundary_incomplete', targetId: room.id })
    floorEligible = false
  } else if (!printedAreaEligible && !hasCalibration) {
    addMissing(missingInputs, { code: 'scale_missing', targetId: room.id })
    floorEligible = false
  }

  const walls = room.walls.map((wallItem) => {
    const lengthEligible = wallItem.length !== null
    if (!lengthEligible) {
      addMissing(missingInputs, { code: 'wall_length_missing', targetId: wallItem.id })
    }
    const heightEligible = wallHeightEligible(wallItem, globalHeight, missingInputs)
    return {
      ...wallItem,
      length: eligibleLinear(wallItem.length),
      startHeight: eligibleLinear(wallItem.startHeight),
      endHeight: eligibleLinear(wallItem.endHeight),
      calculationEligibility:
        wallsOrdered && lengthEligible && heightEligible ? ('eligible' as const) : ('review_required' as const),
    }
  })
  if (room.walls.length === 0) {
    addMissing(missingInputs, { code: 'wall_length_missing', targetId: room.id })
  }
  const grossWallEligible = walls.length > 0 && walls.every((item) => item.calculationEligibility === 'eligible')

  const localWallIds = new Set(room.walls.map((item) => item.id))
  const openings = room.openings.map((opening) => {
    if (!opening.width) {
      addMissing(missingInputs, { code: 'opening_width_missing', targetId: opening.id })
    }
    if (!opening.height) {
      addMissing(missingInputs, { code: 'opening_height_missing', targetId: opening.id })
    }
    if (!opening.wallId) {
      addMissing(missingInputs, { code: 'opening_wall_ambiguous', targetId: opening.id })
    }
    const openingEligible =
      opening.width !== null &&
      opening.height !== null &&
      opening.wallId !== null &&
      localWallIds.has(opening.wallId)
    return {
      ...opening,
      width: eligibleLinear(opening.width),
      height: eligibleLinear(opening.height),
      sillHeight: eligibleLinear(opening.sillHeight),
      calculationEligibility: openingEligible ? ('eligible' as const) : ('review_required' as const),
    }
  })
  const netWallEligible =
    grossWallEligible && openings.every((item) => item.calculationEligibility === 'eligible')

  return {
    ...room,
    floor: {
      ...room.floor,
      printedArea: room.floor.printedArea
        ? {
            ...room.floor.printedArea,
            calculationEligibility: printedAreaEligible ? 'eligible' : 'review_required',
          }
        : null,
      calculationEligibility: floorEligible ? 'eligible' : 'review_required',
    },
    walls,
    openings,
    readiness: {
      floorArea: floorEligible ? 'eligible' : 'review_required',
      grossWallArea: grossWallEligible ? 'eligible' : 'review_required',
      netWallArea: netWallEligible ? 'eligible' : 'review_required',
    },
    missingInputs,
  }
}

export function finalizeRoomMeasurementCandidate(input: {
  candidate: RoomMeasurementCandidate
  imageWidthPx: number
  imageHeightPx: number
}): RoomMeasurementSet {
  const parsed = roomMeasurementCandidateSchema.safeParse(input.candidate)
  if (!parsed.success) {
    throw new RoomMeasurementSemanticError(
      parsed.error.issues.slice(0, MAX_ISSUES).map((zodIssue) =>
        issue('invalid_structure', pathOf(zodIssue.path), 'Candidate value violates the structural contract'),
      ),
    )
  }
  if (
    !Number.isInteger(input.imageWidthPx) ||
    input.imageWidthPx <= 0 ||
    !Number.isInteger(input.imageHeightPx) ||
    input.imageHeightPx <= 0
  ) {
    throw new RoomMeasurementSemanticError([
      issue('invalid_image_dimensions', '$.drawing', 'Image dimensions must be positive integers'),
    ])
  }

  const candidate = parsed.data
  const semanticIssues: SemanticIssue[] = []
  if (candidate.sceneKind === 'not_floor_plan' && candidate.rooms.length > 0) {
    semanticIssues.push(
      issue('invalid_scene_rooms', '$.rooms', 'A non-plan scene cannot contain rooms'),
    )
  }
  validateIdsAndReferences(candidate, semanticIssues)
  validateDrawingProvenance(candidate, semanticIssues)
  validateAllMeasurementProvenance(candidate, semanticIssues)
  candidate.rooms.forEach((room, index) => validateRoomTopology(room, index, semanticIssues))
  const scales = calibrationScales(
    candidate,
    input.imageWidthPx,
    input.imageHeightPx,
    semanticIssues,
  )
  validateReplays(
    candidate,
    scales,
    input.imageWidthPx,
    input.imageHeightPx,
    semanticIssues,
  )
  throwIssues(semanticIssues)

  const orderedWalls = candidate.rooms.map((room, index) => {
    const orderIssues: SemanticIssue[] = []
    const ordered = validateWallOrder(
      room,
      index,
      input.imageWidthPx,
      input.imageHeightPx,
      orderIssues,
    )
    throwIssues(orderIssues)
    return ordered
  })

  const rooms = candidate.rooms.map((room, index) =>
    finalizeRoom(
      room,
      orderedWalls[index],
      scales.size > 0,
      candidate.drawing.globalCeilingHeight,
    ),
  )
  const allReady =
    rooms.length > 0 &&
    rooms.every(
      (room) =>
        room.readiness.floorArea === 'eligible' &&
        room.readiness.grossWallArea === 'eligible' &&
        room.readiness.netWallArea === 'eligible' &&
        room.missingInputs.length === 0,
    )
  const analysisStatus: RoomMeasurementSet['analysisStatus'] =
    candidate.sceneKind === 'not_floor_plan'
      ? 'not_floor_plan'
      : candidate.sceneKind === 'unreadable'
        ? 'unreadable'
        : allReady
          ? 'complete'
          : 'partial'

  const result: RoomMeasurementSet = {
    schemaVersion: '1',
    analysisStatus,
    drawing: {
      imageWidthPx: input.imageWidthPx,
      imageHeightPx: input.imageHeightPx,
      declaredUnit: candidate.drawing.declaredUnit,
      declaredScale: candidate.drawing.declaredScale,
      calibrations: candidate.drawing.calibrations.map((calibration) => ({
        ...calibration,
        realLength: { ...calibration.realLength, calculationEligibility: 'eligible' },
        calculationEligibility: 'eligible',
      })),
      globalCeilingHeight: eligibleLinear(candidate.drawing.globalCeilingHeight),
      confidence: candidate.drawing.confidence,
      warnings: candidate.drawing.warnings,
    },
    rooms,
    warnings: candidate.warnings,
  }

  const finalParse = roomMeasurementSetSchema.safeParse(result)
  if (!finalParse.success) {
    throw new RoomMeasurementSemanticError(
      finalParse.error.issues.slice(0, MAX_ISSUES).map((zodIssue) =>
        issue('invalid_final_result', pathOf(zodIssue.path), 'Final result violates the caller contract'),
      ),
    )
  }
  return finalParse.data
}

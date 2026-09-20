/**
 * Turns a room-measurements result into ONE quotable quantity.
 *
 * Table-driven on purpose: a future basis is a row in `BASIS_SPECS`, not a new arm in a
 * switch that three call sites have to learn about. Zero I/O — no container, no database,
 * no network — so every number a quote line carries can be re-derived from its inputs.
 *
 * The gates run in a fixed order, and the order is the design:
 *   1. the analysis itself must be usable,
 *   2. quantities that bypass geometry answer before any coordinate is read,
 *   3. the named rooms must exist,
 *   4. the measuring agent must have declared the basis computable,
 *   5. the drawing must carry one consistent scale,
 *   6..9. the arithmetic,
 *   10. a value the agent derived itself is cross-checked against the geometry,
 *   11. the total has to be a number someone can be billed for.
 */
import {
  calibrationAgreement,
  metresPerPixel,
  polygonAreaSquareMetres,
  relativeDifference,
  RELATIVE_TOLERANCE,
  roundToTwo,
  segmentLengthMetres,
  toMetres,
  toSquareMetres,
} from './geometry'
import {
  fail,
  ok,
  type Basis,
  type Drawing,
  type EstimateProvenance,
  type LinearMeasurement,
  type MeasuredRoom,
  type Quantity,
  type QuantityFailureCode,
  type QuoteUnit,
  type Resolved,
  type RoomMeasurementsResult,
  type RoomWall,
} from './quoteContracts'

export const BASIS_SPECS: Record<Basis, { acceptedUnits: readonly QuoteUnit[] }> = {
  floor_area: { acceptedUnits: ['m2'] },
  gross_wall_area: { acceptedUnits: ['m2'] },
  net_wall_area: { acceptedUnits: ['m2'] },
  count: { acceptedUnits: ['szt', 'kpl'] },
  given: { acceptedUnits: ['m2', 'mb', 'szt', 'kpl'] },
}

/**
 * A given quantity was not derived from anything, so the only unit it can be billed in is
 * the one it arrived in. Every other basis reads the table.
 */
export function acceptedUnitsFor(basis: Basis, givenUnit?: string): readonly string[] {
  if (basis === 'given' && givenUnit) return [givenUnit]
  return BASIS_SPECS[basis].acceptedUnits
}

/** The `missingInputs[].code` values we model; anything else is upstream vocabulary we do not know yet. */
const KNOWN_MISSING_INPUT_CODES = new Set<string>([
  'scale_missing',
  'floor_boundary_incomplete',
  'ceiling_height_missing',
  'height_scope_ambiguous',
  'wall_length_missing',
  'opening_width_missing',
  'opening_height_missing',
  'opening_wall_ambiguous',
])

const READINESS_KEY = {
  floor_area: 'floorArea',
  gross_wall_area: 'grossWallArea',
  net_wall_area: 'netWallArea',
} as const

const READINESS_DEFAULT_CODE = {
  floor_area: 'floor_boundary_incomplete',
  gross_wall_area: 'wall_length_missing',
  net_wall_area: 'wall_length_missing',
} as const

type AreaBasis = keyof typeof READINESS_KEY

type Args = {
  basis: Basis
  roomIds?: string[]
  count?: number
  derivedFrom?: 'door' | 'window'
  given?: { value: number; unit: string }
}

type Numeric = Resolved<number, QuantityFailureCode>

function resolveEstimateProvenance(
  rooms: MeasuredRoom[],
  basis: AreaBasis,
  drawing: Drawing,
): Resolved<EstimateProvenance[], QuantityFailureCode> {
  if (basis === 'floor_area') return ok([])
  const estimates = new Map<string, EstimateProvenance>()
  const add = (measurement: LinearMeasurement | null | undefined): boolean => {
    if (!measurement || measurement.method !== 'estimated') return true
    const reason = measurement.estimationReason?.trim()
    if (
      !measurement.id ||
      !Number.isFinite(measurement.confidence) ||
      measurement.confidence === undefined ||
      measurement.confidence <= 0 ||
      !reason
    ) {
      return false
    }
    estimates.set(measurement.id, {
      id: measurement.id,
      confidence: measurement.confidence,
      estimationReason: reason,
    })
    return true
  }

  for (const room of rooms) {
    for (const wall of room.walls) {
      if (!add(wall.length)) return fail('estimate_provenance_invalid')
      if (wall.usesGlobalHeight) {
        if (!add(drawing.globalCeilingHeight)) return fail('estimate_provenance_invalid')
      } else if (!add(wall.startHeight) || !add(wall.endHeight)) {
        return fail('estimate_provenance_invalid')
      }
    }
    if (basis === 'net_wall_area') {
      for (const opening of room.openings) {
        if (!add(opening.width) || !add(opening.height)) return fail('estimate_provenance_invalid')
      }
    }
  }

  return ok([...estimates.values()])
}

/** Metres per pixel for the drawing as a whole, or null when nothing calibrates it. */
function resolveScale(drawing: Drawing): Resolved<number | null, QuantityFailureCode> {
  const ratios = drawing.calibrations
    .map((calibration) => metresPerPixel(calibration, drawing.imageWidthPx, drawing.imageHeightPx))
    .filter((ratio): ratio is number => ratio !== null)
  if (ratios.length === 0) return ok(null)
  if (!calibrationAgreement(ratios)) return fail('calibration_disagreement')
  return ok(ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length)
}

function floorAreaSquareMetres(room: MeasuredRoom, drawing: Drawing, scale: number | null): Numeric {
  const printed = room.floor.printedArea
  // `unknown` basis is not usable: gross and net are different numbers and the drawing
  // did not say which one it printed.
  if (printed && printed.calculationEligibility === 'eligible' && printed.basis !== 'unknown') {
    return ok(toSquareMetres(printed.value, printed.unit))
  }
  if (scale === null) return fail('scale_missing')
  return ok(polygonAreaSquareMetres(
    room.floor.outerBoundary,
    room.floor.holes.map((hole) => hole.boundary),
    scale,
    drawing.imageWidthPx,
    drawing.imageHeightPx,
  ))
}

function wallLengthMetres(wall: RoomWall, drawing: Drawing, scale: number | null): Numeric {
  if (wall.length) {
    const stated = toMetres(wall.length.value, wall.length.unit)
    if (wall.length.method !== 'scale_derived') return ok(stated)
    // The agent multiplied this one itself. Re-run the pixel bridge and compare, because
    // a misplaced factor of ten here is invisible on the quote.
    if (scale === null) return fail('scale_missing')
    const recomputed = segmentLengthMetres(
      wall.start,
      wall.end,
      scale,
      drawing.imageWidthPx,
      drawing.imageHeightPx,
    )
    if (relativeDifference(stated, recomputed) > RELATIVE_TOLERANCE) return fail('scale_derived_mismatch')
    return ok(stated)
  }
  if (scale === null) return fail('scale_missing')
  const derived = segmentLengthMetres(
    wall.start,
    wall.end,
    scale,
    drawing.imageWidthPx,
    drawing.imageHeightPx,
  )
  if (derived <= 0) return fail('wall_length_missing')
  return ok(derived)
}

/** A plan view has no vertical axis, so a height is never derivable from the geometry. */
function wallHeightMetres(wall: RoomWall, drawing: Drawing): Numeric {
  if (wall.startHeight && wall.endHeight) {
    const start = toMetres(wall.startHeight.value, wall.startHeight.unit)
    const end = toMetres(wall.endHeight.value, wall.endHeight.unit)
    return ok((start + end) / 2)
  }
  if (wall.usesGlobalHeight && drawing.globalCeilingHeight) {
    return ok(toMetres(drawing.globalCeilingHeight.value, drawing.globalCeilingHeight.unit))
  }
  return fail('ceiling_height_missing')
}

function grossWallAreaSquareMetres(room: MeasuredRoom, drawing: Drawing, scale: number | null): Numeric {
  let total = 0
  for (const wall of room.walls) {
    const length = wallLengthMetres(wall, drawing, scale)
    if (!length.ok) return length
    const height = wallHeightMetres(wall, drawing)
    if (!height.ok) return height
    total += length.value * height.value
  }
  return ok(total)
}

function netWallAreaSquareMetres(room: MeasuredRoom, drawing: Drawing, scale: number | null): Numeric {
  const gross = grossWallAreaSquareMetres(room, drawing, scale)
  if (!gross.ok) return gross
  const wallIds = new Set(room.walls.map((wall) => wall.id))
  let deduction = 0
  for (const opening of room.openings) {
    // Silently skipping an unattached opening would over-quote the paint, so it fails loudly.
    if (opening.wallId === null) return fail('opening_wall_ambiguous')
    if (!wallIds.has(opening.wallId)) continue
    if (!opening.width) return fail('opening_width_missing')
    if (!opening.height) return fail('opening_height_missing')
    deduction += toMetres(opening.width.value, opening.width.unit)
      * toMetres(opening.height.value, opening.height.unit)
  }
  return ok(Math.max(0, gross.value - deduction))
}

function areaForRoom(basis: AreaBasis, room: MeasuredRoom, drawing: Drawing, scale: number | null): Numeric {
  if (basis === 'floor_area') return floorAreaSquareMetres(room, drawing, scale)
  if (basis === 'gross_wall_area') return grossWallAreaSquareMetres(room, drawing, scale)
  return netWallAreaSquareMetres(room, drawing, scale)
}

/** A quantity nobody can be billed for is a bug in the drawing, not a free line. */
function settle(
  value: number,
  unit: QuoteUnit,
  overriddenCount?: number,
  estimateProvenance?: EstimateProvenance[],
): Resolved<Quantity, QuantityFailureCode> {
  const quantity = roundToTwo(value)
  if (!Number.isFinite(quantity) || quantity <= 0) return fail('non_positive_quantity')
  return ok({
    quantity,
    unit,
    ...(overriddenCount === undefined ? {} : { overriddenCount }),
    ...(estimateProvenance?.length ? { estimateProvenance } : {}),
  })
}

export function resolveQuantity(
  result: RoomMeasurementsResult,
  args: Args,
): Resolved<Quantity, QuantityFailureCode> {
  // 1. Nothing downstream is worth computing on a document the agent could not read.
  if (result.analysisStatus === 'not_floor_plan' || result.analysisStatus === 'unreadable') {
    return fail(result.analysisStatus)
  }

  // 2. The two bases that never touch geometry.
  if (args.basis === 'given') {
    if (!args.given) return fail('non_positive_quantity')
    // Unchanged, unit included: the operator measured it, we do not second-guess it.
    return settle(args.given.value, args.given.unit as QuoteUnit)
  }
  if (args.basis === 'count' && !args.derivedFrom) {
    return settle(args.count ?? 0, 'szt')
  }

  // 3. A room id we cannot resolve is a typo, not an empty flat.
  const rooms: MeasuredRoom[] = []
  if (args.roomIds) {
    for (const roomId of args.roomIds) {
      const room = result.rooms.find((candidate) => candidate.id === roomId)
      if (!room) return fail('room_not_found')
      rooms.push(room)
    }
  } else {
    // No selection means the whole drawing, which is what a flat-wide item asks for.
    rooms.push(...result.rooms)
  }

  // 9. A derived count reads `openings[]` only, so it needs neither readiness nor scale.
  if (args.basis === 'count') {
    const kind = args.derivedFrom
    const tally = rooms.reduce(
      (sum, room) => sum + room.openings.filter((opening) => opening.kind === kind).length,
      0,
    )
    if (tally === 0) return fail('no_openings_of_kind')
    const overridden = args.count !== undefined && args.count !== tally ? args.count : undefined
    return settle(tally, 'szt', overridden)
  }

  const basis = args.basis as AreaBasis

  // 4. The measuring agent's own verdict on whether this basis is computable at all.
  for (const room of rooms) {
    if (room.readiness[READINESS_KEY[basis]] === 'eligible') continue
    const cited = room.missingInputs.find((input) => KNOWN_MISSING_INPUT_CODES.has(input.code))
    return fail((cited?.code ?? READINESS_DEFAULT_CODE[basis]) as QuantityFailureCode)
  }

  // 5. One scale for the whole drawing, or none at all — in which case only printed
  //    values remain usable and anything needing pixels fails with `scale_missing`.
  const scale = resolveScale(result.drawing)
  if (!scale.ok) return scale

  // 6..8, 10. The arithmetic, per room.
  let total = 0
  for (const room of rooms) {
    const area = areaForRoom(basis, room, result.drawing, scale.value)
    if (!area.ok) return area
    total += area.value
  }

  // 11. Provenance is collected only after the same measurements have proved billable.
  const estimateProvenance = resolveEstimateProvenance(rooms, basis, result.drawing)
  if (!estimateProvenance.ok) return estimateProvenance
  return settle(total, 'm2', undefined, estimateProvenance.value)
}

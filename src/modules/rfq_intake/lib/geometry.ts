/**
 * Pure plan geometry: the arithmetic a language model must not do.
 *
 * Zero I/O by design — no container, no database, no network. Everything here is a
 * function of its arguments, so the numbers a quote is built from can be re-derived and
 * argued with offline.
 *
 * The one idea worth stating twice: coordinates in the room-measurements contract are
 * normalised to the IMAGE and live in `[0,1]`, which means x and y were divided by
 * DIFFERENT numbers. Recovering pixels means multiplying each axis by its own dimension.
 * Averaging the two (or using the width for both) skews every drawing that is not square.
 *
 *   d_px     = hypot((end.x - start.x) * imageWidthPx, (end.y - start.y) * imageHeightPx)
 *   m_per_px = realLength_in_metres / d_px
 *
 *   A_norm   = 1/2 * |SUM (x_i * y_i+1 - x_i+1 * y_i)|
 *   A_m2     = A_norm * imageWidthPx * imageHeightPx * m_per_px^2
 */
import type { AreaUnit, DrawingCalibration, LinearUnit, NormalisedPoint } from './quoteContracts'

/** Metres per one unit. */
const LINEAR_TO_METRES: Record<LinearUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
}

/** Square metres per one unit. The imperial rows are the linear factor squared. */
const AREA_TO_SQUARE_METRES: Record<AreaUnit, number> = {
  mm2: 0.000001,
  cm2: 0.0001,
  m2: 1,
  in2: 0.0254 * 0.0254,
  ft2: 0.3048 * 0.3048,
}

/**
 * The single tolerance in this feature: two readings of the same drawing may differ by
 * 2% before we stop believing either of them. Used for calibration agreement and for the
 * `scale_derived` cross-check.
 */
export const RELATIVE_TOLERANCE = 0.02

/**
 * Two decimals is the precision an operator can reconcile against a paper drawing;
 * anything finer is false confidence about a scanned image.
 *
 * The nudge is not decoration. A decimal that reads as an exact midpoint often has a
 * binary form a hair BELOW it, and a bare `Math.round` then rounds it down: `1.005`
 * quotes as 1.00 and `1.015` as 1.01. Nudging by a relative 1e-12 first makes the
 * result "half away from zero" for every such value, which is how an operator expects
 * a quantity to round. (`4.05 * 2.7` is NOT one of these — it lands just above the
 * midpoint and rounds to 10.94 either way; the trap is real but that is not an
 * instance of it.)
 */
export function roundToTwo(value: number): number {
  if (!Number.isFinite(value)) return value
  const scaled = value * 100
  const nudged = scaled + Math.sign(scaled) * Math.abs(scaled) * 1e-12
  return Math.round(nudged) / 100
}

/** Relative difference of two values against their mean; 0 when both are zero. */
export function relativeDifference(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY
  const mean = (a + b) / 2
  if (mean === 0) return a === b ? 0 : Number.POSITIVE_INFINITY
  return Math.abs(a - b) / Math.abs(mean)
}

export function toMetres(value: number, unit: LinearUnit): number {
  return value * LINEAR_TO_METRES[unit]
}

export function toSquareMetres(value: number, unit: AreaUnit): number {
  return value * AREA_TO_SQUARE_METRES[unit]
}

/**
 * The pixel bridge. Returns null rather than dividing by zero or handing back a NaN that
 * would travel silently into a price: a scale bar with no length, a real length of zero,
 * or an image with no dimensions are all unusable, not "infinite".
 */
export function metresPerPixel(
  calibration: DrawingCalibration,
  imageWidthPx: number,
  imageHeightPx: number,
): number | null {
  if (!Number.isFinite(imageWidthPx) || !Number.isFinite(imageHeightPx)) return null
  const { start, end, realLength } = calibration
  const dxPx = (end.x - start.x) * imageWidthPx
  const dyPx = (end.y - start.y) * imageHeightPx
  const lengthPx = Math.hypot(dxPx, dyPx)
  if (!Number.isFinite(lengthPx) || lengthPx <= 0) return null
  const metres = toMetres(realLength.value, realLength.unit)
  if (!Number.isFinite(metres) || metres <= 0) return null
  const ratio = metres / lengthPx
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null
}

/**
 * True when every ratio tells the same story. Fewer than two values have nothing to
 * disagree about; beyond that the spread is measured against the mean, so the check does
 * not depend on which reading happens to come first.
 */
export function calibrationAgreement(values: number[]): boolean {
  if (values.length < 2) return values.every((v) => Number.isFinite(v))
  if (!values.every((v) => Number.isFinite(v))) return false
  const min = Math.min(...values)
  const max = Math.max(...values)
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  if (mean <= 0) return false
  return (max - min) / mean <= RELATIVE_TOLERANCE
}

/**
 * Shoelace, absolute. Absolute because the winding order of a boundary a model produced
 * carries no meaning — a clockwise room is not a negative room.
 */
export function polygonAreaNormalised(points: NormalisedPoint[]): number {
  if (points.length < 3) return 0
  let twiceArea = 0
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]
    const next = points[(i + 1) % points.length]
    twiceArea += current.x * next.y - next.x * current.y
  }
  return Math.abs(twiceArea) / 2
}

/**
 * Outer boundary less every hole, clamped at zero: a boundary the holes swallow is a
 * measuring failure, and a negative area would show up on the quote as a credit.
 */
export function polygonAreaSquareMetres(
  outer: NormalisedPoint[],
  holes: NormalisedPoint[][],
  metresPerPx: number,
  imageWidthPx: number,
  imageHeightPx: number,
): number {
  const netNormalised = holes.reduce(
    (area, hole) => area - polygonAreaNormalised(hole),
    polygonAreaNormalised(outer),
  )
  const squareMetres = netNormalised * imageWidthPx * imageHeightPx * metresPerPx * metresPerPx
  if (!Number.isFinite(squareMetres) || squareMetres <= 0) return 0
  return roundToTwo(squareMetres)
}

/** Length of one wall run, each axis scaled by its own image dimension. */
export function segmentLengthMetres(
  a: NormalisedPoint,
  b: NormalisedPoint,
  metresPerPx: number,
  imageWidthPx: number,
  imageHeightPx: number,
): number {
  const lengthPx = Math.hypot((b.x - a.x) * imageWidthPx, (b.y - a.y) * imageHeightPx)
  const metres = lengthPx * metresPerPx
  if (!Number.isFinite(metres) || metres <= 0) return 0
  return roundToTwo(metres)
}

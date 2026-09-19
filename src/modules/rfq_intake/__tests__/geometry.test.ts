import { describe, expect, it } from '@jest/globals'

import {
  calibrationAgreement,
  metresPerPixel,
  polygonAreaNormalised,
  polygonAreaSquareMetres,
  segmentLengthMetres,
  toMetres,
  toSquareMetres,
} from '../lib/geometry'
import type { DrawingCalibration, NormalisedPoint } from '../lib/quoteContracts'
import { IMAGE_HEIGHT_PX, IMAGE_WIDTH_PX, METRES_PER_PIXEL } from './fixtures/roomMeasurements'

function calibration(overrides: Partial<DrawingCalibration> = {}): DrawingCalibration {
  return {
    id: 'cal-1',
    kind: 'scale_bar',
    start: { x: 0.25, y: 0.9 },
    end: { x: 0.75, y: 0.9 },
    realLength: { value: 5, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
    calculationEligibility: 'eligible',
    ...overrides,
  }
}

describe('linear unit conversion', () => {
  it('carries every drawing unit to metres, so a plan dimensioned in inches quotes like one in metres', () => {
    expect(toMetres(1000, 'mm')).toBeCloseTo(1, 10) // 1000 * 0.001
    expect(toMetres(250, 'cm')).toBeCloseTo(2.5, 10) // 250 * 0.01
    expect(toMetres(4, 'm')).toBeCloseTo(4, 10)
    expect(toMetres(12, 'in')).toBeCloseTo(0.3048, 10) // 12 * 0.0254
    expect(toMetres(3, 'ft')).toBeCloseTo(0.9144, 10) // 3 * 0.3048
  })

  it('keeps the full precision of an imperial unit, because rounding here would compound into the area', () => {
    // 0.0254 rounded to two decimals would be 0.03 — an 18% error before anything is squared.
    expect(toMetres(1, 'in')).toBe(0.0254)
  })
})

describe('area unit conversion', () => {
  it('carries every drawing area unit to square metres, so a printed area can be trusted as quotable', () => {
    expect(toSquareMetres(1_000_000, 'mm2')).toBeCloseTo(1, 10) // 1e6 * 1e-6
    expect(toSquareMetres(10_000, 'cm2')).toBeCloseTo(1, 10) // 1e4 * 1e-4
    expect(toSquareMetres(8, 'm2')).toBeCloseTo(8, 10)
    expect(toSquareMetres(1, 'in2')).toBeCloseTo(0.00064516, 12) // 0.0254^2
    expect(toSquareMetres(1, 'ft2')).toBeCloseTo(0.09290304, 12) // 0.3048^2
  })
})

describe('pixel bridge', () => {
  it('reads a horizontal scale bar as metres per pixel, the ratio every later measurement leans on', () => {
    // (0.75 - 0.25) * 1000 px = 500 px for 5 m -> 0.01 m/px
    expect(metresPerPixel(calibration(), IMAGE_WIDTH_PX, IMAGE_HEIGHT_PX)).toBeCloseTo(0.01, 12)
  })

  it('scales a vertical scale bar by the image HEIGHT, so a non-square drawing is not silently skewed', () => {
    // 0.5 of 500 px = 250 px for 5 m -> 0.02 m/px. Averaging the two axes would give
    // 0.5 * (1000 + 500) / 2 = 375 px -> 0.0133 m/px, wrong by a third.
    const vertical = calibration({ start: { x: 0.2, y: 0.2 }, end: { x: 0.2, y: 0.7 } })
    expect(metresPerPixel(vertical, IMAGE_WIDTH_PX, IMAGE_HEIGHT_PX)).toBeCloseTo(0.02, 12)
  })

  it('converts the calibrated length out of its own unit before dividing', () => {
    // 500 cm over 500 px -> 5 m / 500 px -> 0.01 m/px
    const inCentimetres = calibration({
      realLength: { value: 500, unit: 'cm', method: 'printed', calculationEligibility: 'eligible' },
    })
    expect(metresPerPixel(inCentimetres, IMAGE_WIDTH_PX, IMAGE_HEIGHT_PX)).toBeCloseTo(0.01, 12)
  })

  it('refuses a calibration of zero pixel length instead of dividing by zero', () => {
    const degenerate = calibration({ start: { x: 0.4, y: 0.4 }, end: { x: 0.4, y: 0.4 } })
    expect(metresPerPixel(degenerate, IMAGE_WIDTH_PX, IMAGE_HEIGHT_PX)).toBeNull()
  })

  it('refuses a calibration whose real length is zero, which would make every room measure zero', () => {
    const zeroLength = calibration({
      realLength: { value: 0, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
    })
    expect(metresPerPixel(zeroLength, IMAGE_WIDTH_PX, IMAGE_HEIGHT_PX)).toBeNull()
  })

  it('refuses a non-finite image dimension rather than propagating NaN into a price', () => {
    expect(metresPerPixel(calibration(), Number.NaN, IMAGE_HEIGHT_PX)).toBeNull()
    expect(metresPerPixel(calibration(), 0, 0)).toBeNull()
  })
})

describe('calibration agreement', () => {
  it('accepts a single ratio, because one scale bar has nothing to disagree with', () => {
    expect(calibrationAgreement([0.01])).toBe(true)
    expect(calibrationAgreement([])).toBe(true)
  })

  it('accepts ratios within 2%, absorbing the pixel noise of reading two scale bars off one scan', () => {
    // spread 0.0002 over mean 0.0101 = 1.98%
    expect(calibrationAgreement([0.01, 0.0102])).toBe(true)
  })

  it('rejects ratios further apart than 2%, because one of the two scale bars was misread', () => {
    // spread 0.0005 over mean 0.01025 = 4.88%
    expect(calibrationAgreement([0.01, 0.0105])).toBe(false)
  })

  it('rejects a non-finite ratio outright, so a broken calibration cannot pass as agreement', () => {
    expect(calibrationAgreement([0.01, Number.NaN])).toBe(false)
  })
})

describe('shoelace area', () => {
  it('measures a rectangle in normalised units, the raw signal behind every floor area', () => {
    // 0.4 wide x 0.4 tall = 0.16
    expect(polygonAreaNormalised([
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.5 },
      { x: 0.1, y: 0.5 },
    ])).toBeCloseTo(0.16, 12)
  })

  it('gives the same area for a reversed winding, since a model has no reason to order points one way', () => {
    const clockwise: NormalisedPoint[] = [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.5 },
      { x: 0.1, y: 0.5 },
    ]
    const counterClockwise = [...clockwise].reverse()
    // The signed shoelace flips sign; the absolute value must not.
    expect(polygonAreaNormalised(counterClockwise)).toBeCloseTo(0.16, 12)
    expect(polygonAreaNormalised(counterClockwise)).toBeCloseTo(polygonAreaNormalised(clockwise), 12)
  })

  it('measures an L-shaped room, which is the shape a bounding box would over-quote', () => {
    // 0.4 x 0.4 square less the 0.2 x 0.2 bite = 0.16 - 0.04 = 0.12
    expect(polygonAreaNormalised([
      { x: 0, y: 0 },
      { x: 0.4, y: 0 },
      { x: 0.4, y: 0.2 },
      { x: 0.2, y: 0.2 },
      { x: 0.2, y: 0.4 },
      { x: 0, y: 0.4 },
    ])).toBeCloseTo(0.12, 12)
  })

  it('reports zero for a boundary of two points, which encloses nothing', () => {
    expect(polygonAreaNormalised([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }])).toBe(0)
    expect(polygonAreaNormalised([])).toBe(0)
  })
})

describe('polygon area in square metres', () => {
  it('bridges a normalised rectangle to square metres through both image axes', () => {
    // 0.16 * 1000 * 500 * 0.01^2 = 0.16 * 500000 * 0.0001 = 8
    expect(polygonAreaSquareMetres(
      [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.5 },
        { x: 0.1, y: 0.5 },
      ],
      [],
      METRES_PER_PIXEL,
      IMAGE_WIDTH_PX,
      IMAGE_HEIGHT_PX,
    )).toBe(8)
  })

  it('subtracts a hole, so a stairwell or shaft is not charged as floor', () => {
    // outer 0.16 -> 8 m2; hole 0.1 x 0.1 = 0.01 -> 0.01 * 500000 * 0.0001 = 0.5 m2
    expect(polygonAreaSquareMetres(
      [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.5 },
        { x: 0.1, y: 0.5 },
      ],
      [[
        { x: 0.2, y: 0.2 },
        { x: 0.3, y: 0.2 },
        { x: 0.3, y: 0.3 },
        { x: 0.2, y: 0.3 },
      ]],
      METRES_PER_PIXEL,
      IMAGE_WIDTH_PX,
      IMAGE_HEIGHT_PX,
    )).toBe(7.5)
  })

  it('clamps at zero when the holes swallow the boundary, because a negative area would credit the customer', () => {
    // outer 0.1 x 0.1 = 0.01 -> 0.5 m2; hole 0.5 x 0.5 = 0.25 -> 12.5 m2
    expect(polygonAreaSquareMetres(
      [
        { x: 0, y: 0 },
        { x: 0.1, y: 0 },
        { x: 0.1, y: 0.1 },
        { x: 0, y: 0.1 },
      ],
      [[
        { x: 0, y: 0 },
        { x: 0.5, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 0, y: 0.5 },
      ]],
      METRES_PER_PIXEL,
      IMAGE_WIDTH_PX,
      IMAGE_HEIGHT_PX,
    )).toBe(0)
  })

  it('reports zero for a two-point boundary rather than inventing an area', () => {
    expect(polygonAreaSquareMetres(
      [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }],
      [],
      METRES_PER_PIXEL,
      IMAGE_WIDTH_PX,
      IMAGE_HEIGHT_PX,
    )).toBe(0)
  })

  it('rounds to two decimals, the precision an operator can reconcile against a drawing', () => {
    // 0.1 x 0.1 triangle: 0.5 * 0.1 * 0.1 = 0.005 -> 0.005 * 500000 * 0.0001 = 0.25
    expect(polygonAreaSquareMetres(
      [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0, y: 0.1 }],
      [],
      METRES_PER_PIXEL,
      IMAGE_WIDTH_PX,
      IMAGE_HEIGHT_PX,
    )).toBe(0.25)
  })
})

describe('segment length in metres', () => {
  it('measures a horizontal wall through the image width, recovering the calibrated 4 m', () => {
    // (0.5 - 0.1) * 1000 px = 400 px * 0.01 = 4 m
    expect(segmentLengthMetres(
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      METRES_PER_PIXEL,
      IMAGE_WIDTH_PX,
      IMAGE_HEIGHT_PX,
    )).toBe(4)
  })

  it('measures a vertical wall through the image height, which is the shorter axis here', () => {
    // (0.5 - 0.1) * 500 px = 200 px * 0.01 = 2 m
    expect(segmentLengthMetres(
      { x: 0.1, y: 0.1 },
      { x: 0.1, y: 0.5 },
      METRES_PER_PIXEL,
      IMAGE_WIDTH_PX,
      IMAGE_HEIGHT_PX,
    )).toBe(2)
  })

  it('measures a diagonal wall per axis, since a shared scale factor would misread every slanted run', () => {
    // dx 0.4 * 1000 = 400 px, dy 0.4 * 500 = 200 px
    // hypot(400, 200) = 447.2136 px * 0.01 = 4.4721 -> 4.47
    expect(segmentLengthMetres(
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.5 },
      METRES_PER_PIXEL,
      IMAGE_WIDTH_PX,
      IMAGE_HEIGHT_PX,
    )).toBe(4.47)
  })
})

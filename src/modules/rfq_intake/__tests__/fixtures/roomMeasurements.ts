/**
 * A V2-shaped room-measurements result with numbers a reader can check by hand.
 *
 * The drawing is 1000x500 px — deliberately non-square, so any code that averages the
 * two axes instead of scaling each one by its own dimension produces a wrong answer
 * here rather than in production.
 *
 * Calibration: x 0.25 -> 0.75 on a 1000 px wide image is 500 px for 5 m, so
 * 5 / 500 = 0.01 m per pixel.
 *
 * The default room therefore measures:
 *   floor      (0.1,0.1)-(0.5,0.5) -> 0.16 normalised -> 0.16 * 1000 * 500 * 0.01^2 = 8 m2
 *   gross wall printed 4 m x global 2.7 m                                          = 10.8 m2
 *   net wall   10.8 - (1.5 x 1.2)                                                  = 9 m2
 */
import type {
  Drawing,
  MeasuredRoom,
  NormalisedPoint,
  RoomMeasurementsResult,
} from '../../lib/quoteContracts'

export const IMAGE_WIDTH_PX = 1000
export const IMAGE_HEIGHT_PX = 500
/** 5 m over 500 px. */
export const METRES_PER_PIXEL = 0.01

export const drawing: Drawing = {
  imageWidthPx: IMAGE_WIDTH_PX,
  imageHeightPx: IMAGE_HEIGHT_PX,
  declaredScale: null,
  globalCeilingHeight: {
    value: 2.7,
    unit: 'm',
    method: 'printed',
    calculationEligibility: 'eligible',
  },
  calibrations: [
    {
      id: 'cal-1',
      kind: 'scale_bar',
      start: { x: 0.25, y: 0.9 },
      end: { x: 0.75, y: 0.9 },
      realLength: { value: 5, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
      calculationEligibility: 'eligible',
    },
  ],
}

/** The floor rectangle, counter-clockwise in image coordinates. */
export const FLOOR_RECTANGLE: NormalisedPoint[] = [
  { x: 0.1, y: 0.1 },
  { x: 0.5, y: 0.1 },
  { x: 0.5, y: 0.5 },
  { x: 0.1, y: 0.5 },
]

export function room(overrides: Partial<MeasuredRoom> = {}): MeasuredRoom {
  return {
    id: 'room-1',
    printedName: 'Salon',
    location: 'ground floor',
    floor: {
      outerBoundary: FLOOR_RECTANGLE.map((p) => ({ ...p })),
      holes: [],
      printedArea: null,
      calculationEligibility: 'eligible',
    },
    walls: [
      {
        id: 'wall-1',
        // 0.1 -> 0.5 of 1000 px is 400 px, which at 0.01 m/px is the printed 4 m.
        start: { x: 0.1, y: 0.1 },
        end: { x: 0.5, y: 0.1 },
        length: { value: 4, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
        heightProfile: 'constant',
        startHeight: null,
        endHeight: null,
        usesGlobalHeight: true,
        calculationEligibility: 'eligible',
      },
    ],
    openings: [
      {
        id: 'opening-1',
        kind: 'window',
        wallId: 'wall-1',
        width: { value: 1.5, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
        height: { value: 1.2, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
        calculationEligibility: 'eligible',
      },
    ],
    readiness: {
      floorArea: 'eligible',
      grossWallArea: 'eligible',
      netWallArea: 'eligible',
    },
    missingInputs: [],
    ...overrides,
  }
}

export function measurementResult(
  rooms: MeasuredRoom[] = [room()],
  overrides: Partial<RoomMeasurementsResult> = {},
): RoomMeasurementsResult {
  return {
    schemaVersion: '1',
    analysisStatus: 'complete',
    drawing,
    rooms,
    warnings: [],
    ...overrides,
  }
}

import { describe, expect, it } from '@jest/globals'

import { acceptedUnitsFor, BASIS_SPECS, resolveQuantity } from '../lib/basisResolver'
import type { MeasuredRoom, RoomOpening, RoomWall } from '../lib/quoteContracts'
import { drawing, measurementResult, room } from './fixtures/roomMeasurements'

const noCalibration = { ...drawing, calibrations: [] }

function wall(overrides: Partial<RoomWall> = {}): RoomWall {
  return { ...room().walls[0], ...overrides }
}

function opening(overrides: Partial<RoomOpening> = {}): RoomOpening {
  return { ...room().openings[0], ...overrides }
}

function withRooms(rooms: MeasuredRoom[]) {
  return measurementResult(rooms)
}

describe('accepted units per basis', () => {
  it('keeps every area basis on m2, so a per-metre product can never be billed by area', () => {
    expect(acceptedUnitsFor('floor_area')).toEqual(['m2'])
    expect(acceptedUnitsFor('gross_wall_area')).toEqual(['m2'])
    expect(acceptedUnitsFor('net_wall_area')).toEqual(['m2'])
  })

  it('lets a count bill per piece or per set, the two units the catalog tallies with', () => {
    expect(acceptedUnitsFor('count')).toEqual(['szt', 'kpl'])
  })

  it('narrows a given quantity to exactly the unit it was given in, because nothing was derived', () => {
    expect(acceptedUnitsFor('given', 'mb')).toEqual(['mb'])
    expect(acceptedUnitsFor('given', 'kpl')).toEqual(['kpl'])
    // Without a unit there is nothing to narrow to, so the table's full list stands.
    expect(acceptedUnitsFor('given')).toEqual(['m2', 'mb', 'szt', 'kpl'])
  })

  it('describes every basis in the table, so adding one is a row rather than a new branch', () => {
    expect(Object.keys(BASIS_SPECS).sort()).toEqual(
      ['count', 'floor_area', 'given', 'gross_wall_area', 'net_wall_area'],
    )
  })
})

describe('analysis status gate', () => {
  it('refuses a document the measuring agent did not recognise as a floor plan', () => {
    const result = measurementResult([room()], { analysisStatus: 'not_floor_plan' })
    expect(resolveQuantity(result, { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'not_floor_plan' })
  })

  it('refuses an unreadable scan even for a quantity the operator typed in, because the whole result is suspect', () => {
    const result = measurementResult([room()], { analysisStatus: 'unreadable' })
    expect(resolveQuantity(result, { basis: 'given', given: { value: 5, unit: 'mb' } }))
      .toEqual({ ok: false, code: 'unreadable' })
  })
})

describe('quantities that bypass geometry', () => {
  it('passes an operator-given quantity through untouched, so a hand measurement is never re-derived', () => {
    expect(resolveQuantity(withRooms([room()]), { basis: 'given', given: { value: 7.5, unit: 'mb' } }))
      .toEqual({ ok: true, value: { quantity: 7.5, unit: 'mb' } })
  })

  it('bills a plain count in pieces without reading a single coordinate', () => {
    // Works even though the drawing has no calibration at all.
    const result = measurementResult([room()], { drawing: noCalibration })
    expect(resolveQuantity(result, { basis: 'count', count: 3 }))
      .toEqual({ ok: true, value: { quantity: 3, unit: 'szt' } })
  })

  it('refuses a count of zero, because a line of nothing is a mistake not a discount', () => {
    expect(resolveQuantity(withRooms([room()]), { basis: 'count', count: 0 }))
      .toEqual({ ok: false, code: 'non_positive_quantity' })
  })
})

describe('room selection', () => {
  it('names the unknown room instead of quietly quoting the rooms it did find', () => {
    expect(resolveQuantity(withRooms([room()]), { basis: 'floor_area', roomIds: ['room-1', 'room-9'] }))
      .toEqual({ ok: false, code: 'room_not_found' })
  })

  it('adds the rooms up, so one line can cover a whole flat', () => {
    // 8 m2 + 8 m2
    const result = withRooms([room(), room({ id: 'room-2' })])
    expect(resolveQuantity(result, { basis: 'floor_area', roomIds: ['room-1', 'room-2'] }))
      .toEqual({ ok: true, value: { quantity: 16, unit: 'm2' } })
  })

  it('covers every measured room when no room is named, which is what a whole-flat item means', () => {
    const result = withRooms([room(), room({ id: 'room-2' })])
    expect(resolveQuantity(result, { basis: 'floor_area' }))
      .toEqual({ ok: true, value: { quantity: 16, unit: 'm2' } })
  })
})

describe('readiness gate', () => {
  it('reports the measuring agent own reason for a floor it could not close', () => {
    const incomplete = room({
      readiness: { floorArea: 'review_required', grossWallArea: 'eligible', netWallArea: 'eligible' },
      missingInputs: [{ code: 'floor_boundary_incomplete', targetId: 'room-1' }],
    })
    expect(resolveQuantity(withRooms([incomplete]), { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'floor_boundary_incomplete' })
  })

  it('falls back to a boundary failure when the agent cited a code we do not model, rather than throwing', () => {
    const incomplete = room({
      readiness: { floorArea: 'review_required', grossWallArea: 'eligible', netWallArea: 'eligible' },
      missingInputs: [{ code: 'something_new_upstream', targetId: null }],
    })
    expect(resolveQuantity(withRooms([incomplete]), { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'floor_boundary_incomplete' })
  })

  it('falls back to a wall failure for a wall basis, because the default has to match what was asked for', () => {
    const incomplete = room({
      readiness: { floorArea: 'eligible', grossWallArea: 'review_required', netWallArea: 'review_required' },
      missingInputs: [],
    })
    expect(resolveQuantity(withRooms([incomplete]), { basis: 'gross_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'wall_length_missing' })
    expect(resolveQuantity(withRooms([incomplete]), { basis: 'net_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'wall_length_missing' })
  })
})

describe('floor area', () => {
  it('measures the floor polygon through the pixel bridge, the number the whole quote hangs on', () => {
    // 0.4 x 0.4 normalised -> 0.16 * 1000 * 500 * 0.01^2 = 8 m2
    expect(resolveQuantity(withRooms([room()]), { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 8, unit: 'm2' } })
  })

  it('prefers an area printed on the drawing, because the architect measured before the image was scanned', () => {
    // The polygon says 8 m2; the drawing says 12.5 m2 and the drawing wins.
    const printed = room({
      floor: {
        ...room().floor,
        printedArea: { value: 12.5, unit: 'm2', basis: 'net', method: 'printed', calculationEligibility: 'eligible' },
      },
    })
    expect(resolveQuantity(withRooms([printed]), { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 12.5, unit: 'm2' } })
  })

  it('converts a printed area out of its own unit, so a plan labelled in cm2 is not quoted ten thousand times over', () => {
    // 125000 cm2 * 1e-4 = 12.5 m2
    const printed = room({
      floor: {
        ...room().floor,
        printedArea: { value: 125_000, unit: 'cm2', basis: 'gross', method: 'printed', calculationEligibility: 'eligible' },
      },
    })
    expect(resolveQuantity(withRooms([printed]), { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 12.5, unit: 'm2' } })
  })

  it('ignores a printed area of unknown basis and measures the polygon, since gross and net are not interchangeable', () => {
    const ambiguous = room({
      floor: {
        ...room().floor,
        printedArea: { value: 12.5, unit: 'm2', basis: 'unknown', method: 'printed', calculationEligibility: 'eligible' },
      },
    })
    expect(resolveQuantity(withRooms([ambiguous]), { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 8, unit: 'm2' } })
  })

  it('ignores a printed area the agent itself flagged for review and measures the polygon instead', () => {
    const flagged = room({
      floor: {
        ...room().floor,
        printedArea: { value: 12.5, unit: 'm2', basis: 'net', method: 'printed', calculationEligibility: 'review_required' },
      },
    })
    expect(resolveQuantity(withRooms([flagged]), { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 8, unit: 'm2' } })
  })

  it('subtracts a hole in the floor, so a shaft is not sold as flooring', () => {
    // 8 m2 less the 0.1 x 0.1 normalised hole (0.01 * 500000 * 0.0001 = 0.5 m2)
    const holed = room({
      floor: {
        ...room().floor,
        holes: [{
          id: 'hole-1',
          boundary: [
            { x: 0.2, y: 0.2 },
            { x: 0.3, y: 0.2 },
            { x: 0.3, y: 0.3 },
            { x: 0.2, y: 0.3 },
          ],
        }],
      },
    })
    expect(resolveQuantity(withRooms([holed]), { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 7.5, unit: 'm2' } })
  })

  it('refuses a polygon with no scale, because pixels alone cannot be priced', () => {
    const result = measurementResult([room()], { drawing: noCalibration })
    expect(resolveQuantity(result, { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'scale_missing' })
  })

  it('still reads a printed area with no scale at all, since a printed number needs no pixel bridge', () => {
    const printed = room({
      floor: {
        ...room().floor,
        printedArea: { value: 12.5, unit: 'm2', basis: 'gross', method: 'printed', calculationEligibility: 'eligible' },
      },
    })
    const result = measurementResult([printed], { drawing: noCalibration })
    expect(resolveQuantity(result, { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 12.5, unit: 'm2' } })
  })
})

describe('calibration agreement', () => {
  it('refuses two scale bars that contradict each other, instead of averaging a wrong answer', () => {
    // cal-1 gives 0.01 m/px; this one gives 5 m / 250 px = 0.02 m/px.
    const conflicting = {
      ...drawing,
      calibrations: [
        drawing.calibrations[0],
        {
          ...drawing.calibrations[0],
          id: 'cal-2',
          start: { x: 0.1, y: 0.1 },
          end: { x: 0.35, y: 0.1 },
        },
      ],
    }
    const result = measurementResult([room()], { drawing: conflicting })
    expect(resolveQuantity(result, { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'calibration_disagreement' })
  })

  it('averages two scale bars that agree, which is what two readings of the same drawing look like', () => {
    // cal-1 0.01 m/px; cal-2 5.05 m / 500 px = 0.0101 m/px -> mean 0.01005, within 2%.
    // 0.16 * 500000 * 0.01005^2 = 80000 * 0.000101 = 8.08 m2
    const agreeing = {
      ...drawing,
      calibrations: [
        drawing.calibrations[0],
        {
          ...drawing.calibrations[0],
          id: 'cal-2',
          realLength: { value: 5.05, unit: 'm' as const, method: 'printed' as const, calculationEligibility: 'eligible' as const },
        },
      ],
    }
    const result = measurementResult([room()], { drawing: agreeing })
    expect(resolveQuantity(result, { basis: 'floor_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 8.08, unit: 'm2' } })
  })
})

describe('gross wall area', () => {
  it('multiplies each wall by its height and sums, the shape of every painting or plastering line', () => {
    // 4 m printed x 2.7 m global ceiling = 10.8 m2
    expect(resolveQuantity(withRooms([room()]), { basis: 'gross_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 10.8, unit: 'm2' } })
  })

  it('needs no calibration when the wall length and the ceiling height are both printed', () => {
    const result = measurementResult([room()], { drawing: { ...noCalibration, globalCeilingHeight: drawing.globalCeilingHeight } })
    expect(resolveQuantity(result, { basis: 'gross_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 10.8, unit: 'm2' } })
  })

  it('measures an unlabelled wall off its own endpoints, so a missing dimension line is not a dead end', () => {
    // 0.1 -> 0.5 of 1000 px = 400 px * 0.01 = 4 m, x 2.7 = 10.8 m2
    const unlabelled = room({ walls: [wall({ length: null })] })
    expect(resolveQuantity(withRooms([unlabelled]), { basis: 'gross_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 10.8, unit: 'm2' } })
  })

  it('refuses an unlabelled wall with no scale, rather than quoting a length in pixels', () => {
    const unlabelled = room({ walls: [wall({ length: null })] })
    const result = measurementResult([unlabelled], { drawing: noCalibration })
    expect(resolveQuantity(result, { basis: 'gross_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'scale_missing' })
  })

  it('averages the two end heights of a sloped wall, which is exactly its mean height', () => {
    // (2.4 + 3.0) / 2 = 2.7 -> 4 m x 2.7 = 10.8 m2
    const sloped = room({
      walls: [wall({
        heightProfile: 'sloped',
        startHeight: { value: 2.4, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
        endHeight: { value: 3, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
        usesGlobalHeight: false,
      })],
    })
    expect(resolveQuantity(withRooms([sloped]), { basis: 'gross_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 10.8, unit: 'm2' } })
  })

  it('refuses a wall with no height anywhere, because a plan view has no vertical axis to derive one from', () => {
    const flat = room({ walls: [wall({ usesGlobalHeight: false })] })
    expect(resolveQuantity(withRooms([flat]), { basis: 'gross_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'ceiling_height_missing' })
  })

  it('refuses a wall that defers to a global height the drawing never states', () => {
    const result = measurementResult([room()], { drawing: { ...drawing, globalCeilingHeight: null } })
    expect(resolveQuantity(result, { basis: 'gross_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'ceiling_height_missing' })
  })
})

describe('scale-derived cross-check', () => {
  it('refuses a derived length the geometry contradicts, the cheap guard against a model multiplying wrong', () => {
    // The model claimed 5 m; 400 px at 0.01 m/px is 4 m — 22% apart against their mean.
    const drifted = room({
      walls: [wall({
        length: { value: 5, unit: 'm', method: 'scale_derived', calculationEligibility: 'eligible' },
      })],
    })
    expect(resolveQuantity(withRooms([drifted]), { basis: 'gross_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'scale_derived_mismatch' })
  })

  it('accepts a derived length within 2% and keeps the stated value, since rounding noise is not an error', () => {
    // 4.05 m stated vs 4 m recomputed = 1.24% against their mean; 4.05 x 2.7 = 10.935 -> 10.94
    const nudged = room({
      walls: [wall({
        length: { value: 4.05, unit: 'm', method: 'scale_derived', calculationEligibility: 'eligible' },
      })],
    })
    expect(resolveQuantity(withRooms([nudged]), { basis: 'gross_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 10.94, unit: 'm2' } })
  })

  it('refuses a derived length with no scale to check it against', () => {
    const drifted = room({
      walls: [wall({
        length: { value: 4, unit: 'm', method: 'scale_derived', calculationEligibility: 'eligible' },
      })],
    })
    const result = measurementResult([drifted], { drawing: noCalibration })
    expect(resolveQuantity(result, { basis: 'gross_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'scale_missing' })
  })
})

describe('net wall area', () => {
  it('deducts the openings, which is the area actually painted', () => {
    // 10.8 gross less the 1.5 x 1.2 window = 10.8 - 1.8 = 9 m2
    expect(resolveQuantity(withRooms([room()]), { basis: 'net_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 9, unit: 'm2' } })
  })

  it('ignores an opening attached to another room wall, so a neighbour door is not deducted twice', () => {
    const foreign = room({ openings: [opening({ wallId: 'wall-elsewhere' })] })
    expect(resolveQuantity(withRooms([foreign]), { basis: 'net_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 10.8, unit: 'm2' } })
  })

  it('refuses an opening the agent could not attach to a wall, because skipping it would over-quote', () => {
    const floating = room({ openings: [opening({ wallId: null })] })
    expect(resolveQuantity(withRooms([floating]), { basis: 'net_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'opening_wall_ambiguous' })
  })

  it('names a missing opening width rather than deducting nothing for it', () => {
    const noWidth = room({ openings: [opening({ width: null })] })
    expect(resolveQuantity(withRooms([noWidth]), { basis: 'net_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'opening_width_missing' })
  })

  it('names a missing opening height for the same reason', () => {
    const noHeight = room({ openings: [opening({ height: null })] })
    expect(resolveQuantity(withRooms([noHeight]), { basis: 'net_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'opening_height_missing' })
  })

  it('clamps a wall swallowed by its openings at zero, and then refuses the empty line', () => {
    // A 4 m x 5 m opening deducts 20 m2 from 10.8 m2 — clamped to 0, which is not quotable.
    const glazed = room({
      openings: [opening({
        width: { value: 4, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
        height: { value: 5, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
      })],
    })
    expect(resolveQuantity(withRooms([glazed]), { basis: 'net_wall_area', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'non_positive_quantity' })
  })
})

describe('derived counts', () => {
  it('tallies the windows the agent actually found, so a window line matches the drawing', () => {
    const twoWindows = room({
      openings: [opening(), opening({ id: 'opening-2' })],
    })
    expect(resolveQuantity(withRooms([twoWindows]), { basis: 'count', derivedFrom: 'window', roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 2, unit: 'szt' } })
  })

  it('overrides a count the model supplied and records what it claimed, because the drawing outranks the guess', () => {
    // One window is drawn; the model said five.
    expect(resolveQuantity(withRooms([room()]), { basis: 'count', derivedFrom: 'window', count: 5, roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 1, unit: 'szt', overriddenCount: 5 } })
  })

  it('leaves no override note when the model agreed with the drawing, so a warning means something', () => {
    expect(resolveQuantity(withRooms([room()]), { basis: 'count', derivedFrom: 'window', count: 1, roomIds: ['room-1'] }))
      .toEqual({ ok: true, value: { quantity: 1, unit: 'szt' } })
  })

  it('tallies across the named rooms, since one door line usually covers a whole flat', () => {
    const doors = room({ openings: [opening({ kind: 'door' })] })
    const result = withRooms([doors, room({ id: 'room-2', openings: [opening({ id: 'opening-2', kind: 'door' })] })])
    expect(resolveQuantity(result, { basis: 'count', derivedFrom: 'door', roomIds: ['room-1', 'room-2'] }))
      .toEqual({ ok: true, value: { quantity: 2, unit: 'szt' } })
  })

  it('refuses a door line for a flat with no doors drawn, instead of quoting zero doors', () => {
    expect(resolveQuantity(withRooms([room()]), { basis: 'count', derivedFrom: 'door', roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'no_openings_of_kind' })
  })

  it('still refuses when the model supplied a count, because the derived tally is the one that counts', () => {
    expect(resolveQuantity(withRooms([room()]), { basis: 'count', derivedFrom: 'door', count: 4, roomIds: ['room-1'] }))
      .toEqual({ ok: false, code: 'no_openings_of_kind' })
  })

  it('reports an unknown room before counting anything, so a typo is not read as an empty flat', () => {
    expect(resolveQuantity(withRooms([room()]), { basis: 'count', derivedFrom: 'window', roomIds: ['room-404'] }))
      .toEqual({ ok: false, code: 'room_not_found' })
  })
})

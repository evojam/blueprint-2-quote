import { describe, expect, it } from '@jest/globals'
import { formatCreatedAt } from '../lib/format-date'

describe('formatCreatedAt', () => {
  it('formats an ISO timestamp as dd/mm/yyyy', () => {
    expect(formatCreatedAt('2026-09-19T09:00:00.000Z')).toBe('19/09/2026')
  })

  it('falls back to an em dash for a missing value', () => {
    expect(formatCreatedAt(null)).toBe('—')
    expect(formatCreatedAt(undefined)).toBe('—')
  })

  it('falls back to an em dash for an unparseable value', () => {
    expect(formatCreatedAt('not-a-date')).toBe('—')
  })

  it('pads single-digit day and month', () => {
    expect(formatCreatedAt('2026-01-05T09:00:00.000Z')).toBe('05/01/2026')
  })
})

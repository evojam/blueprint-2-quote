import { describe, expect, it, jest } from '@jest/globals'
import {
  applyLinkLabels,
  buildLookupUrls,
  collectLookupIds,
  fetchLabelMaps,
  MAX_LOOKUP_IDS,
  type LinkRow,
} from '../lib/link-labels'

const DEAL_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const DEAL_B = 'aaaaaaaa-0000-4000-8000-000000000002'
const QUOTE_A = 'bbbbbbbb-0000-4000-8000-000000000001'
const ORDER_A = 'cccccccc-0000-4000-8000-000000000001'

function row(overrides: Partial<LinkRow>): LinkRow {
  return {
    id: 'row-1',
    deal_id: DEAL_A,
    document_id: QUOTE_A,
    document_kind: 'quote',
    created_at: '2026-09-19T10:00:00.000Z',
    ...overrides,
  }
}

describe('collectLookupIds', () => {
  it('splits document ids by kind and keeps deal ids separate', () => {
    const ids = collectLookupIds([
      row({ id: '1', deal_id: DEAL_A, document_id: QUOTE_A, document_kind: 'quote' }),
      row({ id: '2', deal_id: DEAL_B, document_id: ORDER_A, document_kind: 'order' }),
    ])
    expect(ids).toEqual({ dealIds: [DEAL_A, DEAL_B], quoteIds: [QUOTE_A], orderIds: [ORDER_A] })
  })

  it('deduplicates ids repeated across rows', () => {
    const ids = collectLookupIds([
      row({ id: '1', deal_id: DEAL_A, document_id: QUOTE_A }),
      row({ id: '2', deal_id: DEAL_A, document_id: QUOTE_A }),
    ])
    expect(ids.dealIds).toEqual([DEAL_A])
    expect(ids.quoteIds).toEqual([QUOTE_A])
  })

  // The entity's column is plain text; a kind written by something other than
  // this module must not be guessed into the wrong lookup.
  it('drops documents whose kind is neither quote nor order', () => {
    const ids = collectLookupIds([row({ document_kind: 'invoice' })])
    expect(ids.quoteIds).toEqual([])
    expect(ids.orderIds).toEqual([])
    expect(ids.dealIds).toEqual([DEAL_A])
  })

  it('caps each id list at MAX_LOOKUP_IDS', () => {
    const many = Array.from({ length: MAX_LOOKUP_IDS + 25 }, (_value, index) =>
      row({
        id: `row-${index}`,
        deal_id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`,
        document_id: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, '0')}`,
      }),
    )
    const ids = collectLookupIds(many)
    expect(ids.dealIds).toHaveLength(MAX_LOOKUP_IDS)
    expect(ids.quoteIds).toHaveLength(MAX_LOOKUP_IDS)
  })

  it('returns empty lists for no rows', () => {
    expect(collectLookupIds([])).toEqual({ dealIds: [], quoteIds: [], orderIds: [] })
  })
})

describe('buildLookupUrls', () => {
  it('builds one batched url per non-empty source', () => {
    const urls = buildLookupUrls({ dealIds: [DEAL_A, DEAL_B], quoteIds: [QUOTE_A], orderIds: [] })
    expect(urls.deals).toBe(
      `/api/customers/deals?ids=${DEAL_A}%2C${DEAL_B}&pageSize=${MAX_LOOKUP_IDS}`,
    )
    expect(urls.quotes).toBe(`/api/sales/quotes?ids=${QUOTE_A}&pageSize=${MAX_LOOKUP_IDS}`)
    expect(urls.orders).toBeNull()
  })
})

describe('fetchLabelMaps', () => {
  it('maps each source onto its label field', async () => {
    const fetchJson = jest.fn(async (url: string) => {
      if (url.startsWith('/api/customers/deals')) return { items: [{ id: DEAL_A, title: 'Kitchen refit' }] }
      if (url.startsWith('/api/sales/quotes')) return { items: [{ id: QUOTE_A, quoteNumber: 'Q-0007' }] }
      return { items: [{ id: ORDER_A, orderNumber: 'O-0031' }] }
    }) as unknown as <T>(url: string) => Promise<T>

    const maps = await fetchLabelMaps(
      { dealIds: [DEAL_A], quoteIds: [QUOTE_A], orderIds: [ORDER_A] },
      fetchJson,
    )

    expect(maps).toEqual({
      deals: { [DEAL_A]: 'Kitchen refit' },
      quotes: { [QUOTE_A]: 'Q-0007' },
      orders: { [ORDER_A]: 'O-0031' },
    })
  })

  it('issues no request for an empty source', async () => {
    const calls: string[] = []
    const fetchJson = (async (url: string) => {
      calls.push(url)
      return { items: [] }
    }) as unknown as <T>(url: string) => Promise<T>

    await fetchLabelMaps({ dealIds: [DEAL_A], quoteIds: [], orderIds: [] }, fetchJson)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/api/customers/deals')
  })

  // REQ-005: a missing grant or a dead source must not blank the whole table.
  it('degrades a failing source to an empty map and keeps the others', async () => {
    const fetchJson = (async (url: string) => {
      if (url.startsWith('/api/sales/quotes')) throw new Error('403')
      return { items: [{ id: DEAL_A, title: 'Kitchen refit' }] }
    }) as unknown as <T>(url: string) => Promise<T>

    const maps = await fetchLabelMaps({ dealIds: [DEAL_A], quoteIds: [QUOTE_A], orderIds: [] }, fetchJson)

    expect(maps.deals).toEqual({ [DEAL_A]: 'Kitchen refit' })
    expect(maps.quotes).toEqual({})
  })

  it('skips items whose label field is null', async () => {
    const fetchJson = (async () => ({ items: [{ id: DEAL_A, title: null }] })) as unknown as <T>(
      url: string,
    ) => Promise<T>

    const maps = await fetchLabelMaps({ dealIds: [DEAL_A], quoteIds: [], orderIds: [] }, fetchJson)

    expect(maps.deals).toEqual({})
  })
})

describe('applyLinkLabels', () => {
  const maps = {
    deals: { [DEAL_A]: 'Kitchen refit' },
    quotes: { [QUOTE_A]: 'Q-0007' },
    orders: {},
  }

  it('attaches the resolved labels', () => {
    const [labelled] = applyLinkLabels([row({})], maps)
    expect(labelled.deal_label).toBe('Kitchen refit')
    expect(labelled.document_label).toBe('Q-0007')
  })

  it('leaves an unresolved id as null rather than dropping the row', () => {
    const [labelled] = applyLinkLabels([row({ deal_id: DEAL_B, document_id: ORDER_A, document_kind: 'order' })], maps)
    expect(labelled.deal_label).toBeNull()
    expect(labelled.document_label).toBeNull()
    expect(labelled.id).toBe('row-1')
  })

  it('leaves an unknown kind unresolved', () => {
    const [labelled] = applyLinkLabels([row({ document_kind: 'invoice' })], maps)
    expect(labelled.document_label).toBeNull()
  })
})

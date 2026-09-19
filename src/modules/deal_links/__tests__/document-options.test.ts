import { describe, expect, it } from '@jest/globals'
import {
  buildSearchParams,
  loadDocumentOptions,
  OPTION_PAGE_SIZE,
  type ListFetcher,
} from '../lib/document-options'

const QUOTE_ID = '11111111-0000-4000-8000-000000000001'
const ORDER_ID = '22222222-0000-4000-8000-000000000002'

// A minimal stand-in for the i18n translator: returns the fallback with `{number}`
// interpolated, which is exactly what the real `createTranslator` does when no
// dictionary entry exists (`shared/src/lib/i18n/translate.ts`).
const t = ((key: string, fallback?: unknown, params?: Record<string, unknown>) => {
  const template = typeof fallback === 'string' ? fallback : key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] === undefined ? match : String(params[name]),
  )
}) as never

function fetcherFor(
  responses: Record<string, unknown>,
  calls?: Array<{ path: string; params: Record<string, string> }>,
): ListFetcher {
  return (async (path: string, params: Record<string, string>) => {
    calls?.push({ path, params })
    const response = responses[path]
    if (response instanceof Error) throw response
    return response ?? { items: [] }
  }) as ListFetcher
}

describe('buildSearchParams', () => {
  it('always requests one option page', () => {
    expect(buildSearchParams(undefined)).toEqual({ pageSize: String(OPTION_PAGE_SIZE) })
  })

  it('passes a trimmed query through as `search`', () => {
    expect(buildSearchParams('  Q-007 ')).toEqual({
      pageSize: String(OPTION_PAGE_SIZE),
      search: 'Q-007',
    })
  })

  it('omits `search` for a whitespace-only query', () => {
    expect(buildSearchParams('   ')).toEqual({ pageSize: String(OPTION_PAGE_SIZE) })
  })
})

describe('loadDocumentOptions', () => {
  it('merges quotes and orders into one list, encoding the kind into each value', async () => {
    const options = await loadDocumentOptions(
      undefined,
      t,
      fetcherFor({
        'sales/quotes': { items: [{ id: QUOTE_ID, quoteNumber: 'Q-0007' }] },
        'sales/orders': { items: [{ id: ORDER_ID, orderNumber: 'O-0031' }] },
      }),
    )

    expect(options).toEqual([
      { value: `quote:${QUOTE_ID}`, label: 'Quote Q-0007' },
      { value: `order:${ORDER_ID}`, label: 'Order O-0031' },
    ])
  })

  it('queries both sources with the same search params', async () => {
    const calls: Array<{ path: string; params: Record<string, string> }> = []
    await loadDocumentOptions('Q-00', t, fetcherFor({}, calls))

    expect(calls.map((call) => call.path).sort()).toEqual(['sales/orders', 'sales/quotes'])
    for (const call of calls) {
      expect(call.params).toEqual({ pageSize: String(OPTION_PAGE_SIZE), search: 'Q-00' })
    }
  })

  // The create page requires `sales.quotes.view` but NOT `sales.orders.view`, so a user
  // without the orders grant must still get a working quote picker.
  it('degrades the orders half to no options when it fails', async () => {
    const options = await loadDocumentOptions(
      undefined,
      t,
      fetcherFor({
        'sales/quotes': { items: [{ id: QUOTE_ID, quoteNumber: 'Q-0007' }] },
        'sales/orders': new Error('403'),
      }),
    )

    expect(options).toEqual([{ value: `quote:${QUOTE_ID}`, label: 'Quote Q-0007' }])
  })

  // The opposite of the line above, and the defect fixed in Task 4's review: a quotes
  // failure is a real error behind a hard gate and must NOT present as "no results".
  it('propagates a quotes failure instead of swallowing it', async () => {
    await expect(
      loadDocumentOptions(
        undefined,
        t,
        fetcherFor({ 'sales/quotes': new Error('boom'), 'sales/orders': { items: [] } }),
      ),
    ).rejects.toThrow('boom')
  })

  it('falls back to a shortened id when a document has no number', async () => {
    const options = await loadDocumentOptions(
      undefined,
      t,
      fetcherFor({ 'sales/quotes': { items: [{ id: QUOTE_ID, quoteNumber: null }] } }),
    )

    expect(options).toEqual([{ value: `quote:${QUOTE_ID}`, label: `Quote ${QUOTE_ID.slice(0, 8)}` }])
  })
})

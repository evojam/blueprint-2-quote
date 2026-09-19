import { describe, expect, it } from '@jest/globals'
import { loadDealOptions } from '../lib/deal-options'
import { OPTION_PAGE_SIZE, type ListFetcher } from '../lib/document-options'

const DEAL_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

const t = ((key: string, fallback?: unknown) =>
  typeof fallback === 'string' ? fallback : key) as never

function fetcherFor(
  response: unknown,
  calls?: Array<{ path: string; params: Record<string, string> }>,
): ListFetcher {
  return (async (path: string, params: Record<string, string>) => {
    calls?.push({ path, params })
    if (response instanceof Error) throw response
    return response
  }) as ListFetcher
}

describe('loadDealOptions', () => {
  it('maps deals to id-and-title options', async () => {
    const options = await loadDealOptions(
      undefined,
      t,
      fetcherFor({ items: [{ id: DEAL_ID, title: 'Kitchen refit' }] }),
    )
    expect(options).toEqual([{ value: DEAL_ID, label: 'Kitchen refit' }])
  })

  it('queries the deals list with the shared search params', async () => {
    const calls: Array<{ path: string; params: Record<string, string> }> = []
    await loadDealOptions(' refit ', t, fetcherFor({ items: [] }, calls))
    expect(calls).toEqual([
      { path: 'customers/deals', params: { pageSize: String(OPTION_PAGE_SIZE), search: 'refit' } },
    ])
  })

  it('omits the search param for an empty query', async () => {
    const calls: Array<{ path: string; params: Record<string, string> }> = []
    await loadDealOptions('   ', t, fetcherFor({ items: [] }, calls))
    expect(calls[0]?.params).toEqual({ pageSize: String(OPTION_PAGE_SIZE) })
  })

  // A deal with no title still has to be pickable — its id is what gets linked.
  it('falls back to a placeholder label when a deal has no title', async () => {
    const options = await loadDealOptions(
      undefined,
      t,
      fetcherFor({ items: [{ id: DEAL_ID, title: '   ' }] }),
    )
    expect(options).toEqual([{ value: DEAL_ID, label: 'Untitled deal' }])
  })

  // There is exactly one source here, so there is nothing to degrade to: this
  // loader must not manufacture an empty list on failure. `ComboboxInput`'s
  // `loadSuggestions` effect is what actually absorbs the rejection
  // (`.catch(() => {})`) and renders "No matches found" — that swallowing
  // happens one layer above this function, not inside it.
  it('propagates a failure instead of swallowing it', async () => {
    await expect(loadDealOptions(undefined, t, fetcherFor(new Error('boom')))).rejects.toThrow(
      'boom',
    )
  })

  it('tolerates a response with no items array', async () => {
    expect(await loadDealOptions(undefined, t, fetcherFor({}))).toEqual([])
  })
})

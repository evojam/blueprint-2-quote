import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { encodeDocumentRef } from './document-ref'

export type DocumentOption = { value: string; label: string }

/**
 * The shape of `fetchCrudList` (`@open-mercato/ui/backend/utils/crud`), narrowed to what
 * this module uses. Taken as a parameter rather than imported so the module — and its
 * test — never load a UI package under Jest's `node` environment, the same arrangement
 * `lib/link-labels.ts` uses.
 */
export type ListFetcher = <T>(
  apiPath: string,
  params: Record<string, string>,
) => Promise<{ items?: T[] }>

export const OPTION_PAGE_SIZE = 20

type QuoteItem = { id: string; quoteNumber: string | null }
type OrderItem = { id: string; orderNumber: string | null }

export function buildSearchParams(query: string | undefined): Record<string, string> {
  const params: Record<string, string> = { pageSize: String(OPTION_PAGE_SIZE) }
  const trimmed = (query ?? '').trim()
  if (trimmed) params.search = trimmed
  return params
}

/**
 * Loads quotes and orders side by side into ONE option list.
 *
 * Only the orders half is allowed to fail: the surfaces that call this require
 * `sales.quotes.view` but not `sales.orders.view`, so a user without the orders grant
 * still gets a working quote picker instead of a dead field. A quotes failure is NOT
 * swallowed — `sales.quotes.view` gates reaching these surfaces at all, so a genuine
 * failure there is a real error and must propagate to the caller rather than silently
 * presenting as "no results".
 */
export async function loadDocumentOptions(
  query: string | undefined,
  t: TranslateFn,
  fetchList: ListFetcher,
): Promise<DocumentOption[]> {
  const params = buildSearchParams(query)
  const [quotes, orders] = await Promise.all([
    fetchList<QuoteItem>('sales/quotes', params),
    fetchList<OrderItem>('sales/orders', params).catch(() => ({ items: [] as OrderItem[] })),
  ])
  const quoteOptions = (quotes?.items ?? []).map((item) => ({
    value: encodeDocumentRef({ documentKind: 'quote', documentId: item.id }),
    label: t('deal_links.option.quote', 'Quote {number}', {
      number: item.quoteNumber ?? item.id.slice(0, 8),
    }),
  }))
  const orderOptions = (orders?.items ?? []).map((item) => ({
    value: encodeDocumentRef({ documentKind: 'order', documentId: item.id }),
    label: t('deal_links.option.order', 'Order {number}', {
      number: item.orderNumber ?? item.id.slice(0, 8),
    }),
  }))
  return [...quoteOptions, ...orderOptions]
}

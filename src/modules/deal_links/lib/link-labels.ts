import { isDocumentKind } from './document-ref'

/**
 * One row of `GET /api/deal_links/document-links`.
 *
 * `document_kind` is typed `string`, not `DocumentKind`: the column is plain
 * text (`data/entities.ts`) and nothing at the database level stops a third
 * value from appearing. Narrowing happens where it is checked, not here.
 */
export type LinkRow = {
  id: string
  deal_id: string
  document_id: string
  document_kind: string
  created_at?: string | null
}

export type LookupIds = {
  dealIds: string[]
  quoteIds: string[]
  orderIds: string[]
}

export type LabelMaps = {
  deals: Record<string, string>
  quotes: Record<string, string>
  orders: Record<string, string>
}

export type LabelledLinkRow = LinkRow & {
  deal_label: string | null
  document_label: string | null
}

export type JsonFetcher = <T>(url: string) => Promise<T>

/**
 * `makeCrudRoute` accepts up to 200 ids per request
 * (`@open-mercato/shared/lib/crud/ids.ts` — `MAX_IDS_PER_REQUEST`), but both
 * `/api/customers/deals` and the sales document routes cap `pageSize` at 100,
 * so asking for more ids than that would silently truncate the response
 * instead of erroring. 100 is also twice the table's 50-row page, so the cap
 * is never reached in practice.
 */
export const MAX_LOOKUP_IDS = 100

function pushUnique(target: string[], value: string | null | undefined): void {
  if (!value) return
  if (target.length >= MAX_LOOKUP_IDS) return
  if (target.includes(value)) return
  target.push(value)
}

export function collectLookupIds(rows: LinkRow[]): LookupIds {
  const ids: LookupIds = { dealIds: [], quoteIds: [], orderIds: [] }
  for (const row of rows) {
    pushUnique(ids.dealIds, row.deal_id)
    if (!isDocumentKind(row.document_kind)) continue
    pushUnique(row.document_kind === 'order' ? ids.orderIds : ids.quoteIds, row.document_id)
  }
  return ids
}

function lookupUrl(base: string, ids: string[]): string | null {
  if (ids.length === 0) return null
  const params = new URLSearchParams({ ids: ids.join(','), pageSize: String(MAX_LOOKUP_IDS) })
  return `${base}?${params.toString()}`
}

export function buildLookupUrls(ids: LookupIds): {
  deals: string | null
  quotes: string | null
  orders: string | null
} {
  return {
    deals: lookupUrl('/api/customers/deals', ids.dealIds),
    quotes: lookupUrl('/api/sales/quotes', ids.quoteIds),
    orders: lookupUrl('/api/sales/orders', ids.orderIds),
  }
}

type LabelledItem = { id?: unknown } & Record<string, unknown>

/**
 * Fails soft on purpose (REQ-005). A 403 on `sales.orders.view`, or a route that
 * is simply not mounted, contributes an empty map; the table then shows the raw
 * id with a "not found" marker instead of rendering an error page over rows that
 * are otherwise perfectly readable.
 */
async function loadMap(
  url: string | null,
  labelField: string,
  fetchJson: JsonFetcher,
): Promise<Record<string, string>> {
  if (!url) return {}
  try {
    const payload = await fetchJson<{ items?: LabelledItem[] }>(url)
    const map: Record<string, string> = {}
    for (const item of payload?.items ?? []) {
      const id = item?.id
      const label = item?.[labelField]
      if (typeof id !== 'string' || typeof label !== 'string' || label.length === 0) continue
      map[id] = label
    }
    return map
  } catch {
    return {}
  }
}

export async function fetchLabelMaps(
  ids: LookupIds,
  fetchJson: JsonFetcher,
): Promise<LabelMaps> {
  const urls = buildLookupUrls(ids)
  const [deals, quotes, orders] = await Promise.all([
    loadMap(urls.deals, 'title', fetchJson),
    loadMap(urls.quotes, 'quoteNumber', fetchJson),
    loadMap(urls.orders, 'orderNumber', fetchJson),
  ])
  return { deals, quotes, orders }
}

export function applyLinkLabels(rows: LinkRow[], maps: LabelMaps): LabelledLinkRow[] {
  return rows.map((row) => {
    const documentMap = isDocumentKind(row.document_kind)
      ? row.document_kind === 'order'
        ? maps.orders
        : maps.quotes
      : null
    return {
      ...row,
      deal_label: maps.deals[row.deal_id] ?? null,
      document_label: documentMap ? documentMap[row.document_id] ?? null : null,
    }
  })
}

import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { buildSearchParams, type DocumentOption, type ListFetcher } from './document-options'

type DealItem = { id: string; title: string | null }

/**
 * Deal options for the picker on the sales document tab.
 *
 * Unlike `loadDocumentOptions` there is only one source, so there is no half to
 * degrade: a failure propagates to the caller rather than rendering as an empty
 * dropdown.
 *
 * HACK(hackathon): when tenant data encryption is on, the deals route collapses
 * any `search` to "no matches" rather than scanning ciphertext
 * (`customers/api/deals/route.ts:338`). What breaks: on such a tenant this
 * picker only ever shows the unfiltered first page, and typing empties it — so
 * a deal outside that page cannot be linked from the document side at all.
 */
export async function loadDealOptions(
  query: string | undefined,
  t: TranslateFn,
  fetchList: ListFetcher,
): Promise<DocumentOption[]> {
  const data = await fetchList<DealItem>('customers/deals', buildSearchParams(query))
  return (data?.items ?? []).map((item) => ({
    value: item.id,
    label: item.title?.trim() || t('deal_links.documentTab.untitledDeal', 'Untitled deal'),
  }))
}

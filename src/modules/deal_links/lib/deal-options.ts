import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { buildSearchParams, type DocumentOption, type ListFetcher } from './document-options'

type DealItem = { id: string; title: string | null }

/**
 * Deal options for the picker on the sales document tab.
 *
 * Unlike `loadDocumentOptions` there is only one source, so there is no half to
 * degrade to: this loader refuses to manufacture an empty list and lets a
 * failure propagate to its caller instead. The caller is `ComboboxInput`'s
 * `loadSuggestions` effect, which does swallow it (`.catch(() => {})` in
 * `@open-mercato/ui/backend/inputs/ComboboxInput.tsx`) and renders "No matches
 * found" — so the failure does still reach the user, just as an empty dropdown
 * one layer up rather than here.
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

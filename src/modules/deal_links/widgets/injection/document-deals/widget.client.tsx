"use client"

import * as React from 'react'
import Link from 'next/link'
import { Briefcase } from 'lucide-react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { Button } from '@open-mercato/ui/primitives/button'
import { createCrud, fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import { loadDealOptions } from '../../../lib/deal-options'
import {
  applyLinkLabels,
  collectLookupIds,
  fetchLabelMaps,
  type LabelledLinkRow,
  type LinkRow,
} from '../../../lib/link-labels'

type WidgetContext = { resourceId?: string; kind?: 'quote' | 'order' }

/**
 * Deliberately looser than a strict UUID validator (no version/variant nibble
 * pinning) for the same reason `document-ref.ts` is loose: the server's
 * `z.string().uuid()` on `documentLinkCreateSchema` is the authority on what is
 * acceptable, and a stricter client-side check could reject an id the API would
 * have taken.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isLikelyUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}

/**
 * `created_at` renders as `dd/mm/yyyy` (matches the deal-side tab). Not
 * locale-aware — matches the rest of this hackathon module.
 */
function formatCreatedAt(raw?: string | null): string {
  if (!raw) return '—'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return '—'
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${date.getFullYear()}`
}

export default function DocumentDealsWidget({ context }: InjectionWidgetComponentProps<WidgetContext>) {
  const t = useT()
  const documentId = context?.resourceId ?? null
  const documentKind = context?.kind ?? null
  const [items, setItems] = React.useState<LabelledLinkRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState('')
  const [linking, setLinking] = React.useState(false)
  const [linkError, setLinkError] = React.useState<string | null>(null)

  // Counts each invocation so a stale in-flight response can never overwrite a
  // newer one — the same guarantee the previous `cancelled` flag gave, but
  // re-runnable: `linkSelected` calls `load()` again after a successful link.
  const requestRef = React.useRef(0)

  const load = React.useCallback(async () => {
    const requestId = ++requestRef.current
    if (!documentId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const payload = await readApiResultOrThrow<{ items?: LinkRow[] }>(
        `/api/deal_links/document-links?documentId=${encodeURIComponent(documentId)}`,
      )
      if (requestRef.current !== requestId) return
      const rows = payload?.items ?? []
      // Only the deals half of the label maps is needed here — the rows already
      // belong to this one document, so no `/api/sales/*` lookup is issued.
      const maps = await fetchLabelMaps(
        { ...collectLookupIds(rows), quoteIds: [], orderIds: [] },
        (url) => readApiResultOrThrow(url),
      )
      if (requestRef.current !== requestId) return
      setItems(applyLinkLabels(rows, maps))
    } catch (err: unknown) {
      if (requestRef.current !== requestId) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }, [documentId])

  React.useEffect(() => {
    void load()
  }, [load])

  // Deferred minor from Task 6's review (deal-side sibling): a document-to-document
  // navigation without a full widget remount must not leak the previous document's
  // in-flight picker state.
  React.useEffect(() => {
    setSelected('')
    setLinking(false)
    setLinkError(null)
  }, [documentId])

  // HACK(hackathon): the picker renders for anyone who can see the tab, because there is
  // no client-side permission hook in this framework — `shared/src/lib/frontend/` ships
  // only organization/notification/progress helpers, and a widget-level `features` gate
  // (`shared/modules/widgets/injection.ts`) would hide the LIST too, which every
  // `customers.deals.view` holder is entitled to see. What breaks: a user holding
  // `customers.deals.view` without `customers.deals.manage` sees a control that answers
  // with a 403 when used. The 403 is surfaced, not swallowed.
  const linkSelected = React.useCallback(async () => {
    if (!documentId || !documentKind || !isLikelyUuid(selected)) return
    setLinking(true)
    setLinkError(null)
    try {
      await createCrud('deal_links/document-links', {
        dealId: selected,
        documentId,
        documentKind,
      })
      setSelected('')
      await load()
    } catch (err: unknown) {
      setLinkError(
        err instanceof Error && err.message
          ? err.message
          : t('deal_links.documentTab.link.error', 'Could not link the deal.'),
      )
    } finally {
      setLinking(false)
    }
  }, [documentId, documentKind, load, selected, t])

  const count = items.length
  const summary =
    count === 1
      ? t('deal_links.documentTab.summary.one', '{count} linked deal', { count })
      : t('deal_links.documentTab.summary.other', '{count} linked deals', { count })

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/10 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-foreground">
            {t('deal_links.documentTab.title', 'Linked deals')}
          </div>
          <div className="text-sm text-muted-foreground">{summary}</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:w-[260px]">
            <ComboboxInput
              value={selected}
              onChange={setSelected}
              placeholder={t('deal_links.documentTab.link.placeholder', 'Search deals by title…')}
              loadSuggestions={(query?: string) => loadDealOptions(query, t, fetchCrudList)}
              allowCustomValues={false}
              clearable
              disabled={linking || !documentId}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 rounded-lg px-3"
            disabled={!isLikelyUuid(selected) || linking || !documentId}
            onClick={linkSelected}
          >
            {t('deal_links.documentTab.link.submit', 'Link')}
          </Button>
        </div>
      </div>

      {linkError ? <div className="text-sm text-destructive">{linkError}</div> : null}

      {loading ? (
        <div className="text-sm text-muted-foreground">{t('deal_links.state.loading', 'Loading…')}</div>
      ) : error ? (
        <div className="text-sm text-destructive">
          {t('deal_links.documentTab.error', 'Could not load the linked deals.')}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-border bg-muted/20 px-5 py-5 text-sm text-muted-foreground">
          {t('deal_links.documentTab.empty', 'No deal is linked to this document yet.')}
        </div>
      ) : (
        // No filter input over already-linked rows, no pagination, no "Manage links"
        // button, no `LinkEntityDialog` modal — deliberately not copied from the
        // installed `DealLinkedEntitiesTab`, mirroring the deal-side tab.
        <div className="space-y-3">
          {items.map((item) => {
            const label =
              item.deal_label ??
              `${item.deal_id.slice(0, 8)}… (${t('deal_links.documentTab.unresolved', 'not found')})`
            const subtitle = formatCreatedAt(item.created_at)
            return (
              <Link
                key={item.id}
                href={`/backend/customers/deals/${item.deal_id}`}
                className="flex items-start gap-3 rounded-xl border border-border/70 bg-card px-4 py-4 transition-colors hover:bg-accent"
              >
                <div className="mt-0.5 rounded-full bg-muted p-2 text-muted-foreground">
                  <Briefcase className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">{label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

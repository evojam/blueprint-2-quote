"use client"

import * as React from 'react'
import Link from 'next/link'
import { FileText } from 'lucide-react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { Button } from '@open-mercato/ui/primitives/button'
import { createCrud, fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import { decodeDocumentRef, isDocumentKind } from '../../../lib/document-ref'
import { loadDocumentOptions } from '../../../lib/document-options'
import {
  applyLinkLabels,
  collectLookupIds,
  fetchLabelMaps,
  type LabelledLinkRow,
  type LinkRow,
} from '../../../lib/link-labels'

type WidgetContext = { dealId?: string }

/**
 * `created_at` renders as `dd/mm/yyyy` (the brief's example: "Quote · 19/09/2026").
 * Not locale-aware — matches the rest of this hackathon module.
 */
function formatCreatedAt(raw?: string | null): string {
  if (!raw) return '—'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return '—'
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${date.getFullYear()}`
}

export default function DealDocumentsWidget({ context }: InjectionWidgetComponentProps<WidgetContext>) {
  const t = useT()
  const dealId = context?.dealId ?? null
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
    if (!dealId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const payload = await readApiResultOrThrow<{ items?: LinkRow[] }>(
        `/api/deal_links/document-links?dealId=${encodeURIComponent(dealId)}`,
      )
      if (requestRef.current !== requestId) return
      const rows = payload?.items ?? []
      // A failed label lookup (`fetchLabelMaps` fails soft) leaves the rows visible
      // with the shortened-id fallback rather than hiding the whole list.
      const maps = await fetchLabelMaps(collectLookupIds(rows), (url) => readApiResultOrThrow(url))
      if (requestRef.current !== requestId) return
      setItems(applyLinkLabels(rows, maps))
    } catch (err: unknown) {
      if (requestRef.current !== requestId) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }, [dealId])

  React.useEffect(() => {
    void load()
  }, [load])

  // Deferred minor from Task 6's review: a deal-to-deal navigation without a full
  // widget remount must not leak the previous deal's in-flight picker state.
  React.useEffect(() => {
    setSelected('')
    setLinking(false)
    setLinkError(null)
  }, [dealId])

  // HACK(hackathon): the picker renders for anyone who can see the tab, because there is
  // no client-side permission hook in this framework — `shared/src/lib/frontend/` ships
  // only organization/notification/progress helpers, and a widget-level `features` gate
  // (`shared/modules/widgets/injection.ts`) would hide the LIST too, which every
  // `customers.deals.view` holder is entitled to see. What breaks: a user holding
  // `customers.deals.view` without `customers.deals.manage` sees a control that answers
  // with a 403 when used. The 403 is surfaced, not swallowed.
  const linkSelected = React.useCallback(async () => {
    const ref = decodeDocumentRef(selected)
    if (!dealId || !ref) return
    setLinking(true)
    setLinkError(null)
    try {
      await createCrud('deal_links/document-links', {
        dealId,
        documentId: ref.documentId,
        documentKind: ref.documentKind,
      })
      setSelected('')
      await load()
    } catch (err: unknown) {
      setLinkError(
        err instanceof Error && err.message
          ? err.message
          : t('deal_links.widget.link.error', 'Could not link the document.'),
      )
    } finally {
      setLinking(false)
    }
  }, [dealId, load, selected, t])

  const count = items.length
  const summary =
    count === 1
      ? t('deal_links.widget.summary.one', '{count} linked document', { count })
      : t('deal_links.widget.summary.other', '{count} linked documents', { count })

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/10 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-foreground">
            {t('deal_links.widget.title', 'Linked documents')}
          </div>
          <div className="text-sm text-muted-foreground">{summary}</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:w-[260px]">
            <ComboboxInput
              value={selected}
              onChange={setSelected}
              placeholder={t('deal_links.widget.link.placeholder', 'Search by quote or order number…')}
              loadSuggestions={(query?: string) => loadDocumentOptions(query, t, fetchCrudList)}
              clearable
              disabled={linking || !dealId}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 rounded-lg px-3"
            disabled={!selected || linking || !dealId}
            onClick={linkSelected}
          >
            {t('deal_links.widget.link.submit', 'Link')}
          </Button>
        </div>
      </div>

      {linkError ? <div className="text-sm text-destructive">{linkError}</div> : null}

      {loading ? (
        <div className="text-sm text-muted-foreground">{t('deal_links.state.loading', 'Loading…')}</div>
      ) : error ? (
        <div className="text-sm text-destructive">
          {t('deal_links.state.error', 'Could not load the linked documents.')}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-border bg-muted/20 px-5 py-5 text-sm text-muted-foreground">
          {t('deal_links.state.empty', 'No quote has been produced for this case yet.')}
        </div>
      ) : (
        // No filter input over already-linked rows, no pagination, no "Manage links"
        // button, no `LinkEntityDialog` modal — deliberately not copied from the
        // installed `DealLinkedEntitiesTab`. A deal carries a handful of documents,
        // and the user asked for no modal.
        <div className="space-y-3">
          {items.map((item) => {
            const kind = isDocumentKind(item.document_kind) ? item.document_kind : 'quote'
            const href = kind === 'order' ? `/backend/sales/orders/${item.document_id}` : `/backend/sales/quotes/${item.document_id}`
            const kindLabel = kind === 'order' ? t('deal_links.kind.order', 'Order') : t('deal_links.kind.quote', 'Quote')
            const label =
              item.document_label ??
              `${item.document_id.slice(0, 8)}… (${t('deal_links.widget.unresolved', 'not found')})`
            const subtitle = `${kindLabel} · ${formatCreatedAt(item.created_at)}`
            return (
              <Link
                key={item.id}
                href={href}
                className="flex items-start gap-3 rounded-xl border border-border/70 bg-card px-4 py-4 transition-colors hover:bg-accent"
              >
                <div className="mt-0.5 rounded-full bg-muted p-2 text-muted-foreground">
                  <FileText className="size-4" />
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

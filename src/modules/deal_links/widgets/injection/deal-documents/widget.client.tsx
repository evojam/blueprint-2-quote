"use client"

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'

type WidgetContext = { dealId?: string }

type LinkRow = {
  id: string
  document_id: string
  document_kind: string
  created_at?: string
}

export default function DealDocumentsWidget({ context }: InjectionWidgetComponentProps<WidgetContext>) {
  const t = useT()
  const dealId = context?.dealId ?? null
  const [items, setItems] = React.useState<LinkRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    if (!dealId) {
      setLoading(false)
      return () => { cancelled = true }
    }
    setLoading(true)
    setError(null)
    readApiResultOrThrow<{ items?: LinkRow[] }>(
      `/api/deal_links/document-links?dealId=${encodeURIComponent(dealId)}`,
    )
      .then((payload) => {
        if (cancelled) return
        setItems(payload?.items ?? [])
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [dealId])

  if (loading) {
    return <div className="text-sm text-muted-foreground">{t('deal_links.state.loading', 'Loading…')}</div>
  }
  if (error) {
    return <div className="text-sm text-destructive">{t('deal_links.state.error', 'Could not load the linked documents.')}</div>
  }
  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        {t('deal_links.state.empty', 'No quote has been produced for this case yet.')}
      </div>
    )
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-3 rounded border px-3 py-2">
          <span className="text-xs uppercase text-muted-foreground">
            {item.document_kind === 'order'
              ? t('deal_links.kind.order', 'Order')
              : t('deal_links.kind.quote', 'Quote')}
          </span>
          <a
            className="text-sm underline"
            href={`/backend/sales/${item.document_kind === 'order' ? 'orders' : 'quotes'}/${item.document_id}`}
          >
            {item.document_id}
          </a>
        </li>
      ))}
    </ul>
  )
}

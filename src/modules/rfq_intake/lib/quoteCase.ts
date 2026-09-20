import type { EntityManager } from '@mikro-orm/postgresql'
import { SalesQuote } from '@open-mercato/core/modules/sales/data/entities'
import { DealDocumentLink } from '@/modules/deal_links/data/entities'
import type { Scope } from './pipeline'

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export type QuoteCase = {
  dealId: string
  currencyCode: string
}

/**
 * The case a quote was priced for, or `null` when it was not priced for one.
 *
 * Two sources because the two are written by different code at different times, and
 * either can be the only one present. `metadata.rfqDealId` is stamped by
 * `rfq_intake.quote.create` as part of the quote itself, so it survives anything that
 * happens to the link table; the `deal_links` row is what the UI actually renders and
 * is also what a quote linked to a case by hand would carry. Metadata is consulted
 * first because it is the one this module wrote and cannot be detached by an operator.
 *
 * Lives here rather than in either caller because two of them now ask the same question
 * — the value sync (`subscribers/sync-deal-value.ts`) and the send-side funnel move
 * (`lib/quoteSentFunnel.ts`) — and a second spelling of "which case does this quote
 * answer" would let them disagree about which deal a quote belongs to.
 */
export async function resolveCaseId(
  em: EntityManager,
  scope: Scope,
  quoteId: string,
): Promise<QuoteCase | null> {
  const quote = await em.findOne(SalesQuote, { id: quoteId, ...scope, deletedAt: null })
  if (!quote) return null

  const metadata = (quote.metadata ?? null) as Record<string, unknown> | null
  const stamped = trimmed(metadata?.rfqDealId)
  if (stamped) return { dealId: stamped, currencyCode: quote.currencyCode }

  const link = await em.findOne(DealDocumentLink, {
    documentId: quoteId,
    documentKind: 'quote',
    ...scope,
    deletedAt: null,
  })
  const linked = trimmed(link?.dealId)
  return linked ? { dealId: linked, currencyCode: quote.currencyCode } : null
}

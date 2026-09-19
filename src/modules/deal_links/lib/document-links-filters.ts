import { z } from 'zod'

/**
 * Filter builder and query schema for `api/document-links/route.ts`'s list,
 * pulled out of the route file so they can be imported and asserted on without
 * dragging in `makeCrudRoute` (and, transitively, MikroORM's Postgres driver
 * and the ESM-only `kysely` package) at module load time — the same reason
 * `lib/route-access.ts` exists. See the HACK note on
 * `../__tests__/document-links-route.test.ts`.
 *
 * `querySchema` in particular matters here: it is the one thing standing
 * between "list this document's links" and "list every link in the caller's
 * organization" if `documentId` were ever dropped from it. That is a
 * fail-open within the tenant, not an empty list, and `buildDocumentLinkFilters`
 * tests alone would not catch it — they only prove the filter logic is correct
 * for whatever query shape reaches it.
 */
export const documentLinksListQuerySchema = z.object({
  dealId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(50),
  sortField: z.string().optional().default('created_at'),
  sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
})

export type DocumentLinksListQuery = z.infer<typeof documentLinksListQuerySchema>

export type DocumentLinkListQuery = {
  dealId?: string
  documentId?: string
}

/**
 * Both filters are optional and independent. Supplying neither yields an empty
 * filter set, which is byte-identical to the behaviour before `documentId`
 * existed — the additive-change guarantee in
 * `.ai/specs/2026-09-20-document-side-deal-links.md`. Supplying both narrows to
 * the single row joining that deal to that document.
 */
export function buildDocumentLinkFilters(
  query: DocumentLinkListQuery,
): Record<string, unknown> {
  const filters: Record<string, unknown> = {}
  if (query.dealId) filters.deal_id = query.dealId
  if (query.documentId) filters.document_id = query.documentId
  return filters
}

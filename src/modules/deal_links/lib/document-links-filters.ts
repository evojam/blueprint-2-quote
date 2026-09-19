/**
 * Filter builder for `api/document-links/route.ts`'s list, pulled out of the route
 * file so it can be imported and asserted on without dragging in `makeCrudRoute`
 * (and, transitively, MikroORM's Postgres driver and the ESM-only `kysely`
 * package) at module load time — the same reason `lib/route-access.ts` exists.
 * See the HACK note on `../__tests__/document-links-route.test.ts`.
 */
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

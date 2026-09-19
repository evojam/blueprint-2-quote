/**
 * Access metadata for `api/document-links/route.ts`, pulled out of the route
 * file so it can be imported and asserted on without dragging in
 * `makeCrudRoute` (and, transitively, MikroORM's Postgres driver and the
 * ESM-only `kysely` package) at module load time. See the HACK note on
 * `../__tests__/document-links-route.test.ts` for why that matters.
 */
// No `as const`: `makeCrudRoute`'s `CrudMetadata['requireFeatures']` is typed
// `string[]` (mutable), and a `readonly [...]` tuple does not structurally
// match it (`shared/src/lib/crud/factory.ts:159`). The test still asserts
// exact array contents via `toEqual`, which does not care about mutability.
export const documentLinksRouteAccess = {
  GET: { requireAuth: true, requireFeatures: ['customers.deals.view'] },
  POST: { requireAuth: true, requireFeatures: ['customers.deals.manage'] },
}

/**
 * The datamodel entity id the generator registers for `DealDocumentLink`
 * (`.mercato/generated/entities.ids.generated.ts` -> `E.deal_links.deal_document_link`).
 * `makeCrudRoute`'s `list.entityId` takes the QueryEngine branch whenever both
 * `entityId` and `fields` are set, and resolves the table by PascalCasing this
 * id's second segment and looking up the registered class. Getting it wrong
 * silently falls through to a table-name guess that does not exist
 * (`document_links` instead of the real `deal_document_links`), so it lives
 * here, under test, rather than as an inline literal in `route.ts`.
 */
export const DOCUMENT_LINK_ENTITY_ID = 'deal_links:deal_document_link'

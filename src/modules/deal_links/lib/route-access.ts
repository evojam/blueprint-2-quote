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

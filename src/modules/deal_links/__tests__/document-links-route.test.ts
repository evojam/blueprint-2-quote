import { describe, expect, it, jest } from '@jest/globals'

jest.mock('@open-mercato/shared/lib/commands', () => ({
  registerCommand: jest.fn(),
}))

// HACK(hackathon): asserts the metadata object the route is GIVEN
// (`documentLinksRouteAccess`), not the object `makeCrudRoute` returns as
// `route.ts`'s own `metadata` export. Importing `../api/document-links/route`
// directly pulls in `makeCrudRoute` -> MikroORM's Postgres driver -> `kysely`,
// which ships ESM-only with no CJS build; Jest can only `require(esm)` it
// natively on Node >= 24.9, and this environment runs v24.3.0. That makes the
// suite fail to load entirely, not fail an assertion. Testing the input
// object still catches the failure that matters here — someone changing or
// dropping a required feature — but it no longer proves `makeCrudRoute`
// passes `metadata` through unaltered. Remove this hack once the dev/CI Node
// runtime is >= 24.9: switch the import back to
// `import { metadata } from '../api/document-links/route'` and assert
// against that.
import { documentLinksRouteAccess as metadata, DOCUMENT_LINK_ENTITY_ID } from '../lib/route-access'
import { E } from '@/.mercato/generated/entities.ids.generated'

describe('deal document links route', () => {
  it('requires authentication on every exposed method', () => {
    expect(metadata.GET?.requireAuth).toBe(true)
    expect(metadata.POST?.requireAuth).toBe(true)
  })

  /**
   * Reading a deal's links is reading the deal. Writing one is changing it. The
   * two features already exist upstream (`customers/acl.ts:17,23`), so the link
   * surface introduces no new grant of its own.
   */
  it('gates reads behind deal view and writes behind deal manage', () => {
    expect(metadata.GET?.requireFeatures).toEqual(['customers.deals.view'])
    expect(metadata.POST?.requireFeatures).toEqual(['customers.deals.manage'])
  })

  // Depends on `yarn generate` having run: `.mercato/generated` is gitignored,
  // so `E.deal_links.deal_document_link` only exists locally after generation.
  // That is already the repo's gate order (`generate && typecheck && lint`),
  // but a stale checkout without a generate run will fail this test with a
  // module-resolution error rather than an assertion failure — that is
  // expected, not a bug in the test.
  it('uses the entity id the generator actually registers', () => {
    expect(DOCUMENT_LINK_ENTITY_ID).toBe(E.deal_links.deal_document_link)
  })
})

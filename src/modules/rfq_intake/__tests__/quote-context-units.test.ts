import { describe, expect, it } from '@jest/globals'
import type { EntityManager } from '@mikro-orm/postgresql'

import { loadCatalogUnits } from '../lib/catalogUnits'

type MatcherData = Parameters<typeof loadCatalogUnits>[2]

const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' }

const PAINTING = '05af744a-0a2d-4771-b647-e1288677b9e3'
const PLASTER = '1d16a1d0-512b-4968-a1e5-c14ee6c7e618'
const GONE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

function matcherData(productIds: string[][]): MatcherData {
  return {
    contractVersion: 2,
    warnings: [],
    needs: productIds.map((ids, needIndex) => ({
      needIndex,
      sourceExcerpt: `need ${needIndex}`,
      queryTerms: [`term-${needIndex}`],
      unmatchedTerms: [],
      matches: ids.map((catalogProductId) => ({
        catalogProductId,
        title: 'Matched title the matcher authored',
        score: 0.9,
        matchedEvidence: ['evidence'],
        reason: 'reason',
      })),
    })),
  } as MatcherData
}

function fakeEm(products: { id: string; title: string; defaultUnit: string | null }[]): {
  em: EntityManager
  queried: () => string[]
} {
  let queried: string[] = []
  const em = {
    async find(_entity: unknown, where: { id: { $in: string[] } }) {
      queried = where.id.$in
      return products.filter((product) => where.id.$in.includes(product.id))
    },
  } as unknown as EntityManager
  return { em, queried: () => queried }
}

describe('loadCatalogUnits', () => {
  it('reads the billing unit of every matched product from Catalog, once per product', async () => {
    const { em, queried } = fakeEm([
      { id: PAINTING, title: 'Malowanie ścian i sufitów', defaultUnit: 'm2' },
      { id: PLASTER, title: 'Gładź gipsowa jednowarstwowa', defaultUnit: 'm2' },
    ])

    const units = await loadCatalogUnits(em, SCOPE, matcherData([[PAINTING], [PLASTER, PAINTING]]))

    expect(queried()).toEqual([PAINTING, PLASTER])
    expect(units).toEqual([
      { catalogProductId: PAINTING, title: 'Malowanie ścian i sufitów', defaultUnit: 'm2' },
      { catalogProductId: PLASTER, title: 'Gładź gipsowa jednowarstwowa', defaultUnit: 'm2' },
    ])
  })

  it('reports a unit no basis can produce as null rather than coercing it', async () => {
    const { em } = fakeEm([{ id: PAINTING, title: 'Usługa rozliczana godzinowo', defaultUnit: 'h' }])

    const units = await loadCatalogUnits(em, SCOPE, matcherData([[PAINTING]]))

    expect(units).toEqual([
      { catalogProductId: PAINTING, title: 'Usługa rozliczana godzinowo', defaultUnit: null },
    ])
  })

  it('omits a product that is no longer readable in scope, and queries nothing without matches', async () => {
    const { em } = fakeEm([{ id: PAINTING, title: 'Malowanie ścian i sufitów', defaultUnit: 'm2' }])

    expect(await loadCatalogUnits(em, SCOPE, matcherData([[PAINTING, GONE]]))).toEqual([
      { catalogProductId: PAINTING, title: 'Malowanie ścian i sufitów', defaultUnit: 'm2' },
    ])
    expect(await loadCatalogUnits(em, SCOPE, matcherData([[]]))).toEqual([])
  })
})

/**
 * The billing unit of every product the catalog matcher named, read from Catalog.
 *
 * `rfq_intake.quote.create` refuses any item whose basis produced a unit other than the
 * product's `defaultUnit` (`commands/quote-create.ts`, warning `unit_mismatch:<index>`),
 * and the drafter had no way to see that unit at all: the matcher's result carries id,
 * title, score and evidence only. A drafter pairing a product billed in m2 with
 * `basis: 'count'` therefore produced a proposal that looked healthy, was auto-approved,
 * and yielded a quote with zero lines.
 *
 * Read server-side on purpose. A unit is a catalog fact, and a model-authored one would
 * be exactly the kind of plausible invention the gate exists to catch.
 *
 * Lives outside `ai-tools.ts` so it can be exercised without loading the agent registry.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import { CatalogProduct } from '@open-mercato/core/modules/catalog/data/entities'
import { z } from 'zod'

import { QUOTE_UNITS, isQuoteUnit } from './quoteContracts'

export const catalogUnitSchema = z.object({
  catalogProductId: z.string().uuid(),
  title: z.string().min(1).max(500),
  /** Null when Catalog bills the product in something no basis can produce. */
  defaultUnit: z.enum(QUOTE_UNITS).nullable(),
}).strict()

export type CatalogUnit = z.infer<typeof catalogUnitSchema>

/** The shape this reads out of the matcher's v2 envelope — its needs and their matches. */
export type MatchedProducts = { needs: { matches: { catalogProductId: string }[] }[] }

/**
 * One query for every matched product. A product the matcher named but that is no longer
 * readable in this scope is simply absent from the result, which the drafter must treat
 * the same way as an unquotable unit: skip the item.
 */
export async function loadCatalogUnits(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  matches: MatchedProducts,
): Promise<CatalogUnit[]> {
  const ids = [
    ...new Set(matches.needs.flatMap((need) => need.matches.map((match) => match.catalogProductId))),
  ]
  if (ids.length === 0) return []
  const products = await em.find(CatalogProduct, { id: { $in: ids }, ...scope, deletedAt: null })
  return products.map((product) => ({
    catalogProductId: product.id,
    title: product.title,
    defaultUnit: isQuoteUnit(product.defaultUnit) ? product.defaultUnit : null,
  }))
}

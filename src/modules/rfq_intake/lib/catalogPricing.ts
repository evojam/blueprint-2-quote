/**
 * The catalog half of a quote line: which variant an item actually means, and what one
 * unit of it costs.
 *
 * Two functions rather than one, because the unit gate has to close BEFORE the price
 * tables are touched: an item whose basis (say `floor_area`, in m2) does not match the
 * product's billing unit is not a cheaper line, it is a wrong line, and the caller must
 * be able to refuse it without having read a price at all.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CatalogProduct,
  CatalogProductPrice,
  CatalogProductVariant,
} from '@open-mercato/core/modules/catalog/data/entities'
import { resolvePriceVariantId } from '@open-mercato/core/modules/catalog/lib/pricing'
import type {
  CatalogPricingService,
  PriceRow,
} from '@open-mercato/core/modules/catalog/services/catalogPricingService'
import {
  fail,
  isQuoteUnit,
  ok,
  type PriceFailureCode,
  type ProductFailureCode,
  type QuotableProduct,
  type Resolved,
  type UnitPrice,
} from './quoteContracts'

type Scope = { tenantId: string; organizationId: string }

/** Only ever the pricing service; a bare shape keeps the callers free of Awilix types. */
type Container = { resolve: (name: string) => unknown }

/**
 * A MikroORM ManyToOne comes back either as a loaded entity or as the bare foreign key,
 * depending on whether the owning side was populated. Reading `.id` off a string is
 * `undefined`, which would make a foreign variant compare equal to nothing and slip
 * through the identity check, so both shapes are normalised here.
 */
function relationId(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return null
}

/**
 * MikroORM hands a `numeric` column back as a string, which is the only form money and
 * tax rates may travel in here — parsing to a float loses grosze. A driver that hands
 * back a number is stringified rather than dropped, so a rate is never silently lost,
 * and anything else becomes null.
 */
function numericString(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * Resolves the product and the single variant a quote line will be written against.
 *
 * A supplied variant is never replaced by the default one: a caller that names a variant
 * has made a choice, and silently quoting a different SKU at a plausible price is the one
 * failure nobody would catch by reading the quote.
 */
export async function loadQuotableProduct(
  em: EntityManager,
  scope: Scope,
  args: { productId: string; variantId?: string },
): Promise<Resolved<QuotableProduct, ProductFailureCode>> {
  const product = await em.findOne(CatalogProduct, {
    id: args.productId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
  })
  if (!product) return fail('product_not_found')

  const variant = args.variantId
    ? await em.findOne(CatalogProductVariant, {
        id: args.variantId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      })
    : await em.findOne(CatalogProductVariant, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        product: args.productId,
        isDefault: true,
        deletedAt: null,
      })
  if (!variant) return fail('variant_not_found')

  if (relationId(variant.product) !== product.id) return fail('variant_foreign')

  // Refused rather than filtered out of the query above: an operator who named a variant
  // that exists but is withdrawn needs to read why the line vanished, and
  // `variant_not_found` would send them hunting for a typo instead.
  if (!variant.isActive) return fail('variant_inactive')

  // `default_unit` is free text in Catalog, so it is narrowed here once. A product billed
  // in something we cannot quantify is refused rather than coerced into one of our units.
  if (!isQuoteUnit(product.defaultUnit)) return fail('unit_unsupported')

  return ok({
    productId: product.id,
    variantId: variant.id,
    title: product.title,
    defaultUnit: product.defaultUnit,
    // Tax identity is a catalog fact, not a price-row one. The variant wins because a
    // variant may be taxed differently from the rest of its product; the product is the
    // fallback because most variants simply inherit it.
    taxRateId: variant.taxRateId ?? product.taxRateId ?? null,
  })
}

/**
 * Resolves one unit's gross price for an already-validated variant.
 *
 * Price selection itself belongs to the installed pricing service — tiers, promotions,
 * channel and date windows are its rules, and reimplementing the pick here would drift
 * from whatever the storefront charges.
 */
export async function resolveUnitPrice(
  em: EntityManager,
  container: Container,
  scope: Scope,
  args: { productId: string; variantId: string; quantity: number },
): Promise<Resolved<UnitPrice, PriceFailureCode>> {
  // Prices are variant-bound in this catalog: `catalog.prices.create` writes every seeded
  // row into `catalog_product_variant_prices` with a `variantId`. Widening the query to
  // the product would pull in a sibling variant's amount.
  // `CatalogProductPrice` carries no `deleted_at` column — price rows are hard-deleted —
  // so unlike the product and variant reads there is no soft-delete filter to apply.
  const rows = (await em.find(CatalogProductPrice, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    variant: args.variantId,
  })) as unknown as PriceRow[]
  if (rows.length === 0) return fail('no_price')

  const pricing = container.resolve('catalogPricingService') as CatalogPricingService
  const resolved = await pricing.resolvePrice(rows, { quantity: args.quantity, date: new Date() })
  if (!resolved) return fail('no_price')

  // A pricing extension is allowed to adjust an amount for the same identity; swapping the
  // identity means the quote would name one variant and bill another.
  if (resolvePriceVariantId(resolved) !== args.variantId) return fail('price_identity_mismatch')

  // Gross, because the seeded rows are written as `unitPriceGross` against a VAT 8% rate.
  // A row with only a net amount cannot be quoted without re-deriving the tax here, which
  // is the tax service's job, not ours.
  const unitPriceGross = numericString(resolved.unitPriceGross)
  if (!unitPriceGross) return fail('no_price')

  return ok({
    currencyCode: resolved.currencyCode,
    unitPriceGross,
    // The rate that actually produced this gross amount: `catalog.prices.create` persists
    // the derived `tax_rate` and no `tax_rate_id`, so the identity comes from the product
    // side instead. Carried as the raw numeric string.
    taxRate: numericString(resolved.taxRate),
    priceId: resolved.id,
  })
}

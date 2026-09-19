import { describe, expect, it } from '@jest/globals'

import { loadQuotableProduct, resolveUnitPrice } from '../lib/catalogPricing'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

const PRODUCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_PRODUCT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const VARIANT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_VARIANT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PRICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const VARIANT_VAT_ID = '11111111-aaaa-4aaa-8aaa-111111111111'
const PRODUCT_VAT_ID = '22222222-aaaa-4aaa-8aaa-222222222222'

type Row = Record<string, unknown>

/**
 * The entity classes are matched by name rather than by reference so a stub row stays a
 * plain object; the production code still has to ask for the right table.
 */
function entityName(entity: unknown): string {
  return typeof entity === 'function' ? entity.name : String(entity)
}

/** A relation stub may be an entity or a bare id, exactly as MikroORM hands one back. */
function fieldValue(row: Row, key: string): unknown {
  const value = row[key]
  if (value && typeof value === 'object' && 'id' in (value as Row)) return (value as Row).id
  return value
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = fieldValue(row, key)
    if (expected === null) return actual === null || actual === undefined
    return actual === expected
  })
}

type Store = { products?: Row[]; variants?: Row[]; prices?: Row[] }

type EmCall = { entity: string; where: Row }

function makeEm(store: Store) {
  const calls: EmCall[] = []
  function pool(entity: unknown): Row[] {
    switch (entityName(entity)) {
      case 'CatalogProduct':
        return store.products ?? []
      case 'CatalogProductVariant':
        return store.variants ?? []
      case 'CatalogProductPrice':
        return store.prices ?? []
      default:
        throw new Error(`unexpected entity ${entityName(entity)}`)
    }
  }
  const em = {
    async findOne(entity: unknown, where: Row) {
      calls.push({ entity: entityName(entity), where })
      return pool(entity).find((row) => matches(row, where)) ?? null
    },
    async find(entity: unknown, where: Row) {
      calls.push({ entity: entityName(entity), where })
      return pool(entity).filter((row) => matches(row, where))
    },
  }
  return { em: em as never, calls }
}

function makeContainer(resolvePrice: (rows: Row[], context: Row) => unknown) {
  const calls: Array<{ rows: Row[]; context: Row }> = []
  const container = {
    resolve(name: string) {
      if (name === 'catalogPricingService') {
        return {
          resolvePrice: async (rows: Row[], context: Row) => {
            calls.push({ rows, context })
            return resolvePrice(rows, context)
          },
        }
      }
      throw new Error(`unexpected resolve ${name}`)
    },
  }
  return { container, calls }
}

function product(overrides: Row = {}): Row {
  return {
    id: PRODUCT_ID,
    ...scope,
    title: 'Gładź gipsowa',
    defaultUnit: 'm2',
    taxRateId: PRODUCT_VAT_ID,
    ...overrides,
  }
}

function variant(overrides: Row = {}): Row {
  return {
    id: VARIANT_ID,
    ...scope,
    product: PRODUCT_ID,
    isDefault: true,
    isActive: true,
    taxRateId: VARIANT_VAT_ID,
    ...overrides,
  }
}

function quotable(overrides: Row = {}): Row {
  return {
    productId: PRODUCT_ID,
    variantId: VARIANT_ID,
    title: 'Gładź gipsowa',
    defaultUnit: 'm2',
    taxRateId: VARIANT_VAT_ID,
    ...overrides,
  }
}

function priceRow(overrides: Row = {}): Row {
  return {
    id: PRICE_ID,
    ...scope,
    variant: VARIANT_ID,
    currencyCode: 'PLN',
    unitPriceGross: '64.8000',
    taxRate: '8.0000',
    minQuantity: 1,
    ...overrides,
  }
}

describe('loadQuotableProduct', () => {
  it('falls back to the default variant, so an item may name a product alone', async () => {
    const { em } = makeEm({ products: [product()], variants: [variant()] })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID })

    expect(result).toEqual({ ok: true, value: quotable() })
  })

  it('keeps an explicitly named variant instead of quietly using the default one', async () => {
    const { em } = makeEm({
      products: [product()],
      variants: [variant(), variant({ id: OTHER_VARIANT_ID, isDefault: false })],
    })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID, variantId: OTHER_VARIANT_ID })

    expect(result).toEqual({ ok: true, value: quotable({ variantId: OTHER_VARIANT_ID }) })
  })

  it('reads a relation handed back as a bare id exactly as it reads a loaded entity', async () => {
    const { em } = makeEm({
      products: [product()],
      variants: [variant({ product: { id: PRODUCT_ID } })],
    })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID, variantId: VARIANT_ID })

    expect(result).toEqual({ ok: true, value: quotable() })
  })

  it('takes the tax identity from the variant, which may be taxed apart from its product', async () => {
    const { em } = makeEm({ products: [product()], variants: [variant()] })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID })

    expect(result).toEqual({ ok: true, value: quotable({ taxRateId: VARIANT_VAT_ID }) })
  })

  it('falls back to the product tax identity, which is what most variants inherit', async () => {
    const { em } = makeEm({ products: [product()], variants: [variant({ taxRateId: null })] })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID })

    expect(result).toEqual({ ok: true, value: quotable({ taxRateId: PRODUCT_VAT_ID }) })
  })

  it('reports no tax identity rather than inventing one when neither record names it', async () => {
    const { em } = makeEm({
      products: [product({ taxRateId: null })],
      variants: [variant({ taxRateId: null })],
    })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID })

    expect(result).toEqual({ ok: true, value: quotable({ taxRateId: null }) })
  })

  it('refuses a withdrawn variant with its own code, so the operator is not sent hunting for a typo', async () => {
    const { em } = makeEm({ products: [product()], variants: [variant({ isActive: false })] })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID })

    // Not filtered out of the query: `variant_not_found` would read as a bad id.
    expect(result).toEqual({ ok: false, code: 'variant_inactive' })
  })

  it('refuses an explicitly named withdrawn variant instead of selling it', async () => {
    const { em } = makeEm({
      products: [product()],
      variants: [variant({ id: OTHER_VARIANT_ID, isDefault: false, isActive: false })],
    })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID, variantId: OTHER_VARIANT_ID })

    expect(result).toEqual({ ok: false, code: 'variant_inactive' })
  })

  it('refuses a variant belonging to another product rather than substituting a priceable one', async () => {
    // Substituting here would quote a different material at a plausible price — the worst
    // possible failure mode, because nothing on the quote would look wrong.
    const { em } = makeEm({
      products: [product()],
      variants: [variant({ id: OTHER_VARIANT_ID, product: OTHER_PRODUCT_ID, isDefault: false })],
    })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID, variantId: OTHER_VARIANT_ID })

    expect(result).toEqual({ ok: false, code: 'variant_foreign' })
  })

  it('refuses an unknown product, so a hallucinated id never becomes a missing line', async () => {
    const { em } = makeEm({ products: [], variants: [variant()] })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID })

    expect(result).toEqual({ ok: false, code: 'product_not_found' })
  })

  it('refuses a named variant that does not exist instead of falling back to the default one', async () => {
    const { em } = makeEm({ products: [product()], variants: [variant()] })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID, variantId: OTHER_VARIANT_ID })

    expect(result).toEqual({ ok: false, code: 'variant_not_found' })
  })

  it('refuses a product with no default variant, because a quote line needs a priced identity', async () => {
    const { em } = makeEm({ products: [product()], variants: [variant({ isDefault: false })] })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID })

    expect(result).toEqual({ ok: false, code: 'variant_not_found' })
  })

  it('refuses a product with no billing unit, because quantity could not be checked against it', async () => {
    const { em } = makeEm({ products: [product({ defaultUnit: null })], variants: [variant()] })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID })

    expect(result).toEqual({ ok: false, code: 'unit_unsupported' })
  })

  it('refuses a unit outside the catalog vocabulary rather than coercing it to one of ours', async () => {
    const { em } = makeEm({ products: [product({ defaultUnit: 'kg' })], variants: [variant()] })

    const result = await loadQuotableProduct(em, scope, { productId: PRODUCT_ID })

    expect(result).toEqual({ ok: false, code: 'unit_unsupported' })
  })

  it('scopes every catalog read to the caller tenant and organization', async () => {
    const { em, calls } = makeEm({ products: [product()], variants: [variant()] })

    await loadQuotableProduct(em, scope, { productId: PRODUCT_ID })

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.where).toMatchObject({ tenantId: scope.tenantId, organizationId: scope.organizationId })
      expect(call.where.deletedAt).toBeNull()
    }
  })
})

describe('resolveUnitPrice', () => {
  const args = { productId: PRODUCT_ID, variantId: VARIANT_ID, quantity: 12.5 }

  it('returns the gross amount untouched as a string, so money never passes through a float', async () => {
    const { em, calls } = makeEm({ prices: [priceRow()] })
    const { container, calls: pricingCalls } = makeContainer((rows) => rows[0])

    const result = await resolveUnitPrice(em, container, scope, args)

    expect(result).toEqual({
      ok: true,
      value: { currencyCode: 'PLN', unitPriceGross: '64.8000', taxRate: '8.0000', priceId: PRICE_ID },
    })
    // Prices are variant-bound; querying by product would pick up another variant's row.
    expect(calls).toHaveLength(1)
    expect(calls[0].entity).toBe('CatalogProductPrice')
    expect(calls[0].where).toMatchObject({ ...scope, variant: VARIANT_ID })
    expect(calls[0].where.product).toBeUndefined()
    // The service, not this code, applies tier and promotion rules.
    expect(pricingCalls).toHaveLength(1)
    expect(pricingCalls[0].context.quantity).toBe(12.5)
    expect(pricingCalls[0].context.date).toBeInstanceOf(Date)
  })

  it('carries the tax rate as the row wrote it, so the rate that produced the gross amount is the one quoted', async () => {
    const { em } = makeEm({ prices: [priceRow({ taxRate: '23.0000' })] })
    const { container } = makeContainer((rows) => rows[0])

    const result = await resolveUnitPrice(em, container, scope, args)

    expect(result).toEqual({
      ok: true,
      value: { currencyCode: 'PLN', unitPriceGross: '64.8000', taxRate: '23.0000', priceId: PRICE_ID },
    })
  })

  it('reports no tax rate rather than assuming one when the row carries none', async () => {
    const { em } = makeEm({ prices: [priceRow({ taxRate: null })] })
    const { container } = makeContainer((rows) => rows[0])

    const result = await resolveUnitPrice(em, container, scope, args)

    expect(result).toEqual({
      ok: true,
      value: { currencyCode: 'PLN', unitPriceGross: '64.8000', taxRate: null, priceId: PRICE_ID },
    })
  })

  it('reports no price for an unpriced variant without asking the pricing service', async () => {
    const { em } = makeEm({ prices: [] })
    const { container, calls } = makeContainer(() => {
      throw new Error('must not be called')
    })

    const result = await resolveUnitPrice(em, container, scope, args)

    expect(result).toEqual({ ok: false, code: 'no_price' })
    expect(calls).toHaveLength(0)
  })

  it('reports no price when no row matches the quantity, rather than using an out-of-band tier', async () => {
    const { em } = makeEm({ prices: [priceRow({ minQuantity: 100 })] })
    const { container } = makeContainer(() => null)

    const result = await resolveUnitPrice(em, container, scope, args)

    expect(result).toEqual({ ok: false, code: 'no_price' })
  })

  it('refuses a resolved row naming another variant, because an extension may change an amount but never the identity', async () => {
    const { em } = makeEm({ prices: [priceRow()] })
    const { container } = makeContainer(() => priceRow({ variant: OTHER_VARIANT_ID }))

    const result = await resolveUnitPrice(em, container, scope, args)

    expect(result).toEqual({ ok: false, code: 'price_identity_mismatch' })
  })

  it('refuses a resolved row with no variant at all, since an unattributable price cannot be verified', async () => {
    const { em } = makeEm({ prices: [priceRow()] })
    const { container } = makeContainer(() => priceRow({ variant: null }))

    const result = await resolveUnitPrice(em, container, scope, args)

    expect(result).toEqual({ ok: false, code: 'price_identity_mismatch' })
  })

  it('reports no price when the winning row carries a net amount only, instead of quoting zero', async () => {
    const { em } = makeEm({ prices: [priceRow({ unitPriceGross: null, unitPriceNet: '60.0000' })] })
    const { container } = makeContainer((rows) => rows[0])

    const result = await resolveUnitPrice(em, container, scope, args)

    expect(result).toEqual({ ok: false, code: 'no_price' })
  })
})

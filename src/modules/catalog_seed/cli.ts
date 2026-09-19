import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import {
  CatalogPriceKind,
  CatalogProduct,
  CatalogProductCategory,
  CatalogProductPrice,
  CatalogProductVariant,
} from '@open-mercato/core/modules/catalog/data/entities'
import { Dictionary, DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import { SalesTaxRate } from '@open-mercato/core/modules/sales/data/entities'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  RENOVATION_CATEGORY_TREE,
  RENOVATION_SERVICE_CATALOG,
  type RenovationCategorySeed,
  type RenovationServiceSeed,
} from './data/renovation-catalog'
import { E } from '@/.mercato/generated/entities.ids.generated'
import {
  parseSeedArgs,
  resolveOrganizationScope,
  type OrganizationScope,
  type SeedArgs,
} from './lib/args'

const UNIT_LABELS: Record<string, string> = {
  m2: 'm²',
  szt: 'szt (sztuka)',
  mb: 'mb (metr bieżący)',
  kpl: 'kpl (komplet)',
}

const PRICE_KIND_CODE = 'regular'
const CURRENCY_CODE = 'PLN'
const MIN_QUANTITY = 1
const VAT_8_CODE = 'vat-8'
const VAT_8_NAME = '8% VAT'
const VAT_8_RATE = 8
// Taken from the generated ids, never spelled out: a hand-written entity id drifts
// silently and only surfaces as `relation "..." does not exist` at rebuild time.
const QUERY_INDEX_ENTITY = E.catalog.catalog_product

async function seedUnits(
  em: EntityManager,
  commandBus: CommandBus,
  ctx: CommandRuntimeContext,
  scope: OrganizationScope,
  dryRun: boolean,
): Promise<void> {
  const dictionary = await findOneWithDecryption(em, Dictionary, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    key: { $in: ['unit', 'units', 'measurement_units'] },
    deletedAt: null,
  })
  if (!dictionary) {
    console.warn(
      'No unit dictionary (unit/units/measurement_units) for this organization — catalog will accept unit codes without dictionary validation.',
    )
    return
  }

  const entries = await em.find(DictionaryEntry, { dictionary: dictionary.id })
  const existingValues = new Set(entries.map((entry) => entry.value.toLowerCase()))
  const requiredUnits = Array.from(new Set(RENOVATION_SERVICE_CATALOG.map((seed) => seed.defaultUnit)))

  for (const unit of requiredUnits) {
    if (existingValues.has(unit.toLowerCase())) continue
    if (dryRun) {
      console.log(`[dry-run] would add unit "${unit}" to dictionary "${dictionary.key}"`)
      continue
    }
    await commandBus.execute('dictionaries.entries.create', {
      input: { dictionaryId: dictionary.id, value: unit, label: UNIT_LABELS[unit] ?? unit },
      ctx,
    })
    console.log(`+ unit "${unit}" added to dictionary "${dictionary.key}"`)
  }
}

async function seedCategories(
  em: EntityManager,
  commandBus: CommandBus,
  ctx: CommandRuntimeContext,
  scope: OrganizationScope,
  dryRun: boolean,
): Promise<Map<string, string>> {
  const categoryIdBySlug = new Map<string, string>()

  const ensureCategory = async (seed: RenovationCategorySeed, parentSlug?: string): Promise<void> => {
    const existing = await em.findOne(CatalogProductCategory, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      slug: seed.slug,
      deletedAt: null,
    })
    if (existing) {
      categoryIdBySlug.set(seed.slug, existing.id)
      console.log(`= category "${seed.slug}" already exists (${existing.id})`)
    } else if (dryRun) {
      console.log(`[dry-run] would create category "${seed.slug}"${parentSlug ? ` under "${parentSlug}"` : ''}`)
    } else {
      const parentId = parentSlug ? (categoryIdBySlug.get(parentSlug) ?? null) : null
      const { result } = await commandBus.execute<Record<string, unknown>, { categoryId: string }>(
        'catalog.categories.create',
        {
          input: {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            name: seed.name,
            slug: seed.slug,
            description: seed.description,
            parentId,
          },
          ctx,
        },
      )
      categoryIdBySlug.set(seed.slug, result.categoryId)
      console.log(`+ category "${seed.slug}" created (${result.categoryId})`)
    }

    for (const child of seed.children ?? []) {
      await ensureCategory(child, seed.slug)
    }
  }

  for (const top of RENOVATION_CATEGORY_TREE) {
    await ensureCategory(top)
  }

  return categoryIdBySlug
}

async function resolvePriceKindId(em: EntityManager, scope: OrganizationScope): Promise<string> {
  const candidates = await em.find(CatalogPriceKind, {
    tenantId: scope.tenantId,
    code: PRICE_KIND_CODE,
    deletedAt: null,
  })
  const priceKind =
    candidates.find((kind) => kind.organizationId === scope.organizationId) ??
    candidates.find((kind) => kind.organizationId == null) ??
    null
  if (!priceKind) {
    throw new Error(
      `No price kind "${PRICE_KIND_CODE}" — run \`yarn mercato catalog seed-price-kinds --tenant ${scope.tenantId} --org ${scope.organizationId}\` first.`,
    )
  }
  return priceKind.id
}

async function resolveVatRateId(
  em: EntityManager,
  commandBus: CommandBus,
  ctx: CommandRuntimeContext,
  scope: OrganizationScope,
  dryRun: boolean,
): Promise<string | null> {
  const existing = await em.findOne(SalesTaxRate, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    code: VAT_8_CODE,
    deletedAt: null,
  })
  if (existing) {
    console.log(`= tax rate "${VAT_8_CODE}" already exists (${existing.id})`)
    return existing.id
  }
  if (dryRun) {
    console.log(`[dry-run] would create tax rate "${VAT_8_CODE}" (${VAT_8_RATE}%)`)
    return null
  }
  const { result } = await commandBus.execute<Record<string, unknown>, { taxRateId: string }>(
    'sales.tax-rates.create',
    {
      input: {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        name: VAT_8_NAME,
        code: VAT_8_CODE,
        rate: VAT_8_RATE,
      },
      ctx,
    },
  )
  console.log(`+ tax rate "${VAT_8_CODE}" (${VAT_8_RATE}%) created (${result.taxRateId})`)
  return result.taxRateId
}

type SeedCounters = {
  productsCreated: number
  variantsCreated: number
  pricesCreated: number
  vatBackfilled: number
}

async function ensureVariantsAndPrices(
  em: EntityManager,
  commandBus: CommandBus,
  ctx: CommandRuntimeContext,
  scope: OrganizationScope,
  options: {
    productSeed: RenovationServiceSeed
    productId: string | null
    priceKindId: string
    vatRateId: string | null
    dryRun: boolean
  },
  counters: SeedCounters,
): Promise<void> {
  const { productSeed, productId, priceKindId, vatRateId, dryRun } = options

  for (const variantSeed of productSeed.variants) {
    const existingVariant = productId
      ? await em.findOne(CatalogProductVariant, {
          product: productId,
          sku: variantSeed.sku,
          deletedAt: null,
        })
      : null

    let variantId = existingVariant?.id ?? null
    if (!variantId) {
      if (dryRun) {
        console.log(`[dry-run] would create variant "${variantSeed.sku}" of "${productSeed.handle}"`)
        counters.variantsCreated += 1
        counters.pricesCreated += 1
        continue
      }
      if (!productId) continue
      const { result } = await commandBus.execute<Record<string, unknown>, { variantId: string }>(
        'catalog.variants.create',
        {
          input: {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            productId,
            name: variantSeed.name,
            sku: variantSeed.sku,
            isDefault: variantSeed.isDefault ?? false,
            optionValues: variantSeed.optionValues,
          },
          ctx,
        },
      )
      variantId = result.variantId
      counters.variantsCreated += 1
      console.log(`+ variant "${variantSeed.sku}" created (${variantId})`)
    }

    const existingPrice = await em.findOne(CatalogProductPrice, {
      variant: variantId,
      priceKind: priceKindId,
      currencyCode: CURRENCY_CODE,
      minQuantity: MIN_QUANTITY,
    })
    if (existingPrice) continue

    if (dryRun) {
      console.log(
        `[dry-run] would create price ${variantSeed.prices.regular} ${CURRENCY_CODE} for variant "${variantSeed.sku}"`,
      )
      counters.pricesCreated += 1
      continue
    }

    await commandBus.execute('catalog.prices.create', {
      input: {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        variantId,
        priceKindId,
        currencyCode: CURRENCY_CODE,
        minQuantity: MIN_QUANTITY,
        unitPriceGross: variantSeed.prices.regular,
        taxRateId: vatRateId,
      },
      ctx,
    })
    counters.pricesCreated += 1
    console.log(`+ price ${variantSeed.prices.regular} ${CURRENCY_CODE} created for variant "${variantSeed.sku}"`)
  }
}

async function backfillProductVat(
  em: EntityManager,
  commandBus: CommandBus,
  ctx: CommandRuntimeContext,
  scope: OrganizationScope,
  options: { productId: string; handle: string; currentTaxRateId: string | null; vatRateId: string | null; dryRun: boolean },
  counters: SeedCounters,
): Promise<void> {
  const { productId, handle, currentTaxRateId, vatRateId, dryRun } = options

  if (dryRun) {
    if (vatRateId === null || currentTaxRateId !== vatRateId) {
      console.log(`[dry-run] would set tax rate "${VAT_8_CODE}" on product "${handle}" and its variants`)
      counters.vatBackfilled += 1
    }
    return
  }
  if (!vatRateId || currentTaxRateId === vatRateId) return

  await commandBus.execute('catalog.products.update', {
    input: {
      id: productId,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      taxRateId: vatRateId,
    },
    ctx,
  })

  const variants = await em.find(CatalogProductVariant, { product: productId, deletedAt: null })
  for (const variant of variants) {
    if (variant.taxRateId === vatRateId) continue
    await commandBus.execute('catalog.variants.update', {
      input: {
        id: variant.id,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        taxRateId: vatRateId,
      },
      ctx,
    })
  }
  counters.vatBackfilled += 1
  console.log(`~ tax rate "${VAT_8_CODE}" set on product "${handle}" and ${variants.length} variant(s)`)
}

async function seedProducts(
  em: EntityManager,
  commandBus: CommandBus,
  ctx: CommandRuntimeContext,
  scope: OrganizationScope,
  options: {
    categoryIdBySlug: Map<string, string>
    priceKindId: string
    vatRateId: string | null
    dryRun: boolean
  },
  counters: SeedCounters,
): Promise<void> {
  const { categoryIdBySlug, priceKindId, vatRateId, dryRun } = options

  for (const productSeed of RENOVATION_SERVICE_CATALOG) {
    const existingProduct = await em.findOne(CatalogProduct, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      handle: productSeed.handle,
      deletedAt: null,
    })

    let productId = existingProduct?.id ?? null

    if (existingProduct) {
      await backfillProductVat(
        em,
        commandBus,
        ctx,
        scope,
        {
          productId: existingProduct.id,
          handle: productSeed.handle,
          currentTaxRateId: existingProduct.taxRateId ?? null,
          vatRateId,
          dryRun,
        },
        counters,
      )
    } else if (dryRun) {
      console.log(`[dry-run] would create product "${productSeed.handle}" (category "${productSeed.categorySlug}")`)
      counters.productsCreated += 1
    } else {
      const categoryId = categoryIdBySlug.get(productSeed.categorySlug) ?? null
      const { result } = await commandBus.execute<Record<string, unknown>, { productId: string }>(
        'catalog.products.create',
        {
          input: {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            title: productSeed.title,
            handle: productSeed.handle,
            sku: productSeed.sku,
            description: productSeed.description,
            productType: productSeed.productType,
            requiresShipping: productSeed.requiresShipping,
            isQuoteOnly: productSeed.isQuoteOnly,
            defaultUnit: productSeed.defaultUnit,
            categoryIds: categoryId ? [categoryId] : [],
            taxRateId: vatRateId,
          },
          ctx,
        },
      )
      productId = result.productId
      counters.productsCreated += 1
      console.log(`+ product "${productSeed.handle}" created (${productId})`)
    }

    await ensureVariantsAndPrices(
      em,
      commandBus,
      ctx,
      scope,
      { productSeed, productId, priceKindId, vatRateId, dryRun },
      counters,
    )
  }
}

const seedRenovationCatalog: ModuleCli = {
  command: 'seed-renovation-catalog',
  async run(argv) {
    let args: SeedArgs
    try {
      args = parseSeedArgs(argv)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
      return
    }

    const container = await createRequestContainer()
    try {
      const em = container.resolve<EntityManager>('em')
      const commandBus = container.resolve<CommandBus>('commandBus')

      const organization = await em.findOne(
        Organization,
        { id: args.organizationId, deletedAt: null },
        { populate: ['tenant'] },
      )
      const scope = resolveOrganizationScope(args.organizationId, organization)

      console.log(
        `Organization: ${organization?.name ?? scope.organizationId} (${scope.organizationId}), tenant ${scope.tenantId}${
          args.dryRun ? '  [DRY RUN — no writes]' : ''
        }`,
      )

      const ctx: CommandRuntimeContext = {
        container,
        auth: null,
        organizationScope: null,
        selectedOrganizationId: null,
        organizationIds: null,
        systemActor: true,
      }

      await seedUnits(em, commandBus, ctx, scope, args.dryRun)
      const categoryIdBySlug = await seedCategories(em, commandBus, ctx, scope, args.dryRun)
      const priceKindId = await resolvePriceKindId(em, scope)
      const vatRateId = await resolveVatRateId(em, commandBus, ctx, scope, args.dryRun)

      const counters: SeedCounters = {
        productsCreated: 0,
        variantsCreated: 0,
        pricesCreated: 0,
        vatBackfilled: 0,
      }
      await seedProducts(
        em,
        commandBus,
        ctx,
        scope,
        { categoryIdBySlug, priceKindId, vatRateId, dryRun: args.dryRun },
        counters,
      )

      console.log(
        `\nDone. Products: ${counters.productsCreated}, variants: ${counters.variantsCreated}, prices: ${counters.pricesCreated}, VAT backfilled: ${counters.vatBackfilled}.`,
      )
      if (!args.dryRun) {
        console.log(
          `If this run did not go through the production queue, rebuild the index with:\n  mercato query_index rebuild --entity ${QUERY_INDEX_ENTITY} --tenant ${scope.tenantId} --org ${scope.organizationId}`,
        )
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    } finally {
      const disposable = container
      if (typeof disposable.dispose === 'function') {
        await disposable.dispose()
      }
    }
  },
}

export default [seedRenovationCatalog]

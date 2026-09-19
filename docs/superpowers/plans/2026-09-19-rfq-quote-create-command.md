# RFQ Quote Creation Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `rfq_intake.quote.create`, a command that turns an agent's mapping of renovation work onto Catalog services into a priced, unsent Sales quote, with every quantity computed deterministically rather than supplied by the model.

**Architecture:** Five sequential PRs. PR 1 lands the registered command with full plumbing and no business logic, so scope derivation, discovery and the two tenant-enablement gates are proven on day one. PR 2 and PR 3 add two independent pure-ish units — per-unit price resolution and geometry/quantity arithmetic — each testable in isolation. PR 4 joins them and calls Sales. PR 5 adds the `executeProposal` bridge and a temporary probe agent.

**Tech Stack:** TypeScript, Next.js, MikroORM/PostgreSQL, Zod 4, Jest 30, Open Mercato 0.8.0 (Catalog, Customers, Sales, Workflows, Agent Orchestrator).

**Spec:** `.ai/specs/2026-09-19-rfq-quote-create-command.md`

## Global Constraints

- `tenantId` and `organizationId` come **only** from `ctx` (`ctx.auth.tenantId`, `ctx.selectedOrganizationId ?? ctx.auth.orgId`). Missing scope is an error, never unrestricted access. Payload scope keys are stripped, never trusted.
- The input schema is **non-strict**: unknown keys are stripped, following `src/modules/deal_links/commands/document-links.ts:8-17`.
- `dealId` and `roomMeasurementsRunId` arrive from a language model and are re-read in derived scope; a miss fails closed.
- Cross-module access is by scalar ID and owner-command call only. Never add an ORM relation from `rfq_intake` to an installed module.
- Never edit `node_modules`, `.mercato/generated/**`, shipped migrations, or generated facts.
- No new entity and no migration in this plan. Two invocations creating two quotes is an accepted, documented shortcut.
- Prices resolve on the **variant**, never at product level: `catalog_product_variant_prices` rows created by `catalog_seed` all carry a `variantId`.
- Money is gross: the seed writes `unitPriceGross` with a VAT 8% `taxRateId`, so lines use `priceMode: 'gross'`.
- A product's `defaultUnit` is the unit gate. A basis producing a different unit drops the item; never coerce and never substitute another product or variant.
- Every shortcut gets an inline `// HACK(hackathon): <what, why, what breaks>`.
- Gate after every slice: `yarn generate && yarn typecheck && yarn lint`.

## File Structure

| File | Responsibility | PR |
|---|---|---|
| `src/modules/rfq_intake/commands/quote-create.ts` | Input schema, scope derivation, deal/run verification, item loop, Sales call | 1, 4 |
| `src/modules/rfq_intake/workflows.ts` | Add the workflow-safe registration entry | 1 |
| `src/modules/rfq_intake/lib/catalogPricing.ts` | Variant resolution and unit-price lookup | 2 |
| `src/modules/rfq_intake/lib/geometry.ts` | Pixel bridge, shoelace, distances, unit normalization | 3 |
| `src/modules/rfq_intake/lib/basisResolver.ts` | Basis → quantity + unit over a set of V2 rooms | 3 |
| `src/modules/rfq_intake/commands/apply-proposal.ts` | Loads the disposed proposal, calls `executeProposal` | 5 |
| `src/modules/rfq_intake/ai-agents.ts` | The temporary probe agent | 5 |

Tests live beside them in `src/modules/rfq_intake/__tests__/`, one file per unit, following the `makeCtx()` container-stub style of `__tests__/advance-command.test.ts`.

---

# PR 1 — The registered command, no business logic

**Deliverable:** `rfq_intake.quote.create` exists, is discoverable, derives scope, verifies the deal, and returns an explicit not-implemented result. Registered as workflow-safe so gates 1 and 2 can be satisfied immediately rather than discovered at demo time.

### Task 1: Input contract and scope derivation

**Files:**
- Create: `src/modules/rfq_intake/commands/quote-create.ts`
- Create: `src/modules/rfq_intake/__tests__/quote-create-command.test.ts`

**Interfaces:**
- Consumes: `CommandHandler`, `registerCommand` from `@open-mercato/shared/lib/commands`; `CrudHttpError` from `@open-mercato/shared/lib/crud/errors`.
- Produces: `createQuoteCommand` (id `rfq_intake.quote.create`), `quoteCreateInputSchema`, and types `QuoteCreateInput`, `QuoteCreateResult = { quoteId: string | null; lineCount: number; warnings: string[] }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from '@jest/globals'
import { createQuoteCommand } from '../commands/quote-create'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const dealId = '33333333-3333-4333-8333-333333333333'
const runId = '44444444-4444-4444-8444-444444444444'
const productId = '55555555-5555-4555-8555-555555555555'

function makeCtx(overrides: { deal?: unknown } = {}) {
  return {
    auth: { tenantId, orgId: organizationId },
    selectedOrganizationId: organizationId,
    container: {
      resolve(name: string) {
        if (name === 'em') {
          return {
            fork: () => ({
              findOne: async () => ('deal' in overrides ? overrides.deal : { id: dealId }),
            }),
          }
        }
        throw new Error(`unexpected resolve ${name}`)
      },
    },
  } as never
}

const validInput = {
  dealId,
  roomMeasurementsRunId: runId,
  items: [{ catalogProductId: productId, basis: 'count', count: 3 }],
}

describe('rfq_intake.quote.create input contract', () => {
  it('strips scope keys from the payload so a model cannot choose its own tenant', async () => {
    const parsed = (await import('../commands/quote-create')).quoteCreateInputSchema.parse({
      ...validInput,
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    })
    expect(parsed).not.toHaveProperty('tenantId')
    expect(parsed).not.toHaveProperty('organizationId')
  })

  it('requires roomIds for an area basis, which a flat optional field could not enforce', async () => {
    const { quoteCreateInputSchema } = await import('../commands/quote-create')
    expect(() =>
      quoteCreateInputSchema.parse({
        dealId, roomMeasurementsRunId: runId,
        items: [{ catalogProductId: productId, basis: 'net_wall_area' }],
      }),
    ).toThrow()
  })

  it('rejects a count supplied alongside an area basis rather than ignoring it', async () => {
    const { quoteCreateInputSchema } = await import('../commands/quote-create')
    const parsed = quoteCreateInputSchema.parse({
      dealId, roomMeasurementsRunId: runId,
      items: [{ catalogProductId: productId, basis: 'floor_area', roomIds: ['room-1'], count: 4 }],
    })
    // The union member has no `count`, so the stray key is stripped, never acted on.
    expect(parsed.items[0]).not.toHaveProperty('count')
  })

  it('fails closed when the runtime context carries no tenant', async () => {
    const ctx = { auth: {}, container: { resolve: () => ({}) } } as never
    await expect(createQuoteCommand.execute(validInput, ctx)).rejects.toThrow(/Tenant/)
  })

  it('fails closed when the deal is not in the derived scope', async () => {
    await expect(createQuoteCommand.execute(validInput, makeCtx({ deal: null }))).rejects.toThrow(/Deal/)
  })

  it('returns an explicit not-implemented result rather than pretending success', async () => {
    const result = await createQuoteCommand.execute(validInput, makeCtx())
    expect(result).toEqual({ quoteId: null, lineCount: 0, warnings: ['quote_creation_not_implemented'] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/rfq_intake/__tests__/quote-create-command.test.ts`
Expected: FAIL — cannot find module `../commands/quote-create`.

- [ ] **Step 3: Write the minimal implementation**

```ts
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { CustomerDeal } from '@open-mercato/core/modules/customers/data/entities'
import { z } from 'zod'

/**
 * Non-strict on purpose: unknown keys are STRIPPED rather than rejected. The payload
 * is authored by a language model and may carry `tenantId`/`organizationId`; stripping
 * them here is what makes it impossible to write into someone else's scope by asking.
 */
/** Fields every item carries, whatever its basis. */
const itemCommon = {
  catalogProductId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  note: z.string().max(1000).optional(),
}

const roomIds = z.array(z.string().min(1).max(200)).min(1).max(200)

/**
 * Discriminated on `basis`, which is the single word the agent was already choosing —
 * so the union costs the model no extra decision while making `roomIds` REQUIRED where
 * it means something instead of an optional that silently does nothing.
 *
 * This is also the extension point. A future work type (`floor_perimeter`,
 * `opening_perimeter`, `wall_run_length`, `same_as`) arrives as one more member with
 * its own fields, rather than as another `field?` that most bases would ignore.
 */
const quoteItemSchema = z.discriminatedUnion('basis', [
  z.object({ ...itemCommon, basis: z.literal('floor_area'), roomIds }),
  z.object({ ...itemCommon, basis: z.literal('gross_wall_area'), roomIds }),
  z.object({ ...itemCommon, basis: z.literal('net_wall_area'), roomIds }),
  z.object({ ...itemCommon, basis: z.literal('count'), count: z.number().int().positive().max(10_000) }),
  z.object({
    ...itemCommon,
    basis: z.literal('given'),
    given: z.object({ value: z.number().positive(), unit: z.enum(['m2', 'mb', 'szt', 'kpl']) }),
  }),
])

export const quoteCreateInputSchema = z.object({
  dealId: z.string().uuid(),
  roomMeasurementsRunId: z.string().uuid(),
  items: z.array(quoteItemSchema).min(1).max(100),
})

export type QuoteCreateInput = z.infer<typeof quoteCreateInputSchema>
export type QuoteCreateResult = { quoteId: string | null; lineCount: number; warnings: string[] }

export function ensureScope(ctx: CommandRuntimeContext): { tenantId: string; organizationId: string } {
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) throw new CrudHttpError(400, { error: 'Tenant context is required' })
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (!organizationId) throw new CrudHttpError(400, { error: 'Organization context is required' })
  return { tenantId, organizationId }
}

const createQuoteCommand: CommandHandler<Record<string, unknown>, QuoteCreateResult> = {
  id: 'rfq_intake.quote.create',
  async execute(rawInput, ctx) {
    const input = quoteCreateInputSchema.parse(rawInput)
    const scope = ensureScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    // The id comes from a model and is untrusted: the deal is re-read inside the
    // derived scope, exactly as `inbox-actions.ts:102` calls the owner's command
    // rather than touching `customer_deals` itself.
    const deal = await em.findOne(CustomerDeal, { id: input.dealId, ...scope, deletedAt: null })
    if (!deal) throw new CrudHttpError(404, { error: 'Deal not found' })

    // HACK(hackathon): plumbing only. PR 4 replaces this with priced lines and the
    // Sales call. What breaks until then: the command never produces a quote.
    return { quoteId: null, lineCount: 0, warnings: ['quote_creation_not_implemented'] }
  },
}

registerCommand(createQuoteCommand)

export { createQuoteCommand }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/rfq_intake/__tests__/quote-create-command.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/rfq_intake/commands/quote-create.ts src/modules/rfq_intake/__tests__/quote-create-command.test.ts
git commit -m "feat(rfq_intake): add the quote create command contract and scope guard"
```

### Task 2: Make the command reachable

**Files:**
- Modify: `src/modules/rfq_intake/workflows.ts:16-32` (the `registerWorkflowSafeCommands` array)
- Modify: `src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts`

**Interfaces:**
- Consumes: `createQuoteCommand` from Task 1.
- Produces: the command id present in `listWorkflowSafeCommands()`, which is gate 1 of the five in the spec.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/rfq-intake-wiring.test.ts`:

```ts
it('declares the quote command workflow-safe, because the agent vocabulary is built from that list', async () => {
  await import('../workflows')
  const { listWorkflowSafeCommands } = await import(
    '@open-mercato/core/modules/workflows/lib/workflow-safe-commands'
  )
  const entry = listWorkflowSafeCommands().find((e) => e.commandId === 'rfq_intake.quote.create')
  expect(entry).toBeDefined()
  expect(entry?.requiredFeatures).toEqual(['customers.deals.manage', 'sales.quotes.manage'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts`
Expected: FAIL — `entry` is `undefined`.

- [ ] **Step 3: Add the registration entry**

Add as a fourth element of the existing `registerWorkflowSafeCommands([...])` array in `workflows.ts`:

```ts
  {
    commandId: 'rfq_intake.quote.create',
    requiredFeatures: ['customers.deals.manage', 'sales.quotes.manage'],
    labelKey: 'rfq_intake.workflows.commands.quote.create',
  },
```

- [ ] **Step 4: Run tests and the gate**

Run: `yarn test src/modules/rfq_intake/__tests__/ && yarn generate && yarn typecheck && yarn lint`
Expected: all PASS.

- [ ] **Step 5: Commit and open the PR**

```bash
git add src/modules/rfq_intake/workflows.ts src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts
git commit -m "feat(rfq_intake): declare the quote command workflow-safe"
```

- [ ] **Step 6: Enable the command for the demo tenant and record that it was done**

The entry is deliberately not `defaultEnabled`, so nothing runs until a tenant enables it once in the workflow-commands settings. Do this now rather than at the end — it is the failure the spec calls a demo-killer, and it fails as a silent `skipped`. Note in the PR description which tenant was enabled.

---

# PR 2 — Per-unit price resolution

**Deliverable:** given a product, an optional variant and a quantity, return the authoritative gross unit price in scope, or a typed refusal. No quote, no geometry.

### Task 3: Variant resolution and price lookup

**Files:**
- Create: `src/modules/rfq_intake/lib/catalogPricing.ts`
- Create: `src/modules/rfq_intake/__tests__/catalog-pricing.test.ts`

**Interfaces:**
- Consumes: `catalogPricingService` from the container (registered in `catalog/di.ts:13`); entities `CatalogProduct`, `CatalogProductVariant`, `CatalogProductPrice` from `@open-mercato/core/modules/catalog/data/entities`.
- Produces:

```ts
export type PricedUnit = {
  variantId: string
  currencyCode: string
  unitPriceGross: string
  taxRateId: string | null
  defaultUnit: string | null
  productTitle: string
}
export type PriceFailure = { reason: 'product_not_found' | 'variant_not_found' | 'variant_foreign' | 'no_price' | 'price_identity_mismatch' }
export async function resolveUnitPrice(
  em: EntityManager,
  container: { resolve: (name: string) => unknown },
  scope: { tenantId: string; organizationId: string },
  args: { productId: string; variantId?: string; quantity: number },
): Promise<PricedUnit | PriceFailure>
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from '@jest/globals'
import { resolveUnitPrice } from '../lib/catalogPricing'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}
const productId = '55555555-5555-4555-8555-555555555555'
const defaultVariantId = '66666666-6666-4666-8666-666666666666'
const otherVariantId = '77777777-7777-4777-8777-777777777777'

function makeEm(rows: { product?: unknown; variants?: unknown[]; prices?: unknown[] }) {
  return {
    findOne: async (entity: { name: string }, where: Record<string, unknown>) => {
      if (entity.name === 'CatalogProduct') return rows.product ?? null
      if (entity.name === 'CatalogProductVariant') {
        return (rows.variants ?? []).find((v: any) => (where.id ? v.id === where.id : v.isDefault)) ?? null
      }
      return null
    },
    find: async () => rows.prices ?? [],
  } as never
}

function makeContainer(resolved: unknown) {
  return { resolve: (name: string) => (name === 'catalogPricingService' ? { resolvePrice: async () => resolved } : null) }
}

const product = { id: productId, title: 'Malowanie ścian i sufitów', defaultUnit: 'm2' }
const defaultVariant = { id: defaultVariantId, isDefault: true, isActive: true, product: { id: productId } }
const priceRow = {
  id: 'price-1',
  currencyCode: 'PLN',
  unitPriceGross: '40.0000',
  taxRateId: 'vat-8-id',
  minQuantity: 1,
  variant: { id: defaultVariantId },
}

describe('resolveUnitPrice', () => {
  it('falls back to the default variant, which the seed sets for every service', async () => {
    const result = await resolveUnitPrice(
      makeEm({ product, variants: [defaultVariant], prices: [priceRow] }),
      makeContainer(priceRow),
      scope,
      { productId, quantity: 12 },
    )
    expect(result).toEqual({
      variantId: defaultVariantId,
      currencyCode: 'PLN',
      unitPriceGross: '40.0000',
      taxRateId: 'vat-8-id',
      defaultUnit: 'm2',
      productTitle: 'Malowanie ścian i sufitów',
    })
  })

  it('refuses a variant belonging to another product instead of substituting one', async () => {
    const foreign = { id: otherVariantId, isDefault: false, isActive: true, product: { id: 'another-product' } }
    const result = await resolveUnitPrice(
      makeEm({ product, variants: [foreign], prices: [priceRow] }),
      makeContainer(priceRow),
      scope,
      { productId, variantId: otherVariantId, quantity: 1 },
    )
    expect(result).toEqual({ reason: 'variant_foreign' })
  })

  it('refuses when the resolver returns a price for a different variant', async () => {
    const strayPrice = { ...priceRow, variant: { id: otherVariantId } }
    const result = await resolveUnitPrice(
      makeEm({ product, variants: [defaultVariant], prices: [priceRow] }),
      makeContainer(strayPrice),
      scope,
      { productId, quantity: 1 },
    )
    expect(result).toEqual({ reason: 'price_identity_mismatch' })
  })

  it('refuses when the variant has no price row at all', async () => {
    const result = await resolveUnitPrice(
      makeEm({ product, variants: [defaultVariant], prices: [] }),
      makeContainer(null),
      scope,
      { productId, quantity: 1 },
    )
    expect(result).toEqual({ reason: 'no_price' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/rfq_intake/__tests__/catalog-pricing.test.ts`
Expected: FAIL — cannot find module `../lib/catalogPricing`.

- [ ] **Step 3: Implement**

```ts
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CatalogProduct,
  CatalogProductPrice,
  CatalogProductVariant,
} from '@open-mercato/core/modules/catalog/data/entities'
import type { CatalogPricingService, PriceRow } from '@open-mercato/core/modules/catalog/services/catalogPricingService'
import { resolvePriceVariantId } from '@open-mercato/core/modules/catalog/lib/pricing'

export type PricedUnit = {
  variantId: string
  currencyCode: string
  unitPriceGross: string
  taxRateId: string | null
  defaultUnit: string | null
  productTitle: string
}
export type PriceFailure = {
  reason: 'product_not_found' | 'variant_not_found' | 'variant_foreign' | 'no_price' | 'price_identity_mismatch'
}

function variantProductId(variant: { product?: { id: string } | string | null }): string | null {
  if (!variant.product) return null
  return typeof variant.product === 'string' ? variant.product : variant.product.id
}

/**
 * Prices live on the VARIANT. `catalog_seed` writes every row through
 * `catalog.prices.create` with a `variantId` into `catalog_product_variant_prices`,
 * so a product-level lookup (`productVariantId = null`) finds nothing against demo
 * data — that is the correction this module exists to carry.
 */
export async function resolveUnitPrice(
  em: EntityManager,
  container: { resolve: (name: string) => unknown },
  scope: { tenantId: string; organizationId: string },
  args: { productId: string; variantId?: string; quantity: number },
): Promise<PricedUnit | PriceFailure> {
  const product = await em.findOne(CatalogProduct, { id: args.productId, ...scope, deletedAt: null })
  if (!product) return { reason: 'product_not_found' }

  const variant = args.variantId
    ? await em.findOne(CatalogProductVariant, { id: args.variantId, ...scope, deletedAt: null })
    : await em.findOne(CatalogProductVariant, { ...scope, product: args.productId, isDefault: true, deletedAt: null })
  if (!variant) return { reason: 'variant_not_found' }
  if (variantProductId(variant) !== args.productId) return { reason: 'variant_foreign' }

  const rows = (await em.find(CatalogProductPrice, {
    ...scope,
    variant: variant.id,
    deletedAt: null,
  })) as unknown as PriceRow[]
  if (rows.length === 0) return { reason: 'no_price' }

  const pricing = container.resolve('catalogPricingService') as CatalogPricingService
  const resolved = await pricing.resolvePrice(rows, { quantity: args.quantity, date: new Date() })
  if (!resolved) return { reason: 'no_price' }

  // A pricing extension may adjust the amount for the same identity. It may not hand
  // back a different variant — that would silently quote another product.
  if (resolvePriceVariantId(resolved) !== variant.id) return { reason: 'price_identity_mismatch' }
  if (!resolved.unitPriceGross) return { reason: 'no_price' }

  return {
    variantId: variant.id,
    currencyCode: resolved.currencyCode,
    unitPriceGross: resolved.unitPriceGross,
    taxRateId: (resolved as { taxRateId?: string | null }).taxRateId ?? null,
    defaultUnit: product.defaultUnit ?? null,
    productTitle: product.title,
  }
}
```

- [ ] **Step 4: Run tests and the gate**

Run: `yarn test src/modules/rfq_intake/__tests__/catalog-pricing.test.ts && yarn typecheck && yarn lint`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/rfq_intake/lib/catalogPricing.ts src/modules/rfq_intake/__tests__/catalog-pricing.test.ts
git commit -m "feat(rfq_intake): resolve the authoritative variant unit price"
```

---

# PR 3 — Pure quantity arithmetic

**Deliverable:** two dependency-free modules that turn a `property_documents.room_measurements` V2 result into a quantity and a unit. No database, no container, no Sales.

### Task 4: The geometry primitives

**Files:**
- Create: `src/modules/rfq_intake/lib/geometry.ts`
- Create: `src/modules/rfq_intake/__tests__/geometry.test.ts`

**Interfaces:**
- Consumes: nothing at runtime. Types mirror the V2 contract in `src/modules/property_documents/room-measurements-contract.ts`; import them once PR #35 merges, and keep a local structural type until then.
- Produces:

```ts
export type Point = { x: number; y: number }
export type LinearUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft'
export type AreaUnit = 'mm2' | 'cm2' | 'm2' | 'in2' | 'ft2'
export function toMetres(value: number, unit: LinearUnit): number
export function toSquareMetres(value: number, unit: AreaUnit): number
export function metresPerPixel(c: Calibration, imageWidthPx: number, imageHeightPx: number): number | null
export function calibrationAgreement(values: number[]): boolean
export function polygonAreaNormalised(points: Point[]): number
export function polygonAreaSquareMetres(outer: Point[], holes: Point[][], mpp: number, w: number, h: number): number
export function segmentLengthMetres(a: Point, b: Point, mpp: number, w: number, h: number): number
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from '@jest/globals'
import {
  calibrationAgreement,
  metresPerPixel,
  polygonAreaNormalised,
  polygonAreaSquareMetres,
  segmentLengthMetres,
  toMetres,
  toSquareMetres,
} from '../lib/geometry'

const W = 1000
const H = 500

describe('unit normalization', () => {
  it('converts every linear unit the V2 contract allows', () => {
    expect(toMetres(350, 'cm')).toBeCloseTo(3.5)
    expect(toMetres(2700, 'mm')).toBeCloseTo(2.7)
    expect(toMetres(1, 'ft')).toBeCloseTo(0.3048)
  })

  it('converts area units', () => {
    expect(toSquareMetres(140_000, 'cm2')).toBeCloseTo(14)
    expect(toSquareMetres(14, 'm2')).toBeCloseTo(14)
  })
})

describe('the pixel bridge', () => {
  it('derives metres per pixel from a calibration spanning half the image width', () => {
    // 0.5 of 1000px = 500px represents 5 m, so 0.01 m/px.
    const mpp = metresPerPixel(
      { start: { x: 0.25, y: 0.5 }, end: { x: 0.75, y: 0.5 }, realLength: { value: 5, unit: 'm' } },
      W,
      H,
    )
    expect(mpp).toBeCloseTo(0.01)
  })

  it('returns null for a degenerate calibration rather than dividing by zero', () => {
    const mpp = metresPerPixel(
      { start: { x: 0.5, y: 0.5 }, end: { x: 0.5, y: 0.5 }, realLength: { value: 5, unit: 'm' } },
      W,
      H,
    )
    expect(mpp).toBeNull()
  })

  it('accepts agreeing calibrations and rejects disagreeing ones', () => {
    expect(calibrationAgreement([0.0100, 0.0101])).toBe(true)
    expect(calibrationAgreement([0.0100, 0.0140])).toBe(false)
  })
})

describe('polygon area', () => {
  const rect = [
    { x: 0.1, y: 0.1 },
    { x: 0.5, y: 0.1 },
    { x: 0.5, y: 0.5 },
    { x: 0.1, y: 0.5 },
  ]

  it('computes the normalised shoelace area of a rectangle', () => {
    expect(polygonAreaNormalised(rect)).toBeCloseTo(0.4 * 0.4)
  })

  it('is orientation independent, so a clockwise boundary is not negative', () => {
    expect(polygonAreaNormalised([...rect].reverse())).toBeCloseTo(0.4 * 0.4)
  })

  it('scales to square metres through the pixel bridge', () => {
    // 0.4·1000 = 400px by 0.4·500 = 200px, at 0.01 m/px → 4 m × 2 m = 8 m².
    expect(polygonAreaSquareMetres(rect, [], 0.01, W, H)).toBeCloseTo(8)
  })

  it('subtracts holes, which is how a void in a floor stops being quoted', () => {
    const hole = [
      { x: 0.2, y: 0.2 },
      { x: 0.3, y: 0.2 },
      { x: 0.3, y: 0.3 },
      { x: 0.2, y: 0.3 },
    ]
    // Hole is 100px × 50px at 0.01 m/px → 1 m × 0.5 m = 0.5 m².
    expect(polygonAreaSquareMetres(rect, [hole], 0.01, W, H)).toBeCloseTo(7.5)
  })

  it('clamps at zero when deductions exceed the outer boundary', () => {
    expect(polygonAreaSquareMetres(rect, [rect, rect], 0.01, W, H)).toBe(0)
  })

  it('treats a boundary with fewer than three points as no area', () => {
    expect(polygonAreaNormalised([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0)
  })
})

describe('segment length', () => {
  it('measures a diagonal through the same bridge', () => {
    // Δ = (0.3·1000, 0.4·500) = (300, 200) px → hypot 360.55 px → 3.6055 m.
    expect(segmentLengthMetres({ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.5 }, 0.01, W, H)).toBeCloseTo(3.6055, 3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/rfq_intake/__tests__/geometry.test.ts`
Expected: FAIL — cannot find module `../lib/geometry`.

- [ ] **Step 3: Implement**

```ts
export type Point = { x: number; y: number }
export type LinearUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft'
export type AreaUnit = 'mm2' | 'cm2' | 'm2' | 'in2' | 'ft2'
export type Calibration = {
  start: Point
  end: Point
  realLength: { value: number; unit: LinearUnit }
}

const LINEAR_TO_METRES: Record<LinearUnit, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 }
const AREA_TO_SQUARE_METRES: Record<AreaUnit, number> = {
  mm2: 1e-6,
  cm2: 1e-4,
  m2: 1,
  in2: 0.00064516,
  ft2: 0.09290304,
}

/** Tolerance for two calibrations describing the same drawing. 2% absorbs pixel rounding. */
const CALIBRATION_TOLERANCE = 0.02

export function toMetres(value: number, unit: LinearUnit): number {
  return value * LINEAR_TO_METRES[unit]
}

export function toSquareMetres(value: number, unit: AreaUnit): number {
  return value * AREA_TO_SQUARE_METRES[unit]
}

/**
 * V2 coordinates are normalised to the IMAGE, so x and y are divided by different
 * numbers. Recovering pixels means multiplying each axis by its own dimension before
 * measuring the distance — averaging the two would be wrong on any non-square image.
 */
export function metresPerPixel(c: Calibration, imageWidthPx: number, imageHeightPx: number): number | null {
  const dx = (c.end.x - c.start.x) * imageWidthPx
  const dy = (c.end.y - c.start.y) * imageHeightPx
  const px = Math.hypot(dx, dy)
  if (!Number.isFinite(px) || px <= 0) return null
  const metres = toMetres(c.realLength.value, c.realLength.unit)
  if (!Number.isFinite(metres) || metres <= 0) return null
  return metres / px
}

/** Two or more calibrations must describe the same scale, or the drawing is not trustworthy. */
export function calibrationAgreement(values: number[]): boolean {
  if (values.length < 2) return true
  const min = Math.min(...values)
  const max = Math.max(...values)
  return (max - min) / max <= CALIBRATION_TOLERANCE
}

/** Shoelace, absolute so that boundary winding order does not change the sign. */
export function polygonAreaNormalised(points: Point[]): number {
  if (points.length < 3) return 0
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

export function polygonAreaSquareMetres(
  outer: Point[],
  holes: Point[][],
  metresPerPx: number,
  imageWidthPx: number,
  imageHeightPx: number,
): number {
  const pxPerNormalisedUnit = imageWidthPx * imageHeightPx
  const factor = pxPerNormalisedUnit * metresPerPx * metresPerPx
  const gross = polygonAreaNormalised(outer) * factor
  const voids = holes.reduce((acc, hole) => acc + polygonAreaNormalised(hole) * factor, 0)
  return Math.max(0, round2(gross - voids))
}

export function segmentLengthMetres(
  a: Point,
  b: Point,
  metresPerPx: number,
  imageWidthPx: number,
  imageHeightPx: number,
): number {
  const px = Math.hypot((b.x - a.x) * imageWidthPx, (b.y - a.y) * imageHeightPx)
  return round2(px * metresPerPx)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/rfq_intake/__tests__/geometry.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/rfq_intake/lib/geometry.ts src/modules/rfq_intake/__tests__/geometry.test.ts
git commit -m "feat(rfq_intake): add pure geometry primitives for quantity derivation"
```

### Task 5: Basis → quantity and unit

**Files:**
- Create: `src/modules/rfq_intake/lib/basisResolver.ts`
- Create: `src/modules/rfq_intake/__tests__/basis-resolver.test.ts`

**Interfaces:**
- Consumes: every export of Task 4.
- Produces:

```ts
// `RoomMeasurementsResult` is the V2 `data` object from
// `src/modules/property_documents/room-measurements-contract.ts` (PR #35). Until that
// merges, declare a local structural type with the same shape in this file and swap the
// declaration for an import afterwards — no call site changes.
export type Basis = 'floor_area' | 'gross_wall_area' | 'net_wall_area' | 'count' | 'given'
export type QuantityOk = {
  ok: true
  quantity: number
  unit: 'm2' | 'mb' | 'szt' | 'kpl'
  /** Set only when a derived count replaced a model-supplied one. */
  overriddenCount?: number
}
export type QuantityFailure = { ok: false; code: string }
export function acceptedUnitsFor(basis: Basis, givenUnit?: string): string[]
export function resolveQuantity(
  result: RoomMeasurementsResult,
  args: {
    basis: Basis
    roomIds?: string[]
    count?: number
    /** When set, the count comes from `openings[].kind` and any supplied `count` is ignored. */
    derivedFrom?: 'door' | 'window'
    given?: { value: number; unit: string }
  },
): QuantityOk | QuantityFailure
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from '@jest/globals'
import { acceptedUnitsFor, resolveQuantity } from '../lib/basisResolver'

const drawing = {
  imageWidthPx: 1000,
  imageHeightPx: 500,
  declaredUnit: null,
  declaredScale: null,
  globalCeilingHeight: { value: 2.7, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
  calibrations: [
    {
      id: 'cal-1',
      start: { x: 0.25, y: 0.5 },
      end: { x: 0.75, y: 0.5 },
      realLength: { value: 5, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
      calculationEligibility: 'eligible',
    },
  ],
}

function room(overrides: Record<string, unknown> = {}) {
  return {
    id: 'room-1',
    printedName: 'Salon',
    location: 'parter',
    floor: {
      outerBoundary: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.5 },
        { x: 0.1, y: 0.5 },
      ],
      holes: [],
      printedArea: null,
      calculationEligibility: 'eligible',
    },
    walls: [
      {
        id: 'w1',
        start: { x: 0.1, y: 0.1 },
        end: { x: 0.5, y: 0.1 },
        length: { value: 4, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
        heightProfile: 'constant',
        startHeight: null,
        endHeight: null,
        usesGlobalHeight: true,
        calculationEligibility: 'eligible',
      },
    ],
    openings: [
      {
        id: 'o1',
        kind: 'window',
        wallId: 'w1',
        width: { value: 1.5, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
        height: { value: 1.2, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
        sillHeight: null,
        calculationEligibility: 'eligible',
      },
    ],
    confidence: 0.9,
    warnings: [],
    readiness: { floorArea: 'eligible', grossWallArea: 'eligible', netWallArea: 'eligible' },
    missingInputs: [],
    ...overrides,
  }
}

function result(rooms: unknown[] = [room()]) {
  return { schemaVersion: '1', analysisStatus: 'complete', drawing, rooms, warnings: [] } as never
}

describe('acceptedUnitsFor', () => {
  it('maps every area basis to m2 and count to both piece units', () => {
    expect(acceptedUnitsFor('floor_area')).toEqual(['m2'])
    expect(acceptedUnitsFor('net_wall_area')).toEqual(['m2'])
    expect(acceptedUnitsFor('count')).toEqual(['szt', 'kpl'])
    expect(acceptedUnitsFor('given', 'mb')).toEqual(['mb'])
  })
})

describe('resolveQuantity', () => {
  it('computes floor area from the polygon when the drawing prints none', () => {
    // 400px × 200px at 0.01 m/px = 8 m².
    expect(resolveQuantity(result(), { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
      ok: true, quantity: 8, unit: 'm2',
    })
  })

  it('prefers a printed area over the polygon, because the drawing stated it', () => {
    const printed = room({
      floor: {
        ...room().floor,
        printedArea: { value: 14, unit: 'm2', basis: 'net', method: 'printed', calculationEligibility: 'eligible' },
      },
    })
    expect(resolveQuantity(result([printed]), { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
      ok: true, quantity: 14, unit: 'm2',
    })
  })

  it('ignores a printed area whose basis is unknown and falls back to the polygon', () => {
    const ambiguous = room({
      floor: {
        ...room().floor,
        printedArea: { value: 14, unit: 'm2', basis: 'unknown', method: 'printed', calculationEligibility: 'eligible' },
      },
    })
    expect(resolveQuantity(result([ambiguous]), { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
      ok: true, quantity: 8, unit: 'm2',
    })
  })

  it('computes gross wall area from length and the global ceiling height', () => {
    expect(resolveQuantity(result(), { basis: 'gross_wall_area', roomIds: ['room-1'] })).toEqual({
      ok: true, quantity: 10.8, unit: 'm2',
    })
  })

  it('subtracts openings for net wall area, which is what painting is priced on', () => {
    // 10.8 − (1.5 × 1.2) = 9.0
    expect(resolveQuantity(result(), { basis: 'net_wall_area', roomIds: ['room-1'] })).toEqual({
      ok: true, quantity: 9, unit: 'm2',
    })
  })

  it('refuses wall area when no height is available, because a plan view has no vertical axis', () => {
    const noHeight = room({ walls: [{ ...room().walls[0], usesGlobalHeight: false }] })
    const noGlobal = { ...result([noHeight]), drawing: { ...drawing, globalCeilingHeight: null } } as never
    expect(resolveQuantity(noGlobal, { basis: 'gross_wall_area', roomIds: ['room-1'] })).toEqual({
      ok: false, code: 'ceiling_height_missing',
    })
  })

  it('refuses when no calibration exists and the value is not printed', () => {
    const noCal = { ...result(), drawing: { ...drawing, calibrations: [] } } as never
    expect(resolveQuantity(noCal, { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
      ok: false, code: 'scale_missing',
    })
  })

  it('refuses a room whose readiness flag is not eligible', () => {
    const blocked = room({ readiness: { floorArea: 'review_required', grossWallArea: 'eligible', netWallArea: 'eligible' } })
    expect(resolveQuantity(result([blocked]), { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
      ok: false, code: 'floor_boundary_incomplete',
    })
  })

  it('refuses every basis when the image was not a floor plan', () => {
    const notPlan = { ...result(), analysisStatus: 'not_floor_plan' } as never
    expect(resolveQuantity(notPlan, { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
      ok: false, code: 'not_floor_plan',
    })
  })

  it('refuses an unknown room id rather than silently quoting nothing', () => {
    expect(resolveQuantity(result(), { basis: 'floor_area', roomIds: ['room-9'] })).toEqual({
      ok: false, code: 'room_not_found',
    })
  })

  it('sums the referenced rooms, so one line can cover a whole flat', () => {
    const second = { ...room(), id: 'room-2' }
    expect(resolveQuantity(result([room(), second]), { basis: 'floor_area', roomIds: ['room-1', 'room-2'] })).toEqual({
      ok: true, quantity: 16, unit: 'm2',
    })
  })

  it('passes a plain count through, because sockets do not appear on a plan view', () => {
    expect(resolveQuantity(result(), { basis: 'count', count: 7 })).toEqual({
      ok: true, quantity: 7, unit: 'szt',
    })
  })

  it('derives a window count from openings and ignores the number the model supplied', () => {
    // The room carries exactly one window; the model claimed five.
    expect(
      resolveQuantity(result(), { basis: 'count', roomIds: ['room-1'], count: 5, derivedFrom: 'window' }),
    ).toEqual({ ok: true, quantity: 1, unit: 'szt', overriddenCount: 5 })
  })

  it('refuses a door count rather than inventing one when the room has no doors', () => {
    expect(
      resolveQuantity(result(), { basis: 'count', roomIds: ['room-1'], derivedFrom: 'door' }),
    ).toEqual({ ok: false, code: 'no_openings_of_kind' })
  })

  it('passes a given quantity through with its declared unit', () => {
    expect(resolveQuantity(result(), { basis: 'given', given: { value: 68, unit: 'm2' } })).toEqual({
      ok: true, quantity: 68, unit: 'm2',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/modules/rfq_intake/__tests__/basis-resolver.test.ts`
Expected: FAIL — cannot find module `../lib/basisResolver`.

- [ ] **Step 3: Implement**

Structure the module around a table, not a switch, so a reserved basis lands as one row:

```ts
type BasisSpec = {
  acceptedUnits: ReadonlyArray<'m2' | 'mb' | 'szt' | 'kpl'>
  resolve: (ctx: BasisContext) => QuantityOk | QuantityFailure
}

/**
 * Reserved but NOT implemented, named here so the work that adds them does not invent
 * a parallel vocabulary: `floor_perimeter` (+ excludeDoorways), `opening_perimeter`
 * (+ openingKind), `wall_run_length`, `same_as` (+ refItemIndex). Today there is no
 * linear basis at all, so the catalogue's `mb` services are reachable only via `given`.
 */
export const BASIS_SPECS: Record<Basis, BasisSpec> = {
  floor_area: { acceptedUnits: ['m2'], resolve: resolveFloorArea },
  gross_wall_area: { acceptedUnits: ['m2'], resolve: resolveGrossWallArea },
  net_wall_area: { acceptedUnits: ['m2'], resolve: resolveNetWallArea },
  count: { acceptedUnits: ['szt', 'kpl'], resolve: resolveCount },
  given: { acceptedUnits: ['m2', 'mb', 'szt', 'kpl'], resolve: resolveGiven },
}
```

`acceptedUnitsFor` reads the table; `resolveQuantity` dispatches through it. Then implement each resolver so that:

1. `analysisStatus` outside `{complete, partial}` returns `{ ok: false, code: 'not_floor_plan' }` (use `'unreadable'` when that is the status).
2. Each `roomIds` entry must match a `rooms[].id`; a miss returns `room_not_found`.
3. The readiness flag for the basis must be `eligible`, otherwise return the first relevant `missingInputs[].code`, defaulting to `floor_boundary_incomplete` for floor and `wall_length_missing` for walls.
4. `metresPerPixel` is computed for every calibration; `calibrationAgreement` must hold, otherwise `calibration_disagreement`. With no calibration, only `printed` values are usable and anything else returns `scale_missing`.
5. `floor_area` uses `printedArea` when it is non-null, `eligible`, and `basis ∈ {gross, net}`, converting with `toSquareMetres`; otherwise `polygonAreaSquareMetres`.
6. `gross_wall_area` sums `length × height` per wall, where `length` is the printed value when present and `segmentLengthMetres` otherwise, and height is `startHeight`/`endHeight` averaged when both exist, `drawing.globalCeilingHeight` when `usesGlobalHeight`, and otherwise `ceiling_height_missing`.
7. `net_wall_area` subtracts `width × height` for every opening whose `wallId` names a wall of that room, clamped at zero.
8. `count` with `derivedFrom` tallies `openings[]` of that `kind` across the referenced rooms, sets `overriddenCount` when a `count` was also supplied and differs from the tally, and returns `no_openings_of_kind` when the tally is zero. Without `derivedFrom` it returns the supplied `count` with unit `szt`, which is the socket and lighting-point case.
9. `given` returns the supplied value and unit unchanged.
10. Every value with `method === 'scale_derived'` is recomputed from `start`/`end` and compared against the supplied value; a relative difference above 2% returns `scale_derived_mismatch`.

Sum across `roomIds` and round to two decimals.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/rfq_intake/__tests__/basis-resolver.test.ts && yarn typecheck && yarn lint`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/rfq_intake/lib/basisResolver.ts src/modules/rfq_intake/__tests__/basis-resolver.test.ts
git commit -m "feat(rfq_intake): resolve quantity and unit from a measurement basis"
```

---

# PR 4 — The priced quote draft

**Deliverable:** the command loads the V2 run, resolves each item to a priced line, and creates one unsent Sales quote. This is the first demoable milestone: a quote appears from a hand-written payload, with no agent involved.

### Task 6: Load the room-measurements run in scope

**Files:**
- Modify: `src/modules/rfq_intake/commands/quote-create.ts`
- Modify: `src/modules/rfq_intake/__tests__/quote-create-command.test.ts`

**Interfaces:**
- Consumes: `AgentRun` from `@open-mercato/enterprise/modules/agent_orchestrator/data/entities`.
- Produces: `loadRoomMeasurements(em, scope, runId): Promise<RoomMeasurementsResult | null>` exported from the command module.

- [ ] **Step 1: Write the failing test**

```ts
it('fails closed when the room-measurements run is not in the derived scope', async () => {
  const ctx = makeCtx({ run: null })
  await expect(createQuoteCommand.execute(validInput, ctx)).rejects.toThrow(/run/i)
})

it('rejects a run produced by a different agent, so any AgentRun id will not do', async () => {
  const ctx = makeCtx({ run: { id: runId, agentId: 'property_documents.pdf_intake', status: 'ok', result: {} } })
  await expect(createQuoteCommand.execute(validInput, ctx)).rejects.toThrow(/run/i)
})

it('rejects a run that has not terminated successfully', async () => {
  const ctx = makeCtx({
    run: { id: runId, agentId: 'property_documents.room_measurements', status: 'running', result: null },
  })
  await expect(createQuoteCommand.execute(validInput, ctx)).rejects.toThrow(/run/i)
})

it('parses the accepted V2 envelope and exposes it to the item loop', async () => {
  const ctx = makeCtx({
    run: {
      id: runId,
      agentId: 'property_documents.room_measurements',
      status: 'ok',
      result: { kind: 'research', data: { schemaVersion: '1', analysisStatus: 'complete', drawing, rooms: [], warnings: [] } },
    },
  })
  // No rooms means no items survive, which is a valid outcome and not a throw.
  const result = await createQuoteCommand.execute(validInput, ctx)
  expect(result.quoteId).toBeNull()
})
```

Extend `makeCtx` so its `em.fork()` returns a `findOne` that answers `CustomerDeal` and `AgentRun` separately, and reuse the `drawing` fixture from `basis-resolver.test.ts` by extracting it to `__tests__/fixtures/roomMeasurements.ts` in this step.

- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement** the scoped `findOne` on `AgentRun` filtered by `id`, `tenantId`, `organizationId`, `agentId === 'property_documents.room_measurements'` and a terminal `ok` status, strict-parsing the stored result.
- [ ] **Step 4: Run the file's tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(rfq_intake): load the scoped room-measurements result`.

### Task 7: Item loop, unit gate and Sales call

**Files:**
- Modify: `src/modules/rfq_intake/commands/quote-create.ts`
- Modify: `src/modules/rfq_intake/__tests__/quote-create-command.test.ts`

**Interfaces:**
- Consumes: `resolveQuantity` and `acceptedUnitsFor` (Task 5), `resolveUnitPrice` (Task 3), `runCommand` from `../lib/commandBus`.
- Produces: the final `QuoteCreateResult` with a real `quoteId`.

- [ ] **Step 1: Write the failing tests**, one per behavior:

```ts
it('drops an item whose basis unit does not match the product, instead of coercing it', async () => {
  // REN-CAR-01 bills in `szt`; a floor_area basis yields m2.
  const result = await createQuoteCommand.execute(
    { dealId, roomMeasurementsRunId: runId, items: [{ catalogProductId: doorProductId, basis: 'floor_area', roomIds: ['room-1'] }] },
    makeCtx(),
  )
  expect(result.quoteId).toBeNull()
  expect(result.warnings).toContain('unit_mismatch:' + doorProductId)
})

it('creates no quote when every item is dropped', async () => {
  const result = await createQuoteCommand.execute(allInvalidInput, makeCtx())
  expect(result).toEqual({ quoteId: null, lineCount: 0, warnings: expect.any(Array) })
  expect(salesCalls).toHaveLength(0)
})

it('calls sales.quotes.create once with gross lines and RFQ metadata', async () => {
  const result = await createQuoteCommand.execute(validPaintingInput, makeCtx())
  expect(salesCalls).toHaveLength(1)
  expect(salesCalls[0].id).toBe('sales.quotes.create')
  expect(salesCalls[0].input.currencyCode).toBe('PLN')
  expect(salesCalls[0].input.metadata).toEqual({ rfqDealId: dealId, roomMeasurementsRunId: runId, source: 'rfq_intake' })
  expect(salesCalls[0].input.lines[0]).toMatchObject({
    kind: 'service', productId: paintProductId, quantity: 9, quantityUnit: 'm2',
    unitPriceGross: '40.0000', priceMode: 'gross', currencyCode: 'PLN',
  })
  expect(result).toEqual({ quoteId: 'created-quote-id', lineCount: 1, warnings: [] })
})

it('drops outliers when lines resolve to mixed currencies', async () => {
  const result = await createQuoteCommand.execute(mixedCurrencyInput, makeCtx())
  expect(salesCalls[0].input.lines).toHaveLength(1)
  expect(result.warnings).toContain('currency_outlier_dropped')
})
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the loop: for each item call `resolveQuantity`, then `resolveUnitPrice` with that quantity; compare the produced unit against `acceptedUnitsFor(...)` and the product's `defaultUnit`; drop with a bounded warning on any failure. Pick the majority currency, drop outliers, and when at least one line survives call `runCommand(ctx, 'sales.quotes.create', {...})` with `tenantId`, `organizationId`, `currencyCode`, `metadata` and `lines`. Resolve `customerEntityId` from the deal's single linked company (`customer_deal_companies`) else its primary person (`customer_deal_people` where `is_primary`), omitting the field when neither exists.
- [ ] **Step 4: Run the full module suite and the gate.**

Run: `yarn test src/modules/rfq_intake/__tests__/ && yarn generate && yarn typecheck && yarn lint`

- [ ] **Step 5: Commit** — `feat(rfq_intake): create a priced unsent sales quote from mapped items`.

---

# PR 5 — The invocation path and the probe agent

**Deliverable:** an agent proposal reaches the command through `executeProposal`, proving all five gates. Requires PR #35 merged.

### Task 8: The apply-proposal bridge

**Files:**
- Create: `src/modules/rfq_intake/commands/apply-proposal.ts`
- Create: `src/modules/rfq_intake/__tests__/apply-proposal-command.test.ts`

**Interfaces:**
- Consumes: `executeProposal` from `@open-mercato/enterprise/modules/agent_orchestrator`; `AgentProposal` from its `data/entities`.
- Produces: command `rfq_intake.quote.apply_proposal` taking `{ workflowInstanceId, agentId }` and returning `{ applied: number; skipped: string[]; errors: string[] }`.

- [ ] **Step 1: Write the failing tests** — a disposed proposal whose `selectedOptionId` names an option runs its actions; a `skipped` result is surfaced rather than swallowed; a proposal from another tenant is not found.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement**: load the scoped `AgentProposal` by `workflowInstanceId` + `agentId`, read `selectedOptionId`, select that option from `payload.options`, and call:

```ts
const results = await executeProposal(option.actions, {
  commandBus: ctx.container.resolve('commandBus'),
  commandCtx: ctx,
  // Gate 4: without this entry every action returns `skipped: no command mapped`.
  actionCommandMap: { 'rfq.quote.create': 'rfq_intake.quote.create' },
  allowedActions: ['rfq_intake.quote.create'],
})
```

Every result whose `status` is not `ok` becomes a visible warning — a silent `skipped` is exactly how the two enablement gates fail.

- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(rfq_intake): bridge disposed proposals to the quote command`.

### Task 9: The temporary probe agent

**Files:**
- Create: `src/modules/rfq_intake/ai-agents.ts`
- Create: `src/modules/rfq_intake/__tests__/quote-probe-agent.test.ts`
- Modify: `src/modules/rfq_intake/workflows.ts` (one step running the bridge after the agent step)

- [ ] **Step 1: Write the failing test** — the agent is registered with `allowedActions: ['rfq_intake.quote.create']` (gate 3) and emits exactly one option carrying one action of type `rfq.quote.create`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement** `rfq_intake.quote_probe` behind the existing enterprise agent flags. It forwards the payload it is handed and performs no mapping, carrying:

```ts
// HACK(hackathon): temporary probe. It exists only to exercise the five gates and the
// executeProposal path before the real mapping agent lands. Its auto-approve threshold
// is a TEST-ONLY setting; on a real agent that field is a safety boundary.
// Remove this agent in the slice that introduces the mapping agent.
```

- [ ] **Step 4: Run the full gate.**

Run: `yarn generate && yarn typecheck && yarn lint && yarn test`

- [ ] **Step 5: Commit** — `feat(rfq_intake): add a temporary probe agent for the proposal path`.

### Task 10: Prove the five gates end to end

- [ ] **Step 1:** Confirm `rfq_intake.quote.create` appears in `listWorkflowSafeCommands()` (gate 1).
- [ ] **Step 2:** Confirm the demo tenant has it enabled in workflow-command settings (gate 2).
- [ ] **Step 3:** Confirm the probe's `allowedActions` admits it (gate 3).
- [ ] **Step 4:** Confirm `actionCommandMap` resolves the action type (gate 4).
- [ ] **Step 5:** Confirm the vocabulary loads — a missing `workflows` peer blocks every effect (gate 5).
- [ ] **Step 6:** Run one RFQ through and record the resulting quote id in the PR description. If any result is `skipped`, name which gate produced it rather than retrying blindly.

---

## Execution Notes

- PR 3 can be written before PR #35 merges: `geometry.ts` depends on nothing, and `basisResolver.ts` needs only the V2 *shape*. Import the contract types from `@/modules/property_documents/room-measurements-contract` once merged — `workflows.ts:3` already imports across app modules, so the pattern is established.
- After PR 4 the feature is demoable without an agent. If time runs short, PR 5 is the part to cut.
- Nothing in this plan applies a migration. There is no schema change to generate.

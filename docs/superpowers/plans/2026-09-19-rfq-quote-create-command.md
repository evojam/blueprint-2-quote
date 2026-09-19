# RFQ Quote Creation Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `rfq_intake.quote.create`, a command that turns an agent's mapping of renovation work onto Catalog services into a priced, unsent Sales quote, with every quantity computed deterministically rather than supplied by the model.

**Architecture:** Five sequential PRs. PR 1 lands the registered command with full plumbing and no business logic. PR 2 and PR 3 add two independently testable units — per-unit variant price resolution and geometry/quantity arithmetic. PR 4 joins them and calls Sales, which is the first demoable milestone. PR 5 adds the `executeProposal` bridge and a temporary probe agent.

**Tech Stack:** TypeScript, Next.js, MikroORM/PostgreSQL, Zod 4, Jest 30, Open Mercato 0.8.0 (Catalog, Customers, Sales, Workflows, Agent Orchestrator).

**Spec:** `.ai/specs/2026-09-19-rfq-quote-create-command.md`

---

## Verified Baseline — the actual state of `origin/main`

An earlier revision of this plan was written against the unmerged `feat/deal-document-links` branch and described commands and workflow steps that **do not exist on `main`**. Everything below was re-verified against `origin/main` at `680300a`. Check these before trusting any instruction that contradicts them.

| Fact | Verified state on `main` |
|---|---|
| Commands in `src/modules/rfq_intake/commands/` | `analysis.ts` → `rfq_intake.requirements.match`; `pipeline.ts` → `rfq_intake.deal.advance`. **There is no `rfq_intake.plans.analyze`.** |
| Workflow-safe declarations in `workflows.ts` | Exactly **one**: `rfq_intake.requirements.match`. `deal.advance` exists as a command but is *not* declared workflow-safe. |
| Workflow graph (`RFQ_ANALYSIS_WORKFLOW_ID = 'rfq_intake.analysis'`) | `start → extract_pdf → match_catalog → end`, transitions `t_start`, `t_match`, `t_done`, `interpolation: 'strict'`. **No `mark_quoting`, `measure_plans` or `mark_review` steps.** |
| `src/modules/rfq_intake/lib/` | `commandBus.ts`, `ensureContact.ts`, `pipeline.ts`, `processDefinition.ts`, `startProcess.ts`. No `ai-agents.ts` anywhere in the module. |
| Module registration | `src/modules.ts:38` lists `sales` statically; `rfq_intake` is pushed at `:106` **inside the enterprise-flag block**, deliberately last so its inbox `create_quote` override wins. |
| `.mercato/generated` | **Tracked in git.** `rfq_intake` appears in exactly one generated file (`app-modules-overrides.compiled.mjs`); no `rfq_intake` command id appears in any generated artifact. The committed build is the **flags-off** build. |

### Pre-existing test failures — do not attribute these to this work

`src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts` fails **5 of 9** on a clean detached checkout of `origin/main` (680300a), all in the `rfq_intake inbox action registry` block. The installed `sales` `create_quote` definition wins over the `rfq_intake` override, so labels, payload schema and `normalizePayload` all resolve to the installed one.

Cause: the committed generated registry is the flags-off build, so `rfq_intake` is not in it. Setting `OM_ENABLE_ENTERPRISE_MODULES=true OM_ENABLE_ENTERPRISE_MODULES_AGENTS=true` at *test* time does not help, because the test reads the committed artifact rather than regenerating.

**Baseline to compare against: module-wide `5 failed / 63 passed`, and `5 failed / 4 passed` in that one suite.** A task is green when it does not move those numbers. Fixing them is out of scope here — it requires regenerating with the enterprise flags, which rewrites tracked artifacts and is a repo-wide decision, not a side effect of this feature.

## Global Constraints

- `tenantId` and `organizationId` come **only** from `ctx` (`ctx.auth.tenantId`, `ctx.selectedOrganizationId ?? ctx.auth.orgId`). Missing scope is an error, never unrestricted access.
- The input schema is **non-strict**: unknown keys are stripped, following `src/modules/deal_links/commands/document-links.ts`. Payload scope keys never reach a write.
- `dealId` and `roomMeasurementsRunId` arrive from a language model and are re-read in derived scope; a miss fails closed.
- Cross-module access is by scalar ID and owner-command call only. Never add an ORM relation from `rfq_intake` to an installed module.
- Never edit `node_modules`, shipped migrations, or generated facts by hand.
- **Run `yarn generate` without the enterprise flags and expect a clean tree.** That reproduces the committed build. Running it *with* the flags rewrites tracked artifacts across the repo; do not do it as part of this feature.
- No new entity and no migration anywhere in this plan. Two invocations creating two quotes is an accepted, documented shortcut.
- Prices resolve on the **variant**: every `catalog_product_variant_prices` row created by `catalog_seed` carries a `variantId`, so a product-level lookup finds nothing.
- Money is gross: the seed writes `unitPriceGross` with a VAT 8% `taxRateId`, so lines use `priceMode: 'gross'`.
- A product's `defaultUnit` is the unit gate. A basis producing a different unit drops the item; never coerce, never substitute another product or variant.
- Every shortcut gets an inline `// HACK(hackathon): <what, why, what breaks>`.
- Gate after every task: `yarn generate && yarn typecheck && yarn lint`, then the focused tests.

## File Structure

| File | Responsibility | PR |
|---|---|---|
| `src/modules/rfq_intake/commands/quote-create.ts` | Input union, scope derivation, deal/run verification, item loop, Sales call | 1, 4 |
| `src/modules/rfq_intake/workflows.ts` | One added workflow-safe declaration; in PR 5, one added step | 1, 5 |
| `src/modules/rfq_intake/lib/catalogPricing.ts` | Variant resolution and unit-price lookup | 2 |
| `src/modules/rfq_intake/lib/geometry.ts` | Pixel bridge, shoelace, distances, unit normalization | 3 |
| `src/modules/rfq_intake/lib/basisResolver.ts` | Basis → quantity + unit over a set of V2 rooms | 3 |
| `src/modules/rfq_intake/commands/apply-proposal.ts` | Loads the disposed proposal, calls `executeProposal` | 5 |
| `src/modules/rfq_intake/ai-agents.ts` | The temporary probe agent — a new file, the module has none | 5 |

Tests sit in `src/modules/rfq_intake/__tests__/`, one file per unit, following the `makeCtx()` container-stub style of `__tests__/advance-command.test.ts`.

---

# PR 1 — The registered command, no business logic ✅ IMPLEMENTED

Landed on branch `feat/rfq-quote-create-command`. Recorded here so the plan matches reality and the remaining PRs build on named interfaces.

### Task 1: Input contract and scope derivation ✅ DONE

**Files:** `src/modules/rfq_intake/commands/quote-create.ts`, `src/modules/rfq_intake/__tests__/quote-create-command.test.ts`

**Produces, relied on by every later task:**

```ts
export const quoteCreateInputSchema: z.ZodType   // { dealId, roomMeasurementsRunId, items }
export type QuoteCreateInput
export type QuoteItemInput                       // one member of the basis union
export type QuoteCreateResult = { quoteId: string | null; lineCount: number; warnings: string[] }
export function ensureScope(ctx: CommandRuntimeContext): { tenantId: string; organizationId: string }
export const createQuoteCommand                  // id 'rfq_intake.quote.create'
```

The item schema is `z.discriminatedUnion('basis', [...])` over `floor_area`, `gross_wall_area`, `net_wall_area` (each requiring `roomIds`), `count` (requiring `count`) and `given` (requiring `given: { value, unit }`). The handler parses, derives scope, re-reads `CustomerDeal` in that scope, and returns `{ quoteId: null, lineCount: 0, warnings: ['quote_creation_not_implemented'] }`.

- [x] 8 tests pass: scope-key stripping, `roomIds` required for an area basis, a stray `count` on an area basis being dropped, empty item list rejected, missing tenant, missing organization, foreign deal, and the not-implemented result.

### Task 2: Make the command reachable ✅ DONE

**Files:** `src/modules/rfq_intake/workflows.ts`, `src/modules/rfq_intake/__tests__/workflow-safe-commands.test.ts`

Added as a **second** element of the existing one-element array — not a fourth, which is what the earlier revision of this plan wrongly claimed:

```ts
  {
    commandId: 'rfq_intake.quote.create',
    requiredFeatures: ['customers.deals.manage', 'sales.quotes.manage'],
    labelKey: 'rfq_intake.workflows.commands.quote.create',
  },
```

- [x] 3 tests pass: the declaration exists with those features, the existing matcher declaration survives, and both `rfq_intake` entries are opt-in (`defaultEnabled` unset) — gate 2.

### Task 3: Close out PR 1

- [ ] **Step 1: Confirm the gate and the baseline**

```bash
yarn generate && yarn typecheck && yarn lint
yarn test src/modules/rfq_intake/__tests__/
```

Expected: `generate` leaves the tree clean; typecheck silent; lint `0 errors, 9 warnings` (all pre-existing, none in `rfq_intake`); tests `5 failed / 63 passed` — the baseline above, unchanged.

- [ ] **Step 2: Squash the WIP commit**

```bash
git rebase -i origin/main    # fold "wip: task 2 workflow-safe registration" into a real message
```

- [ ] **Step 3: Enable the command for the demo tenant**

The entry is deliberately not `defaultEnabled`, so nothing runs until a tenant switches it on once in workflow-command settings. Do it now, not at the end: it is gate 2, it fails as a silent `skipped`, and it is the failure the spec calls a demo-killer. Record which tenant in the PR description.

- [ ] **Step 4: Open the PR**, stating the pre-existing 5 failures with the baseline numbers so a reviewer does not chase them.

---

# PR 2 — Per-unit price resolution

**Deliverable:** given a product, an optional variant and a quantity, return the authoritative gross unit price in scope, or a typed refusal. No quote, no geometry.

### Task 4: Variant resolution and price lookup

**Files:**
- Create: `src/modules/rfq_intake/lib/catalogPricing.ts`
- Create: `src/modules/rfq_intake/__tests__/catalog-pricing.test.ts`

**Interfaces:**
- Consumes: `catalogPricingService` from the container (registered in `node_modules/@open-mercato/core/src/modules/catalog/di.ts:13`); entities `CatalogProduct`, `CatalogProductVariant`, `CatalogProductPrice` and helper `resolvePriceVariantId` from `@open-mercato/core/modules/catalog/{data/entities,lib/pricing}`.
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
export type PriceFailure = {
  reason: 'product_not_found' | 'variant_not_found' | 'variant_foreign' | 'no_price' | 'price_identity_mismatch'
}
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

function makeEm(rows: { product?: unknown; variant?: unknown; prices?: unknown[] }) {
  return {
    findOne: async (entity: { name: string }) =>
      entity.name === 'CatalogProduct' ? (rows.product ?? null) : (rows.variant ?? null),
    find: async () => rows.prices ?? [],
  } as never
}

function makeContainer(resolved: unknown) {
  return {
    resolve: (name: string) =>
      name === 'catalogPricingService' ? { resolvePrice: async () => resolved } : null,
  }
}

describe('resolveUnitPrice', () => {
  it('falls back to the default variant, which the seed sets for every service', async () => {
    const result = await resolveUnitPrice(
      makeEm({ product, variant: defaultVariant, prices: [priceRow] }),
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
      makeEm({ product, variant: foreign, prices: [priceRow] }),
      makeContainer(priceRow),
      scope,
      { productId, variantId: otherVariantId, quantity: 1 },
    )

    expect(result).toEqual({ reason: 'variant_foreign' })
  })

  it('refuses when the resolver hands back a price for a different variant', async () => {
    // A pricing extension may adjust the amount for the same identity. Returning a
    // different variant would quietly quote another product.
    const strayPrice = { ...priceRow, variant: { id: otherVariantId } }
    const result = await resolveUnitPrice(
      makeEm({ product, variant: defaultVariant, prices: [priceRow] }),
      makeContainer(strayPrice),
      scope,
      { productId, quantity: 1 },
    )

    expect(result).toEqual({ reason: 'price_identity_mismatch' })
  })

  it('refuses when the variant has no price row at all', async () => {
    const result = await resolveUnitPrice(
      makeEm({ product, variant: defaultVariant, prices: [] }),
      makeContainer(null),
      scope,
      { productId, quantity: 1 },
    )

    expect(result).toEqual({ reason: 'no_price' })
  })

  it('refuses an unknown product before touching pricing', async () => {
    const result = await resolveUnitPrice(
      makeEm({ product: null }),
      makeContainer(priceRow),
      scope,
      { productId, quantity: 1 },
    )

    expect(result).toEqual({ reason: 'product_not_found' })
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
import { resolvePriceVariantId } from '@open-mercato/core/modules/catalog/lib/pricing'
import type {
  CatalogPricingService,
  PriceRow,
} from '@open-mercato/core/modules/catalog/services/catalogPricingService'

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
 * so a product-level lookup finds nothing against demo data.
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
    : await em.findOne(CatalogProductVariant, {
        ...scope,
        product: args.productId,
        isDefault: true,
        deletedAt: null,
      })
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
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/rfq_intake/lib/catalogPricing.ts src/modules/rfq_intake/__tests__/catalog-pricing.test.ts
git commit -m "feat(rfq_intake): resolve the authoritative variant unit price"
```

---

# PR 3 — Pure quantity arithmetic

**Deliverable:** two dependency-free modules turning a `property_documents.room_measurements` V2 result into a quantity and a unit. No database, no container, no Sales. Writable before PR #35 merges.

### Task 5: Geometry primitives

**Files:**
- Create: `src/modules/rfq_intake/lib/geometry.ts`
- Create: `src/modules/rfq_intake/__tests__/geometry.test.ts`

**Interfaces:**
- Consumes: nothing at runtime.
- Produces: `Point`, `LinearUnit`, `AreaUnit`, `Calibration`, `toMetres`, `toSquareMetres`, `metresPerPixel`, `calibrationAgreement`, `polygonAreaNormalised`, `polygonAreaSquareMetres`, `segmentLengthMetres`.

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
const rect = [
  { x: 0.1, y: 0.1 },
  { x: 0.5, y: 0.1 },
  { x: 0.5, y: 0.5 },
  { x: 0.1, y: 0.5 },
]

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
    expect(
      metresPerPixel(
        { start: { x: 0.25, y: 0.5 }, end: { x: 0.75, y: 0.5 }, realLength: { value: 5, unit: 'm' } },
        W,
        H,
      ),
    ).toBeCloseTo(0.01)
  })

  it('multiplies each axis by its own dimension, so a non-square image is not skewed', () => {
    // Purely vertical: 0.5 of 500px = 250px for 5 m → 0.02 m/px, not 0.01.
    expect(
      metresPerPixel(
        { start: { x: 0.5, y: 0.25 }, end: { x: 0.5, y: 0.75 }, realLength: { value: 5, unit: 'm' } },
        W,
        H,
      ),
    ).toBeCloseTo(0.02)
  })

  it('returns null for a degenerate calibration rather than dividing by zero', () => {
    expect(
      metresPerPixel(
        { start: { x: 0.5, y: 0.5 }, end: { x: 0.5, y: 0.5 }, realLength: { value: 5, unit: 'm' } },
        W,
        H,
      ),
    ).toBeNull()
  })

  it('accepts agreeing calibrations and rejects disagreeing ones', () => {
    expect(calibrationAgreement([0.01, 0.0101])).toBe(true)
    expect(calibrationAgreement([0.01, 0.014])).toBe(false)
  })
})

describe('polygon area', () => {
  it('computes the normalised shoelace area of a rectangle', () => {
    expect(polygonAreaNormalised(rect)).toBeCloseTo(0.16)
  })

  it('is orientation independent, so a clockwise boundary is not negative', () => {
    expect(polygonAreaNormalised([...rect].reverse())).toBeCloseTo(0.16)
  })

  it('scales to square metres through the pixel bridge', () => {
    // 400px × 200px at 0.01 m/px → 4 m × 2 m = 8 m².
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
    // Δ = (300, 200) px → hypot 360.555 px → 3.61 m after rounding.
    expect(segmentLengthMetres({ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.5 }, 0.01, W, H)).toBeCloseTo(3.61, 2)
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

/** Two calibrations describing one drawing may differ by this much before we distrust both. */
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
 * measuring: averaging the two would skew every non-square drawing.
 */
export function metresPerPixel(c: Calibration, imageWidthPx: number, imageHeightPx: number): number | null {
  const px = Math.hypot((c.end.x - c.start.x) * imageWidthPx, (c.end.y - c.start.y) * imageHeightPx)
  if (!Number.isFinite(px) || px <= 0) return null
  const metres = toMetres(c.realLength.value, c.realLength.unit)
  if (!Number.isFinite(metres) || metres <= 0) return null
  return metres / px
}

export function calibrationAgreement(values: number[]): boolean {
  if (values.length < 2) return true
  const min = Math.min(...values)
  const max = Math.max(...values)
  return (max - min) / max <= CALIBRATION_TOLERANCE
}

/** Shoelace, absolute so boundary winding order does not flip the sign. */
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
  const factor = imageWidthPx * imageHeightPx * metresPerPx * metresPerPx
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
  return round2(Math.hypot((b.x - a.x) * imageWidthPx, (b.y - a.y) * imageHeightPx) * metresPerPx)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/modules/rfq_intake/__tests__/geometry.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/rfq_intake/lib/geometry.ts src/modules/rfq_intake/__tests__/geometry.test.ts
git commit -m "feat(rfq_intake): add pure geometry primitives for quantity derivation"
```

### Task 6: Basis → quantity and unit

**Files:**
- Create: `src/modules/rfq_intake/lib/basisResolver.ts`
- Create: `src/modules/rfq_intake/__tests__/fixtures/roomMeasurements.ts`
- Create: `src/modules/rfq_intake/__tests__/basis-resolver.test.ts`

**Interfaces:**
- Consumes: every export of Task 5.
- Produces:

```ts
// `RoomMeasurementsResult` is the V2 `data` object from
// `src/modules/property_documents/room-measurements-contract.ts` (PR #35). Until that
// merges, declare a local structural type of the same shape here and swap it for an
// import afterwards; `workflows.ts:3` already imports across app modules, so the
// cross-module import is an established pattern and no call site changes.
export type Basis = 'floor_area' | 'gross_wall_area' | 'net_wall_area' | 'count' | 'given'
export type QuantityOk = {
  ok: true
  quantity: number
  unit: 'm2' | 'mb' | 'szt' | 'kpl'
  /** Set only when a derived count replaced a model-supplied one. */
  overriddenCount?: number
}
export type QuantityFailure = { ok: false; code: string }
export const BASIS_SPECS: Record<Basis, { acceptedUnits: ReadonlyArray<'m2' | 'mb' | 'szt' | 'kpl'> }>
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

- [ ] **Step 1: Write the fixture**

```ts
// src/modules/rfq_intake/__tests__/fixtures/roomMeasurements.ts
export const drawing = {
  imageWidthPx: 1000,
  imageHeightPx: 500,
  declaredUnit: null,
  declaredScale: null,
  globalCeilingHeight: { value: 2.7, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
  calibrations: [
    {
      id: 'cal-1',
      kind: 'scale_bar',
      start: { x: 0.25, y: 0.5 },
      end: { x: 0.75, y: 0.5 },
      realLength: { value: 5, unit: 'm', method: 'printed', calculationEligibility: 'eligible' },
      calculationEligibility: 'eligible',
    },
  ],
}

export function room(overrides: Record<string, unknown> = {}) {
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

export function measurementResult(rooms: unknown[] = [room()]) {
  return { schemaVersion: '1', analysisStatus: 'complete', drawing, rooms, warnings: [] } as never
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from '@jest/globals'
import { acceptedUnitsFor, resolveQuantity } from '../lib/basisResolver'
import { drawing, measurementResult, room } from './fixtures/roomMeasurements'

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
    expect(resolveQuantity(measurementResult(), { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
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
    expect(resolveQuantity(measurementResult([printed]), { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
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
    expect(resolveQuantity(measurementResult([ambiguous]), { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
      ok: true, quantity: 8, unit: 'm2',
    })
  })

  it('computes gross wall area from length and the global ceiling height', () => {
    // 4 m × 2.7 m = 10.8 m²
    expect(resolveQuantity(measurementResult(), { basis: 'gross_wall_area', roomIds: ['room-1'] })).toEqual({
      ok: true, quantity: 10.8, unit: 'm2',
    })
  })

  it('subtracts openings for net wall area, which is what painting is priced on', () => {
    // 10.8 − (1.5 × 1.2) = 9.0
    expect(resolveQuantity(measurementResult(), { basis: 'net_wall_area', roomIds: ['room-1'] })).toEqual({
      ok: true, quantity: 9, unit: 'm2',
    })
  })

  it('refuses wall area with no height, because a plan view has no vertical axis', () => {
    const noHeight = room({ walls: [{ ...room().walls[0], usesGlobalHeight: false }] })
    const noGlobal = {
      ...(measurementResult([noHeight]) as never as Record<string, unknown>),
      drawing: { ...drawing, globalCeilingHeight: null },
    } as never
    expect(resolveQuantity(noGlobal, { basis: 'gross_wall_area', roomIds: ['room-1'] })).toEqual({
      ok: false, code: 'ceiling_height_missing',
    })
  })

  it('refuses when no calibration exists and the value is not printed', () => {
    const noCal = {
      ...(measurementResult() as never as Record<string, unknown>),
      drawing: { ...drawing, calibrations: [] },
    } as never
    expect(resolveQuantity(noCal, { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
      ok: false, code: 'scale_missing',
    })
  })

  it('refuses a room whose readiness flag is not eligible', () => {
    const blocked = room({
      readiness: { floorArea: 'review_required', grossWallArea: 'eligible', netWallArea: 'eligible' },
      missingInputs: [{ code: 'floor_boundary_incomplete', targetId: 'room-1' }],
    })
    expect(resolveQuantity(measurementResult([blocked]), { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
      ok: false, code: 'floor_boundary_incomplete',
    })
  })

  it('refuses every basis when the image was not a floor plan', () => {
    const notPlan = {
      ...(measurementResult() as never as Record<string, unknown>),
      analysisStatus: 'not_floor_plan',
    } as never
    expect(resolveQuantity(notPlan, { basis: 'floor_area', roomIds: ['room-1'] })).toEqual({
      ok: false, code: 'not_floor_plan',
    })
  })

  it('refuses an unknown room id rather than silently quoting nothing', () => {
    expect(resolveQuantity(measurementResult(), { basis: 'floor_area', roomIds: ['room-9'] })).toEqual({
      ok: false, code: 'room_not_found',
    })
  })

  it('sums the referenced rooms, so one line can cover a whole flat', () => {
    const second = { ...room(), id: 'room-2' }
    expect(
      resolveQuantity(measurementResult([room(), second]), { basis: 'floor_area', roomIds: ['room-1', 'room-2'] }),
    ).toEqual({ ok: true, quantity: 16, unit: 'm2' })
  })

  it('passes a plain count through, because sockets do not appear on a plan view', () => {
    expect(resolveQuantity(measurementResult(), { basis: 'count', count: 7 })).toEqual({
      ok: true, quantity: 7, unit: 'szt',
    })
  })

  it('derives a window count from openings and ignores the number the model supplied', () => {
    expect(
      resolveQuantity(measurementResult(), { basis: 'count', roomIds: ['room-1'], count: 5, derivedFrom: 'window' }),
    ).toEqual({ ok: true, quantity: 1, unit: 'szt', overriddenCount: 5 })
  })

  it('refuses a door count rather than inventing one when the room has no doors', () => {
    expect(
      resolveQuantity(measurementResult(), { basis: 'count', roomIds: ['room-1'], derivedFrom: 'door' }),
    ).toEqual({ ok: false, code: 'no_openings_of_kind' })
  })

  it('passes a given quantity through with its declared unit', () => {
    expect(resolveQuantity(measurementResult(), { basis: 'given', given: { value: 68, unit: 'm2' } })).toEqual({
      ok: true, quantity: 68, unit: 'm2',
    })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn test src/modules/rfq_intake/__tests__/basis-resolver.test.ts`
Expected: FAIL — cannot find module `../lib/basisResolver`.

- [ ] **Step 4: Implement**

Build the module around a table so a reserved basis lands as one row, not a new switch arm:

```ts
export const BASIS_SPECS = {
  floor_area: { acceptedUnits: ['m2'] },
  gross_wall_area: { acceptedUnits: ['m2'] },
  net_wall_area: { acceptedUnits: ['m2'] },
  count: { acceptedUnits: ['szt', 'kpl'] },
  given: { acceptedUnits: ['m2', 'mb', 'szt', 'kpl'] },
} as const
```

`acceptedUnitsFor` reads that table, returning `[givenUnit]` for `given`. `resolveQuantity` then applies, in order:

1. `analysisStatus` outside `{complete, partial}` → `{ ok: false, code: analysisStatus }`.
2. `given` returns its value and unit unchanged; `count` without `derivedFrom` returns the supplied count as `szt`. Neither reads geometry.
3. Every `roomIds` entry must match a `rooms[].id`; a miss → `room_not_found`.
4. The readiness flag for the basis must be `eligible`; otherwise return the first `missingInputs[].code` for that room, defaulting to `floor_boundary_incomplete` for floor bases and `wall_length_missing` for wall bases.
5. `metresPerPixel` is computed for every calibration and `calibrationAgreement` must hold, else `calibration_disagreement`. With no calibration only `printed` values are usable; needing any other → `scale_missing`.
6. `floor_area`: use `printedArea` when non-null, `eligible` and `basis ∈ {gross, net}`, via `toSquareMetres`; otherwise `polygonAreaSquareMetres(outerBoundary, holes.map(h => h.boundary), mpp, w, h)`.
7. `gross_wall_area`: sum `length × height` per wall. `length` is the printed value when present, else `segmentLengthMetres`. Height is the mean of `startHeight`/`endHeight` when both exist, else `drawing.globalCeilingHeight` when `usesGlobalHeight`, else `ceiling_height_missing`.
8. `net_wall_area`: subtract `width × height` for each opening whose `wallId` names a wall of that room, clamped at zero. An opening with a null `wallId` in a referenced room → `opening_wall_ambiguous`, because silently skipping it would over-quote.
9. `count` with `derivedFrom`: tally `openings[]` of that `kind` across the referenced rooms; zero → `no_openings_of_kind`; set `overriddenCount` when a supplied `count` differs from the tally.
10. Any value with `method === 'scale_derived'` is recomputed from `start`/`end` and compared; a relative difference above 2% → `scale_derived_mismatch`.

Sum across `roomIds` and round to two decimals.

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test src/modules/rfq_intake/__tests__/basis-resolver.test.ts && yarn typecheck && yarn lint`
Expected: PASS — 16 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/rfq_intake/lib/basisResolver.ts src/modules/rfq_intake/__tests__/
git commit -m "feat(rfq_intake): resolve quantity and unit from a measurement basis"
```

---

# PR 4 — The priced quote draft

**Deliverable:** the command loads the V2 run, resolves each item to a priced line, and creates one unsent Sales quote. First demoable milestone: a quote appears from a hand-written payload, with no agent involved.

### Task 7: Load the room-measurements run in scope

**Files:**
- Modify: `src/modules/rfq_intake/commands/quote-create.ts`
- Modify: `src/modules/rfq_intake/__tests__/quote-create-command.test.ts`

**Interfaces:**
- Consumes: `AgentRun` from `@open-mercato/enterprise/modules/agent_orchestrator/data/entities`; the fixture from Task 6.
- Produces: `loadRoomMeasurements(em, scope, runId): Promise<RoomMeasurementsResult>` exported from the command module; throws `CrudHttpError(404)` when absent, foreign, or not terminal-ok.

- [ ] **Step 1: Write the failing test**

Extend `makeCtx` so the forked `em.findOne` dispatches on entity name, then:

```ts
it('fails closed when the room-measurements run is not in the derived scope', async () => {
  await expect(createQuoteCommand.execute(validInput, makeCtx({ run: null }))).rejects.toThrow(/run/i)
})

it('rejects a run produced by a different agent, so any AgentRun id will not do', async () => {
  const run = { id: runId, agentId: 'property_documents.pdf_intake', status: 'ok', result: {} }
  await expect(createQuoteCommand.execute(validInput, makeCtx({ run }))).rejects.toThrow(/run/i)
})

it('rejects a run that has not terminated successfully', async () => {
  const run = { id: runId, agentId: 'property_documents.room_measurements', status: 'running', result: null }
  await expect(createQuoteCommand.execute(validInput, makeCtx({ run }))).rejects.toThrow(/run/i)
})

it('accepts the V2 envelope and returns no quote when it contains no rooms', async () => {
  const run = {
    id: runId,
    agentId: 'property_documents.room_measurements',
    status: 'ok',
    result: { kind: 'research', data: measurementResult([]) },
  }
  const result = await createQuoteCommand.execute(validInput, makeCtx({ run }))
  expect(result.quoteId).toBeNull()
})
```

- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement** the scoped `findOne` on `AgentRun` filtered by `id`, `tenantId`, `organizationId`, `agentId === 'property_documents.room_measurements'` and a terminal `ok` status, then strict-parse `result.data`.
- [ ] **Step 4: Run the file's tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(rfq_intake): load the scoped room-measurements result`.

### Task 8: Item loop, unit gate and the Sales call

**Files:**
- Modify: `src/modules/rfq_intake/commands/quote-create.ts`
- Modify: `src/modules/rfq_intake/__tests__/quote-create-command.test.ts`

**Interfaces:**
- Consumes: `loadQuotableProduct`, `resolveUnitPrice` (Task 4), `resolveQuantity`, `acceptedUnitsFor` (Task 6), `runCommand` from `../lib/commandBus`.
- Produces: `QuoteCreateResult` carrying a real `quoteId`.

**Order of operations per item, then aggregation before pricing:**

`loadQuotableProduct` → `resolveQuantity` → unit gate → **group** → `resolveUnitPrice` once per group.

Items are aggregated by `(productId, variantId)` **before** any price is resolved. This is not cosmetic: `resolvePrice(rows, { quantity })` is quantity-dependent, and `catalog_product_variant_prices` carries `minQuantity` tiers, so quoting 8 m² and 12 m² as two lines can land in a different tier than 20 m² as one. The customer is buying twenty metres of painting, not eight and twelve.

It is inert against today's seed — `catalog_seed` writes exactly one price row per variant at `MIN_QUANTITY = 1`, so there is only one tier — which is a fact about the seeded data, not about the contract. The first real price list with tiers would otherwise change a quote silently.

Grouping rules:

- Key is `(productId, variantId)` after `loadQuotableProduct` has resolved the variant, so an item that named no variant groups with one that named the default explicitly.
- Quantities are summed and re-rounded to two decimals. Units cannot disagree inside a group, because the unit gate already forced every member to match the product's `defaultUnit`.
- `note` values are joined with `, ` into the line `description`, so the per-room breakdown survives as text rather than as separate lines.
- An item dropped by any gate never reaches a group. A group whose members were all dropped produces no line.
- Warnings keep the **original** `itemIndex`, not the group index — the operator has to find the item they wrote.

- [ ] **Step 1: Write the failing tests**

```ts
it('drops an item whose basis unit does not match the product, instead of coercing it', async () => {
  // REN-CAR-01 bills in `szt`; a floor_area basis yields m2.
  const result = await createQuoteCommand.execute(doorWithFloorAreaInput, makeCtx())
  expect(result.quoteId).toBeNull()
  expect(result.warnings).toContain(`unit_mismatch:${doorProductId}`)
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
  expect(salesCalls[0].input.metadata).toEqual({
    rfqDealId: dealId, roomMeasurementsRunId: runId, source: 'rfq_intake',
  })
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

it('merges two items naming the same product and variant into one summed line', async () => {
  // Painting the salon (8 m²) and the kitchen (12 m²) is twenty metres of one service,
  // not two purchases. Pricing sees 20 so a quantity tier resolves against the real total.
  const result = await createQuoteCommand.execute(paintingTwoRoomsInput, makeCtx())
  expect(salesCalls[0].input.lines).toHaveLength(1)
  expect(salesCalls[0].input.lines[0]).toMatchObject({ productId: paintProductId, quantity: 20 })
  expect(pricingCalls.map((c) => c.quantity)).toEqual([20])
  expect(result.lineCount).toBe(1)
})

it('keeps the per-room notes of merged items in the line description', async () => {
  await createQuoteCommand.execute(paintingTwoRoomsInput, makeCtx())
  expect(salesCalls[0].input.lines[0].description).toBe('salon, kuchnia')
})

it('keeps different variants of one product on separate lines, since they are priced apart', async () => {
  // REN-FIN-01 standard at 40 and premium at 65 are different purchases.
  const result = await createQuoteCommand.execute(paintingTwoVariantsInput, makeCtx())
  expect(salesCalls[0].input.lines).toHaveLength(2)
  expect(result.lineCount).toBe(2)
})

it('groups an item that named no variant with one that named the default explicitly', async () => {
  // loadQuotableProduct resolves the default first, so both reach the same group key.
  await createQuoteCommand.execute(implicitAndExplicitDefaultVariantInput, makeCtx())
  expect(salesCalls[0].input.lines).toHaveLength(1)
})

it('reports a dropped item against the index the operator wrote, not the group index', async () => {
  const result = await createQuoteCommand.execute(secondItemUnpriceableInput, makeCtx())
  expect(result.warnings).toContain('no_price:1')
})
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the loop and the grouping. Per item: `loadQuotableProduct`, then `resolveQuantity`, then the unit gate (`acceptedUnitsFor(basis)` against the product's `defaultUnit`), dropping with a bounded warning carrying the original `itemIndex` on any failure. Then group the survivors by `(productId, variantId)`, summing quantities and joining `note` values with `, `. Call `resolveUnitPrice` **once per group** with the summed quantity, so a `minQuantity` tier resolves against the real total. Pick the majority currency and drop outliers. With at least one surviving line, call `runCommand(ctx, 'sales.quotes.create', { tenantId, organizationId, currencyCode, metadata, lines })`. Resolve `customerEntityId` from the deal's single linked company (`customer_deal_companies`), else its primary person (`customer_deal_people` where `is_primary`), omitting the field when neither exists.
- [ ] **Step 4: Run the module suite and the gate.**

Run: `yarn test src/modules/rfq_intake/__tests__/ && yarn generate && yarn typecheck && yarn lint`
Expected: the 5 pre-existing failures and nothing more.

- [ ] **Step 5: Commit** — `feat(rfq_intake): create a priced unsent sales quote from mapped items`.

---

# PR 5 — The invocation path and the probe agent

**Deliverable:** an agent proposal reaches the command through `executeProposal`, proving all five gates. Needs PR #35 merged.

### Task 9: The apply-proposal bridge

**Files:**
- Create: `src/modules/rfq_intake/commands/apply-proposal.ts`
- Create: `src/modules/rfq_intake/__tests__/apply-proposal-command.test.ts`

**Interfaces:**
- Consumes: `executeProposal` from `@open-mercato/enterprise/modules/agent_orchestrator`; `AgentProposal` from its `data/entities`.
- Produces: command `rfq_intake.quote.apply_proposal` taking `{ workflowInstanceId, agentId }`, returning `{ applied: number; skipped: string[]; errors: string[] }`.

- [ ] **Step 1: Write the failing tests** — a disposed proposal whose `selectedOptionId` names an option runs its actions; a `skipped` result is surfaced rather than swallowed; a proposal from another tenant is not found.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement**: load the scoped `AgentProposal` by `workflowInstanceId` + `agentId`, read `selectedOptionId`, pick that option from `payload.options`, then:

```ts
const results = await executeProposal(option.actions, {
  commandBus: ctx.container.resolve('commandBus'),
  commandCtx: ctx,
  // Gate 4: without this entry every action returns `skipped: no command mapped`.
  actionCommandMap: { 'rfq.quote.create': 'rfq_intake.quote.create' },
  allowedActions: ['rfq_intake.quote.create'],
})
```

Every result whose `status` is not `ok` becomes a visible warning — a silent `skipped` is exactly how the enablement gates fail.

- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(rfq_intake): bridge disposed proposals to the quote command`.

### Task 10: The temporary probe agent and the workflow step

**Files:**
- Create: `src/modules/rfq_intake/ai-agents.ts` — the module has no such file today
- Create: `src/modules/rfq_intake/__tests__/quote-probe-agent.test.ts`
- Modify: `src/modules/rfq_intake/workflows.ts`

**The graph on `main` is `start → extract_pdf → match_catalog → end`.** Insert one step between `match_catalog` and `end`: add the step, repoint transition `t_done` to it, and add a new transition from it to `end`. Do not rename `RFQ_ANALYSIS_WORKFLOW_ID` — every existing `process_definitions` row points at it, and changing it would silently start nothing.

- [ ] **Step 1: Write the failing test** — the probe is registered with `allowedActions: ['rfq_intake.quote.create']` (gate 3) and emits exactly one option carrying one action of type `rfq.quote.create`; and `rfq_intake.quote.apply_proposal` is declared workflow-safe.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement** the probe behind the same enterprise flags as the rest of the module, carrying:

```ts
// HACK(hackathon): temporary probe. It exists only to exercise the five gates and the
// executeProposal path before the real mapping agent lands. It forwards the payload it
// is handed and maps nothing — a probe that also guessed could not tell you whether a
// failure came from the plumbing or from the guess. Its auto-approve threshold is a
// TEST-ONLY setting; on a real agent that field is a safety boundary.
// Remove this agent in the slice that introduces the mapping agent.
```

- [ ] **Step 4: Run the gate.** `yarn generate && yarn typecheck && yarn lint && yarn test src/modules/rfq_intake/__tests__/`
- [ ] **Step 5: Commit** — `feat(rfq_intake): add a temporary probe agent for the proposal path`.

### Task 11: Prove the five gates end to end

- [ ] **Step 1:** `rfq_intake.quote.create` appears in `listWorkflowSafeCommands()` (gate 1).
- [ ] **Step 2:** the demo tenant has it enabled in workflow-command settings (gate 2).
- [ ] **Step 3:** the probe's `allowedActions` admits it (gate 3).
- [ ] **Step 4:** `actionCommandMap` resolves the action type (gate 4).
- [ ] **Step 5:** the vocabulary loads — a missing `workflows` peer blocks every effect (gate 5).
- [ ] **Step 6:** run one RFQ through and record the quote id in the PR description. If any result is `skipped`, name the gate that produced it rather than retrying blindly.

---

## Execution Notes

- PR 3 needs neither the database nor PR #35: `geometry.ts` depends on nothing and `basisResolver.ts` only on the V2 *shape*. It is the safest task to parallelise.
- After PR 4 the feature demos without an agent. If time runs short, PR 5 is the part to cut.
- Nothing here applies a migration, and there is no schema change to generate.
- Treat any instruction that contradicts the Verified Baseline as stale, and re-verify against `origin/main` before following it.

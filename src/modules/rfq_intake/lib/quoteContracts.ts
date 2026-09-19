/**
 * The seam between the three units that build an RFQ quote line.
 *
 * Types only, no behaviour beyond one guard and one formatter, so the catalog/pricing
 * unit and the geometry/quantity unit can be written independently without either
 * owning the other's vocabulary. Nothing here imports from a command.
 *
 * The three producers:
 *   `lib/catalogPricing.ts`  → QuotableProduct, UnitPrice
 *   `lib/basisResolver.ts`   → Quantity
 *   `commands/quote-create.ts` → assembles them into Sales lines
 */

/** Every unit the seeded renovation catalog bills in (`catalog_seed/data/renovation-catalog.ts:51`). */
export const QUOTE_UNITS = ['m2', 'mb', 'szt', 'kpl'] as const
export type QuoteUnit = (typeof QUOTE_UNITS)[number]

/**
 * A Catalog `defaultUnit` is a free-text column, so it is narrowed once here rather
 * than by each consumer guessing. A product whose unit is not one of ours cannot be
 * quoted at all — better to see that as a typed refusal than as a silent coercion.
 */
export function isQuoteUnit(value: unknown): value is QuoteUnit {
  return typeof value === 'string' && (QUOTE_UNITS as readonly string[]).includes(value)
}

/**
 * One outcome shape for every resolver. Two conventions for the same thing — a bare
 * union on one side and an `{ ok }` discriminant on the other — is how call sites end
 * up handling only one of them.
 */
export type Resolved<T, C extends string> = { ok: true; value: T } | { ok: false; code: C }

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })
export const fail = <C extends string>(code: C): { ok: false; code: C } => ({ ok: false, code })

/* ------------------------------------------------------------------ *
 * Catalog and pricing
 * ------------------------------------------------------------------ */

/**
 * Product identity and the facts needed for the unit gate — deliberately separate from
 * pricing, so an item whose unit does not match its basis is refused BEFORE anything
 * touches the price tables.
 */
export type QuotableProduct = {
  productId: string
  /** Always resolved: the supplied variant, or the product's `isDefault` one. */
  variantId: string
  title: string
  /** Narrowed on the way out, so a success never carries an unusable unit. */
  defaultUnit: QuoteUnit
  /**
   * Tax identity lives on the variant (`catalog_product_variants.tax_rate_id`) or the
   * product (`catalog_products.tax_rate_id`) — NOT on the price row, which has no such
   * column. Variant wins when both are set.
   */
  taxRateId: string | null
}

export type ProductFailureCode =
  | 'product_not_found'
  | 'variant_not_found'
  /** The supplied variant belongs to a different product. Never substituted. */
  | 'variant_foreign'
  /** The variant exists but is not active, so it must not be sold. */
  | 'variant_inactive'
  /** The product's `defaultUnit` is absent or outside `QUOTE_UNITS`. */
  | 'unit_unsupported'

/**
 * Prices live on the VARIANT: `catalog_seed` writes every row through
 * `catalog.prices.create` with a `variantId` into `catalog_product_variant_prices`.
 *
 * The row carries a numeric `tax_rate` and **no `tax_rate_id`** — `catalog.prices.create`
 * feeds its input `taxRateId` to `taxCalculationService` and persists only the derived
 * rate. So the authoritative tax figure here is the rate that actually produced
 * `unitPriceGross`; the identity, when one is needed, comes from `QuotableProduct`.
 */
export type UnitPrice = {
  currencyCode: string
  /** Numeric strings, as MikroORM returns `numeric`. Never parsed to a float. */
  unitPriceGross: string
  /** Percentage as a numeric string, e.g. `'8.0000'`. Null when the row carries none. */
  taxRate: string | null
  priceId: string
}

export type PriceFailureCode =
  | 'no_price'
  /** The resolver returned a row for another variant; a pricing extension may adjust
   *  an amount for the same identity, never swap the identity. */
  | 'price_identity_mismatch'

/* ------------------------------------------------------------------ *
 * Geometry and quantity
 * ------------------------------------------------------------------ */

export type Basis = 'floor_area' | 'gross_wall_area' | 'net_wall_area' | 'count' | 'given'

export type Quantity = {
  /** Rounded to two decimals, always positive. */
  quantity: number
  unit: QuoteUnit
  /** Set only when a derived door/window count replaced a model-supplied one. */
  overriddenCount?: number
}

/**
 * The first eight mirror `missingInputs[].code` in the V2 room-measurements contract,
 * so a warning on a quote cites the measuring agent's own vocabulary instead of one we
 * invented. The rest are ours.
 */
export type QuantityFailureCode =
  | 'scale_missing'
  | 'floor_boundary_incomplete'
  | 'ceiling_height_missing'
  | 'height_scope_ambiguous'
  | 'wall_length_missing'
  | 'opening_width_missing'
  | 'opening_height_missing'
  | 'opening_wall_ambiguous'
  | 'not_floor_plan'
  | 'unreadable'
  | 'room_not_found'
  | 'calibration_disagreement'
  | 'scale_derived_mismatch'
  | 'no_openings_of_kind'
  | 'non_positive_quantity'

/* ------------------------------------------------------------------ *
 * Room measurements — structural mirror of the V2 contract
 * ------------------------------------------------------------------ */

/**
 * Mirrors the `data` object of `property_documents.room_measurements` as added by
 * PR #35 (`src/modules/property_documents/room-measurements-contract.ts`). Declared
 * structurally so this work does not block on that merge; once it lands, replace these
 * declarations with an import from that module and no call site changes.
 *
 * Only the fields this feature reads are modelled. Coordinates are normalised to the
 * IMAGE, in `[0,1]`, so recovering pixels means multiplying x by width and y by height.
 */
export type NormalisedPoint = { x: number; y: number }

export type LinearUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft'
export type AreaUnit = 'mm2' | 'cm2' | 'm2' | 'in2' | 'ft2'

export type CalculationEligibility = 'eligible' | 'review_required'
export type MeasurementMethod = 'printed' | 'scale_derived'

export type LinearMeasurement = {
  value: number
  unit: LinearUnit
  method: MeasurementMethod
  calculationEligibility: CalculationEligibility
  calibrationId?: string | null
}

export type AreaMeasurement = {
  value: number
  unit: AreaUnit
  /** `unknown` means the drawing did not say gross or net; it is not usable. */
  basis: 'gross' | 'net' | 'unknown'
  method: 'printed'
  calculationEligibility: CalculationEligibility
}

export type DrawingCalibration = {
  id: string
  kind: 'scale_bar' | 'dimension_anchor'
  start: NormalisedPoint
  end: NormalisedPoint
  realLength: LinearMeasurement
  calculationEligibility: CalculationEligibility
}

export type Drawing = {
  imageWidthPx: number
  imageHeightPx: number
  /** Carries no numeric ratio, so it is context only and never usable arithmetic. */
  declaredScale: unknown | null
  globalCeilingHeight: LinearMeasurement | null
  calibrations: DrawingCalibration[]
}

export type RoomWall = {
  id: string
  start: NormalisedPoint
  end: NormalisedPoint
  length: LinearMeasurement | null
  heightProfile: 'constant' | 'sloped' | 'unknown'
  startHeight: LinearMeasurement | null
  endHeight: LinearMeasurement | null
  usesGlobalHeight: boolean
  calculationEligibility: CalculationEligibility
}

export type RoomOpening = {
  id: string
  kind: 'door' | 'window' | 'opening' | 'unknown'
  /** Null means the opening could not be attached to a wall — see `opening_wall_ambiguous`. */
  wallId: string | null
  width: LinearMeasurement | null
  height: LinearMeasurement | null
  calculationEligibility: CalculationEligibility
}

export type RoomFloor = {
  outerBoundary: NormalisedPoint[]
  holes: Array<{ id: string; boundary: NormalisedPoint[] }>
  printedArea: AreaMeasurement | null
  calculationEligibility: CalculationEligibility
}

export type MeasuredRoom = {
  id: string
  printedName: string | null
  location: string
  floor: RoomFloor
  walls: RoomWall[]
  openings: RoomOpening[]
  readiness: {
    floorArea: CalculationEligibility
    grossWallArea: CalculationEligibility
    netWallArea: CalculationEligibility
  }
  missingInputs: Array<{ code: string; targetId: string | null }>
}

export type RoomMeasurementsResult = {
  schemaVersion: '1'
  analysisStatus: 'complete' | 'partial' | 'not_floor_plan' | 'unreadable'
  drawing: Drawing
  rooms: MeasuredRoom[]
  warnings: string[]
}

/* ------------------------------------------------------------------ *
 * Warnings
 * ------------------------------------------------------------------ */

/**
 * `itemIndex` rather than the product id alone: two items may name the same product
 * with different bases, and the operator needs to know which one was dropped.
 */
export type ItemWarning = {
  itemIndex: number
  catalogProductId: string
  code: ProductFailureCode | PriceFailureCode | QuantityFailureCode | 'unit_mismatch' | 'currency_unsupported'
}

export function formatWarning(warning: ItemWarning): string {
  return `${warning.code}:${warning.itemIndex}`
}

import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CustomerDeal,
  CustomerDealCompanyLink,
  CustomerDealPersonLink,
} from '@open-mercato/core/modules/customers/data/entities'
import { resolveStatusEntryIdByValue } from '@open-mercato/core/modules/sales/lib/statusHelpers'
import { AgentRun } from '@open-mercato/enterprise/modules/agent_orchestrator/data/entities'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { z } from 'zod'

import { resolveQuantity } from '../lib/basisResolver'
import { loadQuotableProduct, resolveUnitPrice } from '../lib/catalogPricing'
import { runCommand } from '../lib/commandBus'
import { roundToTwo } from '../lib/geometry'
import type { QuotableProduct, Quantity, RoomMeasurementsResult } from '../lib/quoteContracts'

/**
 * The status a machine-made quote starts in. `draft` is Sales' own vocabulary, not ours:
 * `sales.quotes.update` writes exactly this value when an edit invalidates a sent quote,
 * and `sales/api/quotes/send` replaces it with `sent`. Setting it here only supplies the
 * starting point of a cycle Sales already owns.
 */
export const QUOTE_DRAFT_STATUS = 'draft'

/** Quotes are issued in złoty; the seeded catalog prices in nothing else. */
export const QUOTE_CURRENCY = 'PLN'

/** The only agent whose run may be quoted from. */
export const ROOM_MEASUREMENTS_AGENT_ID = 'property_documents.room_measurements'

/** Fields every item carries, whatever its basis. */
const itemCommon = {
  catalogProductId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  note: z.string().max(1000).optional(),
}

const roomIds = z.array(z.string().min(1).max(200)).min(1).max(200)

/**
 * Discriminated on `basis`, which is the single word the agent was already choosing —
 * so the union costs the model no extra decision, while `roomIds` becomes REQUIRED
 * where it means something instead of an optional that silently does nothing.
 *
 * This is also the extension point. A future work type — `floor_perimeter`,
 * `opening_perimeter`, `wall_run_length`, `same_as` — arrives as one more member
 * carrying its own fields, rather than as another `field?` most bases would ignore.
 * None of those is implemented; see the spec's reserved-bases table.
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

/**
 * Non-strict on purpose: unknown keys are STRIPPED rather than rejected. This payload
 * is authored by a language model and may well carry `tenantId`/`organizationId`;
 * stripping them is what makes it impossible to write into another tenant's scope by
 * asking nicely. Same reasoning as `deal_links/commands/document-links.ts`.
 */
export const quoteCreateInputSchema = z.object({
  dealId: z.string().uuid(),
  roomMeasurementsRunId: z.string().uuid(),
  items: z.array(quoteItemSchema).min(1).max(100),
})

export type QuoteCreateInput = z.infer<typeof quoteCreateInputSchema>
export type QuoteItemInput = z.infer<typeof quoteItemSchema>
export type QuoteCreateResult = { quoteId: string | null; lineCount: number; warnings: string[] }

/**
 * Validates the envelope of a V2 room-measurements result, not its whole depth.
 *
 * The interior is already validated server-side before the agent may submit it, and
 * re-stating several hundred lines of that schema here would be a second source of
 * truth to keep in sync. What this must catch is the shape that would make the
 * arithmetic throw rather than refuse: absent image dimensions, a non-array of rooms
 * or calibrations. Anything deeper is the resolver's business, and it fails closed
 * with a typed code.
 */
const roomMeasurementsResultSchema = z
  .object({
    schemaVersion: z.literal('1'),
    analysisStatus: z.enum(['complete', 'partial', 'not_floor_plan', 'unreadable']),
    drawing: z
      .object({
        imageWidthPx: z.number().positive(),
        imageHeightPx: z.number().positive(),
        calibrations: z.array(z.unknown()),
      })
      .loose(),
    rooms: z.array(z.unknown()),
    warnings: z.array(z.string()),
  })
  .loose()

/**
 * Reads the measurement result a quote will be derived from.
 *
 * `runId` arrives in a model-authored payload, so every field is re-checked on the row
 * that came back rather than trusted to the query — the same belt-and-braces stance as
 * `commands/analysis.ts`. The `agentId` check is the load-bearing one: without it a
 * `pdf_intake` run would be accepted and geometry read from something that never
 * contained any.
 */
export async function loadRoomMeasurements(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  runId: string,
): Promise<RoomMeasurementsResult> {
  const run = await em.findOne(AgentRun, {
    id: runId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    agentId: ROOM_MEASUREMENTS_AGENT_ID,
    deletedAt: null,
  })

  if (
    !run ||
    run.tenantId !== scope.tenantId ||
    run.organizationId !== scope.organizationId ||
    run.agentId !== ROOM_MEASUREMENTS_AGENT_ID ||
    run.deletedAt != null ||
    run.status !== 'ok' ||
    run.resultKind !== 'research'
  ) {
    throw new CrudHttpError(404, { error: 'Room measurements run is unavailable' })
  }

  const parsed = roomMeasurementsResultSchema.safeParse(run.output)
  if (!parsed.success) {
    throw new CrudHttpError(422, { error: 'Room measurements run carries an unusable result' })
  }

  return parsed.data as unknown as RoomMeasurementsResult
}

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

    // `dealId` arrives from a model and is untrusted: the deal is proven by reading it
    // back inside the derived scope, never by believing the payload. Same stance as
    // `inbox-actions.ts`, which calls the owner's command instead of touching
    // `customer_deals` directly.
    const deal = await em.findOne(CustomerDeal, { id: input.dealId, ...scope, deletedAt: null })
    if (!deal) throw new CrudHttpError(404, { error: 'Deal not found' })

    // Loaded before any item is considered: an unusable run is a failure of the whole
    // request, not of one line, so it aborts rather than producing warnings.
    const measurements = await loadRoomMeasurements(em, scope, input.roomMeasurementsRunId)

    const warnings: string[] = []
    const resolved: ResolvedItem[] = []

    // Pass one: identity, quantity and the unit gate. Every refusal drops one item and
    // lets the rest through, because a single bad mapping should not cost the operator
    // the whole quote.
    for (const [index, item] of input.items.entries()) {
      const product = await loadQuotableProduct(em, scope, {
        productId: item.catalogProductId,
        ...(item.variantId ? { variantId: item.variantId } : {}),
      })
      if (!product.ok) {
        warnings.push(`${product.code}:${index}`)
        continue
      }

      const quantity = resolveQuantity(measurements, {
        basis: item.basis,
        ...('roomIds' in item ? { roomIds: item.roomIds } : {}),
        ...('count' in item ? { count: item.count } : {}),
        ...('given' in item ? { given: item.given } : {}),
      })
      if (!quantity.ok) {
        warnings.push(`${quantity.code}:${index}`)
        continue
      }

      // The gate the whole design exists for: a basis that produced m² cannot bill a
      // product sold by the piece. Checked before pricing, so a wrong mapping never
      // reaches the price tables.
      if (quantity.value.unit !== product.value.defaultUnit) {
        warnings.push(`unit_mismatch:${index}`)
        continue
      }

      resolved.push({ index, product: product.value, quantity: quantity.value, note: item.note })
    }

    // Pass two: group before pricing. `resolvePrice` is quantity-dependent and Catalog
    // prices carry `minQuantity` tiers, so two items naming one product must be priced
    // on their sum — the customer is buying twenty metres, not eight and twelve.
    const groups = new Map<string, ItemGroup>()
    for (const entry of resolved) {
      const key = `${entry.product.productId}:${entry.product.variantId}`
      const existing = groups.get(key)
      if (existing) {
        existing.quantity = roundToTwo(existing.quantity + entry.quantity.quantity)
        existing.indices.push(entry.index)
        if (entry.note) existing.notes.push(entry.note)
      } else {
        groups.set(key, {
          product: entry.product,
          unit: entry.quantity.unit,
          quantity: entry.quantity.quantity,
          indices: [entry.index],
          notes: entry.note ? [entry.note] : [],
        })
      }
    }

    // Pass three: one price per group, at the summed quantity.
    const priced: PricedGroup[] = []
    for (const group of groups.values()) {
      const price = await resolveUnitPrice(em, ctx.container, scope, {
        productId: group.product.productId,
        variantId: group.product.variantId,
        quantity: group.quantity,
      })
      if (!price.ok) {
        for (const index of group.indices) warnings.push(`${price.code}:${index}`)
        continue
      }
      priced.push({ group, price: price.value })
    }

    // One currency, fixed. The seeded catalog prices in złoty and the renovation
    // business is domestic, so a line priced in anything else is a catalog mistake to
    // surface rather than a rate to convert. Refusing it by name beats a majority vote,
    // which would silently drop whichever side happened to be outnumbered.
    const kept: PricedGroup[] = []
    for (const entry of priced) {
      if (entry.price.currencyCode === QUOTE_CURRENCY) kept.push(entry)
      else for (const index of entry.group.indices) warnings.push(`currency_unsupported:${index}`)
    }

    if (kept.length === 0) {
      return { quoteId: null, lineCount: 0, warnings }
    }

    const lines = kept.map(({ group, price }) => ({
      kind: 'service' as const,
      productId: group.product.productId,
      productVariantId: group.product.variantId,
      name: group.product.title,
      ...(group.notes.length ? { description: group.notes.join(', ').slice(0, 4000) } : {}),
      quantity: group.quantity,
      quantityUnit: group.unit,
      currencyCode: price.currencyCode,
      unitPriceGross: price.unitPriceGross,
      // The rate that produced the gross amount. `taxRateId` is a catalog fact and is
      // only attached when the product side actually names one.
      ...(price.taxRate ? { taxRate: price.taxRate } : {}),
      ...(group.product.taxRateId ? { taxRateId: group.product.taxRateId } : {}),
      priceMode: 'gross' as const,
    }))

    const customerEntityId = await resolveQuoteCustomer(em, input.dealId)

    // Resolved through the same helper the send route uses, so both ends of the cycle
    // agree on which entry `draft` means. It returns null when the `sales.order_status`
    // dictionary or the entry is absent — an organisation that never ran
    // `mercato sales seed-statuses` gets a quote with no status label rather than a
    // failed request. Unsent remains the readiness signal either way.
    const statusEntryId = await resolveStatusEntryIdByValue(em, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      value: QUOTE_DRAFT_STATUS,
    })

    const created = await runCommand<Record<string, unknown>, { quoteId?: string }>(
      ctx,
      'sales.quotes.create',
      {
        ...scope,
        currencyCode: QUOTE_CURRENCY,
        ...(statusEntryId ? { statusEntryId } : {}),
        ...(customerEntityId ? { customerEntityId } : {}),
        metadata: {
          rfqDealId: input.dealId,
          roomMeasurementsRunId: input.roomMeasurementsRunId,
          source: 'rfq_intake',
        },
        lines,
      },
    )

    return { quoteId: created?.quoteId ?? null, lineCount: lines.length, warnings }
  },
}

type ResolvedItem = { index: number; product: QuotableProduct; quantity: Quantity; note?: string }
type ItemGroup = {
  product: QuotableProduct
  unit: Quantity['unit']
  quantity: number
  indices: number[]
  notes: string[]
}
type PricedGroup = { group: ItemGroup; price: { currencyCode: string; unitPriceGross: string; taxRate: string | null } }

/**
 * A renovation quote is addressed to the company when the deal names one, and to its
 * primary contact otherwise. Neither link table carries its own scope — both hang off
 * the deal, which was already proven in scope above.
 */
async function resolveQuoteCustomer(em: EntityManager, dealId: string): Promise<string | null> {
  const company = await em.findOne(CustomerDealCompanyLink, { deal: dealId })
  if (company?.company) return typeof company.company === 'string' ? company.company : company.company.id

  const person = await em.findOne(CustomerDealPersonLink, { deal: dealId, isPrimary: true })
  if (person?.person) return typeof person.person === 'string' ? person.person : person.person.id

  return null
}

registerCommand(createQuoteCommand)

export { createQuoteCommand }

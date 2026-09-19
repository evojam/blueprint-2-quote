import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerDeal } from '@open-mercato/core/modules/customers/data/entities'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { z } from 'zod'

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

    // HACK(hackathon): plumbing only. PR 4 of the plan replaces this with resolved
    // quantities, prices and the `sales.quotes.create` call. What breaks until then:
    // the command validates and authorises everything but never produces a quote.
    return { quoteId: null, lineCount: 0, warnings: ['quote_creation_not_implemented'] }
  },
}

registerCommand(createQuoteCommand)

export { createQuoteCommand }

import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const resolveCaseId = jest.fn<(...args: any[]) => Promise<any>>()

jest.mock('../lib/quoteCase', () => ({
  resolveCaseId: (...args: any[]) => resolveCaseId(...args),
}))

import { interceptors, shouldCloseAsWon } from '../commands/interceptors'

/**
 * Spec: `.ai/specs/2026-09-20-quote-accepted-closes-case.md`.
 */
describe('shouldCloseAsWon', () => {
  it('closes an open case', () => {
    expect(shouldCloseAsWon({ status: 'open' })).toBe(true)
  })

  it.each(['win', 'won'])('does not write again over an already-won case (%s)', (status) => {
    // Converting the same quote twice must not stack a second transition onto the deal's
    // history. `win` is what the UI closure flow persists, `won` what the AI stage tool does.
    expect(shouldCloseAsWon({ status })).toBe(false)
  })

  /**
   * The deliberate asymmetry with the send-side guard, which refuses to touch a closed
   * case. There, nothing new had happened — a quote was merely re-sent. Here the customer
   * signed, which outranks whoever marked the enquiry lost earlier.
   */
  it.each(['lost', 'loose'])('closes a case previously marked %s', (status) => {
    expect(shouldCloseAsWon({ status })).toBe(true)
  })

  it('does nothing without a case', () => {
    expect(shouldCloseAsWon(null)).toBe(false)
  })
})

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const dealId = '33333333-3333-4333-8333-333333333333'
const quoteId = '44444444-4444-4444-8444-444444444444'

const interceptor = interceptors[0]!

type Rows = { quote?: Record<string, unknown> | null; deal?: Record<string, unknown> | null }

function makeCtx(rows: Rows, auth: Record<string, unknown> | null = null) {
  const calls: Array<{ id: string; input: any; auth: unknown }> = []
  const findOne = async (entity: unknown, where: Record<string, unknown>) => {
    // Two lookups share this fork: the quote (scope derivation) and the deal.
    if ('documentKind' in where || 'acceptanceToken' in where) return null
    return 'organizationId' in where && !('deletedAt' in where) ? rows.quote ?? null : null
  }
  const ctx = {
    commandId: 'sales.quotes.convert_to_order',
    auth,
    selectedOrganizationId: organizationId,
    container: {
      resolve(name: string) {
        if (name === 'em') {
          return {
            fork: () => ({
              findOne: async (_entity: unknown, where: Record<string, unknown>) => {
                if (where.documentKind === 'quote') return null
                if (where.id === quoteId) return rows.quote ?? null
                if (where.id === dealId) return rows.deal ?? null
                return findOne(_entity, where)
              },
            }),
          }
        }
        if (name === 'commandBus') {
          return {
            execute: async (id: string, options: any) => {
              calls.push({ id, input: options.input, auth: options.ctx?.auth ?? null })
              return { result: { id: dealId }, logEntry: null }
            },
          }
        }
        throw new Error(`unexpected resolve ${name}`)
      },
    },
  }
  return { ctx: ctx as never, calls }
}

describe('rfq_intake.close-case-on-conversion', () => {
  beforeEach(() => {
    resolveCaseId.mockReset()
  })

  it('targets the conversion command', () => {
    expect(interceptor.id).toBe('rfq_intake.close-case-on-conversion')
    expect(interceptor.targetCommand).toBe('sales.quotes.convert_to_order')
  })

  /**
   * The discriminating assertion of this whole file: `status: 'win'` and NO
   * `pipelineStageId`. `customers/commands/deals.ts` only resolves the terminal stage
   * when `pipelineStageId === undefined`, so sending one — which `rfq_intake.deal.advance`
   * does — would leave a deal reading `Closed Won` on the board while its `status` stayed
   * `open` and `closureOutcome` stayed null.
   */
  it('closes the case through deals.update with a status and no stage id', async () => {
    resolveCaseId.mockResolvedValue({ dealId, currencyCode: 'PLN' })
    const { ctx, calls } = makeCtx({
      quote: { id: quoteId, tenantId, organizationId },
      deal: { id: dealId, status: 'open' },
    })

    await interceptor.afterExecute!({ quoteId }, { orderId: 'order-1' }, ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toBe('customers.deals.update')
    expect(calls[0]!.input).toEqual({ tenantId, organizationId, id: dealId, status: 'win' })
    expect(calls[0]!.input).not.toHaveProperty('pipelineStageId')
  })

  /**
   * The public acceptance path builds its command context with `auth: null`
   * (`sales/api/quotes/accept/route.ts:128-136`) and carries no `tenantId` at all. Reading
   * the tenant off `ctx.auth` — as `deal_links`' interceptor on this same command does —
   * makes the hook silently do nothing exactly when a customer signs. The tenant has to
   * come from the quote row instead.
   */
  it('works when the customer accepted, with no auth on the context', async () => {
    resolveCaseId.mockResolvedValue({ dealId, currencyCode: 'PLN' })
    const { ctx, calls } = makeCtx({
      quote: { id: quoteId, tenantId, organizationId },
      deal: { id: dealId, status: 'open' },
    })

    await interceptor.afterExecute!({ quoteId }, { orderId: 'order-1' }, ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.auth).toBeNull()
    expect(calls[0]!.input).toMatchObject({ tenantId })
  })

  it('leaves a quote that answers no case alone', async () => {
    resolveCaseId.mockResolvedValue(null)
    const { ctx, calls } = makeCtx({ quote: { id: quoteId, tenantId, organizationId } })

    await interceptor.afterExecute!({ quoteId }, { orderId: 'order-1' }, ctx)

    expect(calls).toEqual([])
  })

  it('does not write again over a case already closed as won', async () => {
    resolveCaseId.mockResolvedValue({ dealId, currencyCode: 'PLN' })
    const { ctx, calls } = makeCtx({
      quote: { id: quoteId, tenantId, organizationId },
      deal: { id: dealId, status: 'win' },
    })

    await interceptor.afterExecute!({ quoteId }, { orderId: 'order-1' }, ctx)

    expect(calls).toEqual([])
  })

  it('fails closed when the quote is not visible in the context organization', async () => {
    resolveCaseId.mockResolvedValue({ dealId, currencyCode: 'PLN' })
    const { ctx, calls } = makeCtx({ quote: null })

    await interceptor.afterExecute!({ quoteId }, { orderId: 'order-1' }, ctx)

    // No tenant could be derived, so nothing is written — never a widened lookup.
    expect(calls).toEqual([])
    expect(resolveCaseId).not.toHaveBeenCalled()
  })

  /**
   * On the acceptance path this hook runs INSIDE the customer's acceptance transaction,
   * so a throw here would roll back the acceptance, the order and the quote's `confirmed`
   * status. A funnel move must never be able to refuse a signature.
   */
  it('swallows its own failure rather than failing the conversion', async () => {
    resolveCaseId.mockRejectedValue(new Error('database went away'))
    const { ctx } = makeCtx({ quote: { id: quoteId, tenantId, organizationId } })

    await expect(
      interceptor.afterExecute!({ quoteId }, { orderId: 'order-1' }, ctx),
    ).resolves.toBeUndefined()
  })

  it('reports a renamed input instead of silently leaving every case open', async () => {
    const { ctx, calls } = makeCtx({ quote: { id: quoteId, tenantId, organizationId } })

    await interceptor.afterExecute!({ quoteUuid: quoteId }, { orderId: 'order-1' }, ctx)

    expect(calls).toEqual([])
    expect(resolveCaseId).not.toHaveBeenCalled()
  })
})

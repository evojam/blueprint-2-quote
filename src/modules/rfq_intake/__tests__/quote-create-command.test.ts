import { describe, expect, it } from '@jest/globals'

import { createQuoteCommand, quoteCreateInputSchema } from '../commands/quote-create'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const dealId = '33333333-3333-4333-8333-333333333333'
const runId = '44444444-4444-4444-8444-444444444444'
const productId = '55555555-5555-4555-8555-555555555555'

/**
 * The container stub answers only what the command is allowed to reach for. An
 * unexpected `resolve` throws rather than returning undefined, so a command that
 * quietly starts depending on something new fails the test instead of the demo.
 */
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
  items: [{ catalogProductId: productId, basis: 'count' as const, count: 3 }],
}

describe('rfq_intake.quote.create input contract', () => {
  it('strips scope keys from the payload so a model cannot choose its own tenant', () => {
    const parsed = quoteCreateInputSchema.parse({
      ...validInput,
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    })

    expect(parsed).not.toHaveProperty('tenantId')
    expect(parsed).not.toHaveProperty('organizationId')
  })

  it('requires roomIds for an area basis, which a flat optional field could not enforce', () => {
    expect(() =>
      quoteCreateInputSchema.parse({
        dealId,
        roomMeasurementsRunId: runId,
        items: [{ catalogProductId: productId, basis: 'net_wall_area' }],
      }),
    ).toThrow()
  })

  it('drops a count supplied alongside an area basis rather than acting on it', () => {
    const parsed = quoteCreateInputSchema.parse({
      dealId,
      roomMeasurementsRunId: runId,
      items: [{ catalogProductId: productId, basis: 'floor_area', roomIds: ['room-1'], count: 4 }],
    })

    // The `floor_area` member of the union has no `count`, so the stray key never
    // reaches a quantity. A flat object with an optional `count` would have kept it.
    expect(parsed.items[0]).not.toHaveProperty('count')
  })

  it('rejects an empty item list instead of creating an empty quote', () => {
    expect(() =>
      quoteCreateInputSchema.parse({ dealId, roomMeasurementsRunId: runId, items: [] }),
    ).toThrow()
  })
})

describe('rfq_intake.quote.create scope and deal guards', () => {
  it('fails closed when the runtime context carries no tenant', async () => {
    const ctx = { auth: {}, container: { resolve: () => ({}) } } as never

    await expect(createQuoteCommand.execute(validInput, ctx)).rejects.toThrow(/Tenant/)
  })

  it('fails closed when the runtime context carries no organization', async () => {
    const ctx = { auth: { tenantId }, container: { resolve: () => ({}) } } as never

    await expect(createQuoteCommand.execute(validInput, ctx)).rejects.toThrow(/Organization/)
  })

  it('fails closed when the deal is not in the derived scope', async () => {
    // `dealId` comes from a language model, so a hit is proven by reading the deal
    // back inside the trusted scope rather than by trusting the payload.
    await expect(createQuoteCommand.execute(validInput, makeCtx({ deal: null }))).rejects.toThrow(/Deal/)
  })

  it('returns an explicit not-implemented result rather than pretending success', async () => {
    const result = await createQuoteCommand.execute(validInput, makeCtx())

    expect(result).toEqual({ quoteId: null, lineCount: 0, warnings: ['quote_creation_not_implemented'] })
  })
})

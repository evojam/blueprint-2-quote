import { describe, expect, it } from '@jest/globals'

import { createQuoteCommand, quoteCreateInputSchema } from '../commands/quote-create'
import { ROOM_MEASUREMENTS_AGENT_ID } from '../commands/quote-create'
import { measurementResult } from './fixtures/roomMeasurements'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const dealId = '33333333-3333-4333-8333-333333333333'
const runId = '44444444-4444-4444-8444-444444444444'
const productId = '55555555-5555-4555-8555-555555555555'

/** A terminal, in-scope run of the right agent carrying an empty but valid V2 result. */
function acceptedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    tenantId,
    organizationId,
    agentId: ROOM_MEASUREMENTS_AGENT_ID,
    status: 'ok',
    resultKind: 'research',
    deletedAt: null,
    output: measurementResult([]),
    ...overrides,
  }
}

/**
 * The container stub answers only what the command is allowed to reach for. An
 * unexpected `resolve` throws rather than returning undefined, so a command that
 * quietly starts depending on something new fails the test instead of the demo.
 */
function makeCtx(overrides: { deal?: unknown; run?: unknown } = {}) {
  return {
    auth: { tenantId, orgId: organizationId },
    selectedOrganizationId: organizationId,
    container: {
      resolve(name: string) {
        if (name === 'em') {
          return {
            fork: () => ({
              findOne: async (entity: { name: string }) => {
                if (entity.name === 'CustomerDeal') {
                  return 'deal' in overrides ? overrides.deal : { id: dealId }
                }
                if (entity.name === 'AgentRun') {
                  return 'run' in overrides ? overrides.run : acceptedRun()
                }
                // This file exercises the contract and the guards, not line assembly:
                // an empty catalog makes every item drop cleanly so those assertions
                // stay about the guard under test. Line assembly has its own suite.
                if (entity.name.startsWith('Catalog') || entity.name.startsWith('CustomerDeal')) return null
                throw new Error(`unexpected findOne on ${entity.name}`)
              },
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

  it('accepts the explicit nulls the drafter must emit under OpenAI strict mode', () => {
    // `rfq_intake.quote_drafter` declares every item field nullable rather than
    // optional — a property missing from `required` is a 400 before the model runs.
    const parsed = quoteCreateInputSchema.parse({
      dealId,
      roomMeasurementsRunId: runId,
      items: [
        {
          catalogProductId: productId,
          variantId: null,
          basis: 'floor_area',
          roomIds: ['room-1'],
          count: null,
          given: null,
          note: null,
        },
      ],
    })

    expect(parsed.items[0]).toEqual({
      catalogProductId: productId,
      basis: 'floor_area',
      roomIds: ['room-1'],
    })
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

  it('creates nothing and fails loudly when an item resolves to no product', async () => {
    // An empty catalog means the single item is dropped. Nothing survives, so the
    // command fails rather than reporting a quote-shaped success with no lines in it,
    // and the error carries the index the caller wrote.
    await expect(createQuoteCommand.execute(validInput, makeCtx())).rejects.toMatchObject({
      status: 422,
      body: { warnings: ['product_not_found:0'] },
    })
  })
})

describe('rfq_intake.quote.create room-measurements run guard', () => {
  it('fails closed when the run is not in the derived scope', async () => {
    await expect(createQuoteCommand.execute(validInput, makeCtx({ run: null }))).rejects.toThrow(/run/i)
  })

  it('rejects a run produced by another agent, so any AgentRun id will not do', async () => {
    // The id comes from a language model. Without this check a `pdf_intake` run would
    // be accepted and geometry read from something that never contained any.
    const run = acceptedRun({ agentId: 'property_documents.pdf_intake' })
    await expect(createQuoteCommand.execute(validInput, makeCtx({ run }))).rejects.toThrow(/run/i)
  })

  it('rejects a run that has not terminated successfully', async () => {
    const run = acceptedRun({ status: 'running', output: null })
    await expect(createQuoteCommand.execute(validInput, makeCtx({ run }))).rejects.toThrow(/run/i)
  })

  it('rejects a run whose result was not research, because no measurements are in it', async () => {
    const run = acceptedRun({ resultKind: 'artifact' })
    await expect(createQuoteCommand.execute(validInput, makeCtx({ run }))).rejects.toThrow(/run/i)
  })

  it('rejects a soft-deleted run rather than quoting from a withdrawn analysis', async () => {
    const run = acceptedRun({ deletedAt: new Date() })
    await expect(createQuoteCommand.execute(validInput, makeCtx({ run }))).rejects.toThrow(/run/i)
  })

  it('rejects a run carrying an output that is not a V2 measurement result', async () => {
    const run = acceptedRun({ output: { schemaVersion: '1', rooms: 'not-an-array' } })
    await expect(createQuoteCommand.execute(validInput, makeCtx({ run }))).rejects.toThrow(/run/i)
  })

  it('re-checks scope on the loaded row, not only in the query that found it', async () => {
    const run = acceptedRun({ tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    await expect(createQuoteCommand.execute(validInput, makeCtx({ run }))).rejects.toThrow(/run/i)
  })

  it('accepts a valid result and proceeds to the items rather than aborting on the run', async () => {
    // The guard's job ends once the run is usable. Item resolution then runs and, with
    // an empty catalog, refuses on the item rather than on the run.
    await expect(createQuoteCommand.execute(validInput, makeCtx())).rejects.toMatchObject({
      status: 422,
      body: { warnings: ['product_not_found:0'] },
    })
  })

  it('accepts the persisted research envelope returned by the agent runtime', async () => {
    const run = acceptedRun({ output: { kind: 'research', data: measurementResult([]) } })

    await expect(createQuoteCommand.execute(validInput, makeCtx({ run }))).rejects.toMatchObject({
      status: 422,
      body: { warnings: ['product_not_found:0'] },
    })
  })
})

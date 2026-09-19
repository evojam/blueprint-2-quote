import { beforeEach, describe, expect, it, jest } from '@jest/globals'

import { measurementResult, room } from './fixtures/roomMeasurements'

/**
 * The resolvers are mocked on purpose. Pricing and geometry already carry 96 tests of
 * their own; what is under test here is only what the command adds on top of them —
 * the unit gate, grouping before pricing, currency selection and the Sales payload.
 * Driving the resolvers from the test keeps those cases readable instead of buried
 * under catalog and drawing fixtures.
 */
const loadQuotableProduct = jest.fn<(...args: any[]) => Promise<any>>()
const resolveUnitPrice = jest.fn<(...args: any[]) => Promise<any>>()
const resolveQuantity = jest.fn<(...args: any[]) => any>()

jest.mock('../lib/catalogPricing', () => ({
  loadQuotableProduct: (...args: any[]) => loadQuotableProduct(...args),
  resolveUnitPrice: (...args: any[]) => resolveUnitPrice(...args),
}))

jest.mock('../lib/basisResolver', () => {
  const actual = jest.requireActual('../lib/basisResolver') as Record<string, unknown>
  return { ...actual, resolveQuantity: (...args: any[]) => resolveQuantity(...args) }
})

import { createQuoteCommand, ROOM_MEASUREMENTS_AGENT_ID } from '../commands/quote-create'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const dealId = '33333333-3333-4333-8333-333333333333'
const runId = '44444444-4444-4444-8444-444444444444'
const paintId = '55555555-5555-4555-8555-555555555555'
const doorId = '66666666-6666-4666-8666-666666666666'
const standardVariant = '77777777-7777-4777-8777-777777777777'
const premiumVariant = '88888888-8888-4888-8888-888888888888'
const companyEntityId = '99999999-9999-4999-8999-999999999999'

let salesCalls: Array<{ id: string; input: any }>
let linkCalls: Array<{ id: string; input: any }>
/** Set to make the deal-link write fail, which must not cost the quote. */
let linkThrows: boolean
let companyLink: unknown
let personLink: unknown

function makeCtx() {
  return {
    auth: { tenantId, orgId: organizationId },
    selectedOrganizationId: organizationId,
    container: {
      resolve(name: string) {
        if (name === 'em') {
          return {
            fork: () => ({
              findOne: async (entity: { name: string }) => {
                if (entity.name === 'CustomerDeal') return { id: dealId }
                if (entity.name === 'AgentRun') {
                  return {
                    id: runId,
                    tenantId,
                    organizationId,
                    agentId: ROOM_MEASUREMENTS_AGENT_ID,
                    status: 'ok',
                    resultKind: 'research',
                    deletedAt: null,
                    output: measurementResult([room()]),
                  }
                }
                if (entity.name === 'CustomerDealCompanyLink') return companyLink
                if (entity.name === 'CustomerDealPersonLink') return personLink
                throw new Error(`unexpected findOne on ${entity.name}`)
              },
            }),
          }
        }
        if (name === 'commandBus') {
          return {
            execute: async (id: string, options: any) => {
              if (id === 'deal_links.document_links.create') {
                if (linkThrows) throw new Error('link write failed')
                linkCalls.push({ id, input: options.input })
                return { result: { id: 'link-1' }, logEntry: null }
              }
              salesCalls.push({ id, input: options.input })
              return { result: { quoteId: 'created-quote-id' }, logEntry: null }
            },
          }
        }
        if (name === 'catalogPricingService') return {}
        throw new Error(`unexpected resolve ${name}`)
      },
    },
  } as never
}

const paint = (variantId = standardVariant) => ({
  ok: true as const,
  value: { productId: paintId, variantId, title: 'Malowanie ścian i sufitów', defaultUnit: 'm2', taxRateId: 'vat-8' },
})
const pln = (gross = '40.0000') => ({
  ok: true as const,
  value: { currencyCode: 'PLN', unitPriceGross: gross, taxRate: '8.0000', priceId: 'price-1' },
})
const area = (quantity: number) => ({ ok: true as const, value: { quantity, unit: 'm2' as const } })

function input(items: unknown[]) {
  return { dealId, roomMeasurementsRunId: runId, items }
}

beforeEach(() => {
  salesCalls = []
  linkCalls = []
  linkThrows = false
  companyLink = null
  personLink = null
  loadQuotableProduct.mockReset()
  resolveUnitPrice.mockReset()
  resolveQuantity.mockReset()
})

describe('rfq_intake.quote.create line assembly', () => {
  it('drops an item whose basis unit does not match the product, instead of coercing it', async () => {
    // A door is billed per piece; a floor_area basis yields m2, so this is a wrong line.
    loadQuotableProduct.mockResolvedValue({
      ok: true,
      value: { productId: doorId, variantId: standardVariant, title: 'Drzwi', defaultUnit: 'szt', taxRateId: null },
    })
    resolveQuantity.mockReturnValue(area(8))

    const result = await createQuoteCommand.execute(
      input([{ catalogProductId: doorId, basis: 'floor_area', roomIds: ['room-1'] }]),
      makeCtx(),
    )

    expect(result.quoteId).toBeNull()
    expect(result.warnings).toContain('unit_mismatch:0')
    expect(resolveUnitPrice).not.toHaveBeenCalled()
    expect(salesCalls).toHaveLength(0)
  })

  it('creates no quote at all when every item is dropped', async () => {
    loadQuotableProduct.mockResolvedValue({ ok: false, code: 'product_not_found' })

    const result = await createQuoteCommand.execute(
      input([{ catalogProductId: paintId, basis: 'count', count: 2 }]),
      makeCtx(),
    )

    expect(result).toEqual({ quoteId: null, lineCount: 0, warnings: ['product_not_found:0'] })
    expect(salesCalls).toHaveLength(0)
  })

  it('calls sales.quotes.create once with a gross service line and RFQ metadata', async () => {
    loadQuotableProduct.mockResolvedValue(paint())
    resolveQuantity.mockReturnValue(area(9))
    resolveUnitPrice.mockResolvedValue(pln())

    const result = await createQuoteCommand.execute(
      input([{ catalogProductId: paintId, basis: 'net_wall_area', roomIds: ['room-1'], note: 'salon' }]),
      makeCtx(),
    )

    expect(salesCalls).toHaveLength(1)
    expect(salesCalls[0].id).toBe('sales.quotes.create')
    expect(salesCalls[0].input).toMatchObject({
      tenantId,
      organizationId,
      currencyCode: 'PLN',
      metadata: { rfqDealId: dealId, roomMeasurementsRunId: runId, source: 'rfq_intake' },
    })
    expect(salesCalls[0].input.lines[0]).toMatchObject({
      kind: 'service',
      productId: paintId,
      productVariantId: standardVariant,
      quantity: 9,
      quantityUnit: 'm2',
      currencyCode: 'PLN',
      unitPriceGross: '40.0000',
      taxRate: '8.0000',
      priceMode: 'gross',
      name: 'Malowanie ścian i sufitów',
      description: 'salon',
    })
    expect(result).toEqual({ quoteId: 'created-quote-id', lineCount: 1, warnings: [] })
  })

  it('merges two items naming the same product and variant into one summed line', async () => {
    // Painting the salon and the kitchen is twenty metres of one service, not two
    // purchases — and pricing must see the total, because minQuantity tiers exist.
    loadQuotableProduct.mockResolvedValue(paint())
    resolveQuantity.mockReturnValueOnce(area(8)).mockReturnValueOnce(area(12))
    resolveUnitPrice.mockResolvedValue(pln())

    const result = await createQuoteCommand.execute(
      input([
        { catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-1'], note: 'salon' },
        { catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-2'], note: 'kuchnia' },
      ]),
      makeCtx(),
    )

    expect(salesCalls[0].input.lines).toHaveLength(1)
    expect(salesCalls[0].input.lines[0]).toMatchObject({ productId: paintId, quantity: 20 })
    expect(resolveUnitPrice).toHaveBeenCalledTimes(1)
    expect((resolveUnitPrice.mock.calls[0] as any[])[3]).toMatchObject({ quantity: 20 })
    expect(result.lineCount).toBe(1)
  })

  it('keeps the per-room notes of merged items in the line description', async () => {
    loadQuotableProduct.mockResolvedValue(paint())
    resolveQuantity.mockReturnValueOnce(area(8)).mockReturnValueOnce(area(12))
    resolveUnitPrice.mockResolvedValue(pln())

    await createQuoteCommand.execute(
      input([
        { catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-1'], note: 'salon' },
        { catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-2'], note: 'kuchnia' },
      ]),
      makeCtx(),
    )

    expect(salesCalls[0].input.lines[0].description).toBe('salon, kuchnia')
  })

  it('keeps two variants of one product apart, since they are priced apart', async () => {
    loadQuotableProduct
      .mockResolvedValueOnce(paint(standardVariant))
      .mockResolvedValueOnce(paint(premiumVariant))
    resolveQuantity.mockReturnValue(area(10))
    resolveUnitPrice.mockResolvedValueOnce(pln('40.0000')).mockResolvedValueOnce(pln('65.0000'))

    const result = await createQuoteCommand.execute(
      input([
        { catalogProductId: paintId, variantId: standardVariant, basis: 'floor_area', roomIds: ['room-1'] },
        { catalogProductId: paintId, variantId: premiumVariant, basis: 'floor_area', roomIds: ['room-1'] },
      ]),
      makeCtx(),
    )

    expect(salesCalls[0].input.lines).toHaveLength(2)
    expect(result.lineCount).toBe(2)
  })

  it('groups an item that named no variant with one that named the default explicitly', async () => {
    // Grouping keys on the RESOLVED variant, so the default is reached either way.
    loadQuotableProduct.mockResolvedValue(paint(standardVariant))
    resolveQuantity.mockReturnValue(area(5))
    resolveUnitPrice.mockResolvedValue(pln())

    await createQuoteCommand.execute(
      input([
        { catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-1'] },
        { catalogProductId: paintId, variantId: standardVariant, basis: 'floor_area', roomIds: ['room-1'] },
      ]),
      makeCtx(),
    )

    expect(salesCalls[0].input.lines).toHaveLength(1)
    expect(salesCalls[0].input.lines[0].quantity).toBe(10)
  })

  it('reports a dropped item against the index the operator wrote, not a group position', async () => {
    loadQuotableProduct.mockResolvedValueOnce(paint()).mockResolvedValueOnce(paint(premiumVariant))
    resolveQuantity.mockReturnValue(area(4))
    resolveUnitPrice.mockResolvedValueOnce(pln()).mockResolvedValueOnce({ ok: false, code: 'no_price' })

    const result = await createQuoteCommand.execute(
      input([
        { catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-1'] },
        { catalogProductId: paintId, variantId: premiumVariant, basis: 'floor_area', roomIds: ['room-1'] },
      ]),
      makeCtx(),
    )

    expect(result.warnings).toContain('no_price:1')
    expect(salesCalls[0].input.lines).toHaveLength(1)
  })

  it('refuses a line priced in another currency, since quotes are issued in zloty', async () => {
    loadQuotableProduct
      .mockResolvedValueOnce(paint(standardVariant))
      .mockResolvedValueOnce(paint(premiumVariant))
    resolveQuantity.mockReturnValue(area(3))
    resolveUnitPrice
      .mockResolvedValueOnce(pln())
      .mockResolvedValueOnce({
        ok: true,
        value: { currencyCode: 'EUR', unitPriceGross: '10.0000', taxRate: null, priceId: 'price-2' },
      })

    const result = await createQuoteCommand.execute(
      input([
        { catalogProductId: paintId, variantId: standardVariant, basis: 'floor_area', roomIds: ['room-1'] },
        { catalogProductId: paintId, variantId: premiumVariant, basis: 'floor_area', roomIds: ['room-1'] },
      ]),
      makeCtx(),
    )

    expect(salesCalls[0].input.currencyCode).toBe('PLN')
    expect(salesCalls[0].input.lines).toHaveLength(1)
    expect(result.warnings).toContain('currency_unsupported:1')
  })

  it('attaches the linked company, which is who a renovation quote is addressed to', async () => {
    companyLink = { company: { id: companyEntityId } }
    loadQuotableProduct.mockResolvedValue(paint())
    resolveQuantity.mockReturnValue(area(6))
    resolveUnitPrice.mockResolvedValue(pln())

    await createQuoteCommand.execute(
      input([{ catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-1'] }]),
      makeCtx(),
    )

    expect(salesCalls[0].input.customerEntityId).toBe(companyEntityId)
  })

  it('falls back to the primary person when the deal names no company', async () => {
    personLink = { person: { id: companyEntityId } }
    loadQuotableProduct.mockResolvedValue(paint())
    resolveQuantity.mockReturnValue(area(6))
    resolveUnitPrice.mockResolvedValue(pln())

    await createQuoteCommand.execute(
      input([{ catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-1'] }]),
      makeCtx(),
    )

    expect(salesCalls[0].input.customerEntityId).toBe(companyEntityId)
  })

  it('omits the customer entirely rather than inventing one, since Sales allows none', async () => {
    loadQuotableProduct.mockResolvedValue(paint())
    resolveQuantity.mockReturnValue(area(6))
    resolveUnitPrice.mockResolvedValue(pln())

    await createQuoteCommand.execute(
      input([{ catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-1'] }]),
      makeCtx(),
    )

    expect(salesCalls[0].input).not.toHaveProperty('customerEntityId')
  })

  it('surfaces a quantity refusal using the resolver own code', async () => {
    loadQuotableProduct.mockResolvedValue(paint())
    resolveQuantity.mockReturnValue({ ok: false, code: 'ceiling_height_missing' })

    const result = await createQuoteCommand.execute(
      input([{ catalogProductId: paintId, basis: 'gross_wall_area', roomIds: ['room-1'] }]),
      makeCtx(),
    )

    expect(result.warnings).toEqual(['ceiling_height_missing:0'])
    expect(salesCalls).toHaveLength(0)
  })

  it('links the created quote to the deal, which is what puts it on the deal page', async () => {
    loadQuotableProduct.mockResolvedValue(paint())
    resolveQuantity.mockReturnValue(area(6))
    resolveUnitPrice.mockResolvedValue(pln())

    await createQuoteCommand.execute(
      input([{ catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-1'] }]),
      makeCtx(),
    )

    expect(linkCalls).toHaveLength(1)
    expect(linkCalls[0].input).toEqual({
      dealId,
      documentId: 'created-quote-id',
      documentKind: 'quote',
    })
  })

  it('links only after the quote exists, never before it', async () => {
    // The link write does not join this command's transaction and cannot be undone,
    // so ordering is the only thing preventing an orphan row.
    loadQuotableProduct.mockResolvedValue(paint())
    resolveQuantity.mockReturnValue(area(6))
    resolveUnitPrice.mockResolvedValue(pln())

    await createQuoteCommand.execute(
      input([{ catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-1'] }]),
      makeCtx(),
    )

    expect(salesCalls).toHaveLength(1)
    expect(linkCalls).toHaveLength(1)
  })

  it('creates no link when no quote was created', async () => {
    loadQuotableProduct.mockResolvedValue({ ok: false, code: 'product_not_found' })

    const result = await createQuoteCommand.execute(
      input([{ catalogProductId: paintId, basis: 'count', count: 2 }]),
      makeCtx(),
    )

    expect(result.quoteId).toBeNull()
    expect(linkCalls).toHaveLength(0)
  })

  it('keeps the quote and reports the failure when the link cannot be written', async () => {
    linkThrows = true
    loadQuotableProduct.mockResolvedValue(paint())
    resolveQuantity.mockReturnValue(area(6))
    resolveUnitPrice.mockResolvedValue(pln())

    const result = await createQuoteCommand.execute(
      input([{ catalogProductId: paintId, basis: 'floor_area', roomIds: ['room-1'] }]),
      makeCtx(),
    )

    // Losing the tab is recoverable; losing the quote is not.
    expect(result.quoteId).toBe('created-quote-id')
    expect(result.warnings).toContain('deal_link_failed')
  })
})

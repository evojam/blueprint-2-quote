import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const runCommand = jest.fn<(...args: any[]) => Promise<any>>()

jest.mock('../lib/commandBus', () => ({
  runCommand: (...args: any[]) => runCommand(...args),
}))

import handler, {
  isQuoteTotalsEvent,
  type TotalsCalculatedPayload,
} from '../subscribers/sync-deal-value'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const DEAL = '33333333-3333-4333-8333-333333333333'
const QUOTE = '55555555-5555-4555-8555-555555555555'

type Row = Record<string, unknown> | null

/**
 * `em.findOne` is dispatched on the entity class, not on call order, so a test can
 * state which rows exist without depending on how many lookups the handler makes or
 * in what sequence — the reason the link-table fallback can be exercised at all.
 */
function contextWith(rows: { quote?: Row; link?: Row; deal?: Row }) {
  const findOne = jest.fn(async (entity: { name?: string }, _where: unknown) => {
    const name = entity?.name ?? ''
    if (name.includes('SalesQuote')) return rows.quote ?? null
    if (name.includes('DealDocumentLink')) return rows.link ?? null
    if (name.includes('CustomerDeal')) return rows.deal ?? null
    return null
  })
  const em = { fork: () => ({ findOne }) }
  return {
    ctx: { resolve: () => em } as unknown as Parameters<typeof handler>[1],
    findOne,
  }
}

function totalsEvent(overrides: Partial<TotalsCalculatedPayload> = {}): TotalsCalculatedPayload {
  return {
    documentKind: 'quote',
    documentId: QUOTE,
    tenantId: TENANT,
    organizationId: ORG,
    totals: { grandTotalNetAmount: '12345.67' },
    lineCount: 3,
    ...overrides,
  }
}

const quoteRow = { id: QUOTE, currencyCode: 'PLN', metadata: { rfqDealId: DEAL } }
const dealRow = { id: DEAL }

describe('isQuoteTotalsEvent', () => {
  it('ignores orders, because the event is shared with them', () => {
    expect(isQuoteTotalsEvent(totalsEvent({ documentKind: 'order' }))).toBe(false)
  })

  it('ignores an event with no document to read', () => {
    expect(isQuoteTotalsEvent(totalsEvent({ documentId: '  ' }))).toBe(false)
  })

  it('accepts a quote', () => {
    expect(isQuoteTotalsEvent(totalsEvent())).toBe(true)
  })
})

describe('rfq_intake sync-deal-value', () => {
  beforeEach(() => {
    runCommand.mockReset()
    runCommand.mockResolvedValue({})
  })

  it('carries the NET grand total onto the case, in the quote\'s currency', async () => {
    const { ctx } = contextWith({ quote: quoteRow, deal: dealRow })

    await handler(totalsEvent(), ctx)

    expect(runCommand).toHaveBeenCalledTimes(1)
    const [, commandId, input] = runCommand.mock.calls[0]!
    expect(commandId).toBe('customers.deals.update')
    // Net, not gross: the funnel is read for forecasting and VAT is not revenue.
    expect(input).toEqual({
      tenantId: TENANT,
      organizationId: ORG,
      id: DEAL,
      valueAmount: '12345.67',
      valueCurrency: 'PLN',
    })
  })

  it('falls back to the deal_links row when the quote carries no stamp', async () => {
    const { ctx } = contextWith({
      quote: { id: QUOTE, currencyCode: 'PLN', metadata: null },
      link: { dealId: DEAL },
      deal: dealRow,
    })

    await handler(totalsEvent(), ctx)

    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(runCommand.mock.calls[0]![2]).toMatchObject({ id: DEAL })
  })

  it('leaves quotes that belong to no case alone', async () => {
    const { ctx } = contextWith({
      quote: { id: QUOTE, currencyCode: 'PLN', metadata: {} },
      link: null,
    })

    await handler(totalsEvent(), ctx)

    expect(runCommand).not.toHaveBeenCalled()
  })

  it('re-syncs on a later recalculation, which is why it hangs off totals and not creation', async () => {
    const { ctx } = contextWith({ quote: quoteRow, deal: dealRow })

    await handler(totalsEvent({ totals: { grandTotalNetAmount: '100.00' } }), ctx)
    await handler(totalsEvent({ totals: { grandTotalNetAmount: '250.00' } }), ctx)

    // Last write wins, over the earlier figure and over anything typed in by hand.
    expect(runCommand).toHaveBeenCalledTimes(2)
    expect(runCommand.mock.calls[1]![2]).toMatchObject({ valueAmount: '250.00' })
  })

  it('accepts a numeric total, because the event is not schema-validated on the way in', async () => {
    const { ctx } = contextWith({ quote: quoteRow, deal: dealRow })

    await handler(totalsEvent({ totals: { grandTotalNetAmount: 42 } }), ctx)

    expect(runCommand.mock.calls[0]![2]).toMatchObject({ valueAmount: '42' })
  })

  it('fails closed on incomplete scope rather than widening the query', async () => {
    const { ctx, findOne } = contextWith({ quote: quoteRow, deal: dealRow })

    await handler(totalsEvent({ organizationId: null }), ctx)

    expect(findOne).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('does not write when the case is invisible in this scope', async () => {
    const { ctx } = contextWith({ quote: quoteRow, deal: null })

    await handler(totalsEvent(), ctx)

    expect(runCommand).not.toHaveBeenCalled()
  })
})

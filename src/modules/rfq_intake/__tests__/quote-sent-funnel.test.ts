import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const resolveCaseId = jest.fn<(...args: any[]) => Promise<any>>()
const loadRfqFunnel = jest.fn<(...args: any[]) => Promise<any>>()
const findOneWithDecryption = jest.fn<(...args: any[]) => Promise<any>>()

jest.mock('../lib/quoteCase', () => ({
  resolveCaseId: (...args: any[]) => resolveCaseId(...args),
}))

jest.mock('../lib/pipeline', () => {
  const actual = jest.requireActual('../lib/pipeline') as Record<string, unknown>
  return {
    ...actual,
    loadRfqFunnel: (...args: any[]) => loadRfqFunnel(...args),
  }
})

jest.mock('@open-mercato/shared/lib/encryption/find', () => {
  const actual = jest.requireActual('@open-mercato/shared/lib/encryption/find') as Record<string, unknown>
  return {
    ...actual,
    findOneWithDecryption: (...args: any[]) => findOneWithDecryption(...args),
  }
})

import { advanceCaseForSentQuote, shouldAdvanceToSent } from '../lib/quoteSentFunnel'

/**
 * The direction guard is the feature. `REQ-002` (forward only) and `REQ-003` (closing
 * beats sending) are the two rules a reviewer would have to take on trust otherwise, and
 * both are pure functions of the stage a case already sits in — no database needed.
 *
 * Spec: `.ai/specs/2026-09-20-quote-sent-advances-funnel.md`.
 */
describe('shouldAdvanceToSent', () => {
  it('moves a case that has not entered a funnel', () => {
    expect(shouldAdvanceToSent(null)).toBe(true)
  })

  it.each([
    ['new', 'Nowe zgłoszenie'],
    ['quoting', 'Wycena w toku'],
    ['review', 'Do sprawdzenia'],
  ] as const)('moves a case standing at %s, before the sent stage', (key, label) => {
    expect(shouldAdvanceToSent({ rfqStageKey: key, label })).toBe(true)
  })

  it('does not move a case already at the sent stage, so re-sending is a no-op', () => {
    expect(shouldAdvanceToSent({ rfqStageKey: 'sent', label: 'Oferta wysłana' })).toBe(false)
  })

  it.each([
    ['won', 'Closed Won'],
    ['lost', 'Closed Lost'],
  ] as const)('does not drag a case back out of %s', (key, label) => {
    expect(shouldAdvanceToSent({ rfqStageKey: key, label })).toBe(false)
  })

  /**
   * The discriminating case for REQ-003. A deal closed in a pipeline this module never
   * seeded carries `rfqStageKey: null`, which the "foreign stage" rule would otherwise
   * wave through — and a won deal would be dragged back to "offer sent" by a re-send.
   * Labels come from the installed `TERMINAL_PIPELINE_STAGE_LABELS`, which is why the
   * stock `Win` / `Lost` spellings are here alongside the RFQ funnel's own.
   */
  it.each(['Win', 'win', 'Lost', 'Closed Won', 'closed lost', 'Closed  Won'])(
    'does not move a case closed in a foreign pipeline (%s)',
    (label) => {
      expect(shouldAdvanceToSent({ rfqStageKey: null, label })).toBe(false)
    },
  )

  it('moves a case sitting in a foreign, non-terminal stage into the RFQ funnel', () => {
    // The deployed-environment shape: a deal still in the stock `Default Pipeline`.
    expect(shouldAdvanceToSent({ rfqStageKey: null, label: 'Negotiations' })).toBe(true)
  })

  it('moves a case whose stage carries no readable label', () => {
    expect(shouldAdvanceToSent({ rfqStageKey: null, label: null })).toBe(true)
  })
})

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}
const quoteId = '44444444-4444-4444-8444-444444444444'
const dealId = '33333333-3333-4333-8333-333333333333'
const sentStageId = '55555555-5555-4555-8555-555555555555'
const reviewStageId = '66666666-6666-4666-8666-666666666666'

function makeCtx(deal: Record<string, unknown> | null) {
  const calls: Array<{ id: string; input: any }> = []
  const ctx = {
    container: {
      resolve(name: string) {
        if (name === 'em') return { fork: () => ({ findOne: async () => deal }) }
        if (name === 'commandBus') {
          return {
            execute: async (id: string, options: any) => {
              calls.push({ id, input: options.input })
              return { result: { moved: true, stageId: sentStageId }, logEntry: null }
            },
          }
        }
        throw new Error(`unexpected resolve ${name}`)
      },
    },
  }
  return { ctx: ctx as never, calls }
}

function seededFunnel() {
  return {
    pipelineId: '77777777-7777-4777-8777-777777777777',
    stageIdByKey: { review: reviewStageId, sent: sentStageId },
    keyByStageId: new Map([
      [reviewStageId, 'review'],
      [sentStageId, 'sent'],
    ]),
  }
}

describe('advanceCaseForSentQuote', () => {
  beforeEach(() => {
    resolveCaseId.mockReset()
    loadRfqFunnel.mockReset()
    findOneWithDecryption.mockReset()
  })

  it('advances a linked case through the command, not by writing the stage itself', async () => {
    resolveCaseId.mockResolvedValue({ dealId, currencyCode: 'PLN' })
    loadRfqFunnel.mockResolvedValue(seededFunnel())
    findOneWithDecryption.mockResolvedValue({ id: reviewStageId, label: 'Do sprawdzenia' })
    const { ctx, calls } = makeCtx({ id: dealId, pipelineStageId: reviewStageId })

    await expect(advanceCaseForSentQuote(ctx, { quoteId, scope })).resolves.toBe('moved')

    // Through `rfq_intake.deal.advance` on purpose: it records the transition in the
    // deal's history, which a direct `pipelineStageId` write here would not.
    expect(calls).toEqual([
      { id: 'rfq_intake.deal.advance', input: { ...scope, dealId, stage: 'sent' } },
    ])
  })

  it('does not move a case that is already at the sent stage', async () => {
    resolveCaseId.mockResolvedValue({ dealId, currencyCode: 'PLN' })
    loadRfqFunnel.mockResolvedValue(seededFunnel())
    findOneWithDecryption.mockResolvedValue({ id: sentStageId, label: 'Oferta wysłana' })
    const { ctx, calls } = makeCtx({ id: dealId, pipelineStageId: sentStageId })

    await expect(advanceCaseForSentQuote(ctx, { quoteId, scope })).resolves.toBe(
      'already-at-or-past-sent',
    )
    expect(calls).toEqual([])
  })

  it('leaves a quote that answers no case alone', async () => {
    resolveCaseId.mockResolvedValue(null)
    const { ctx, calls } = makeCtx(null)

    await expect(advanceCaseForSentQuote(ctx, { quoteId, scope })).resolves.toBe('not-an-rfq-case')
    expect(calls).toEqual([])
  })

  /**
   * The deployed-environment state: `mercato rfq_intake seed-pipeline` has never run, so
   * there is no `Oferta wysłana` to move to. This must report, not invent CRM structure.
   */
  it('reports an unseeded funnel instead of creating one', async () => {
    resolveCaseId.mockResolvedValue({ dealId, currencyCode: 'PLN' })
    loadRfqFunnel.mockResolvedValue(null)
    const { ctx, calls } = makeCtx({ id: dealId, pipelineStageId: null })

    await expect(advanceCaseForSentQuote(ctx, { quoteId, scope })).resolves.toBe(
      'funnel-not-seeded',
    )
    expect(calls).toEqual([])
  })

  it('does not move a case that is no longer visible in this scope', async () => {
    resolveCaseId.mockResolvedValue({ dealId, currencyCode: 'PLN' })
    const { ctx, calls } = makeCtx(null)

    await expect(advanceCaseForSentQuote(ctx, { quoteId, scope })).resolves.toBe(
      'case-not-visible',
    )
    expect(calls).toEqual([])
  })
})

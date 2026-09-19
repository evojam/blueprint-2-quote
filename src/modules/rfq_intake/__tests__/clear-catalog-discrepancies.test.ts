import { beforeEach, describe, expect, it, jest } from '@jest/globals'

import handler, { type ProposalCreatedPayload } from '../subscribers/clear-catalog-discrepancies'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const PROPOSAL = '66666666-6666-4666-8666-666666666666'

type Discrepancy = {
  id: string
  type: string
  severity: 'warning' | 'error'
  resolved: boolean
  metadata?: Record<string, unknown> | null
}

/**
 * `em.find` is dispatched on the entity class rather than on call order, so a test can
 * state what exists without depending on how many queries the handler makes. The
 * discrepancy query's `where` is captured, because the type filter is the guard that
 * keeps this from becoming a blanket "resolve everything".
 */
function contextWith(rows: { actions?: unknown[]; discrepancies?: Discrepancy[] }) {
  const wheres: Record<string, unknown> = {}
  const find = jest.fn(async (entity: { name?: string }, where: Record<string, unknown>) => {
    const name = entity?.name ?? ''
    if (name.includes('InboxProposalAction')) {
      wheres.actions = where
      return rows.actions ?? []
    }
    if (name.includes('InboxDiscrepancy')) {
      wheres.discrepancies = where
      return rows.discrepancies ?? []
    }
    return []
  })
  const persist = jest.fn()
  const flush = jest.fn(async () => {})
  const em = { fork: () => ({ find, persist, flush }) }
  return {
    ctx: { resolve: () => em } as unknown as Parameters<typeof handler>[1],
    find,
    flush,
    wheres,
  }
}

function proposalCreated(overrides: Partial<ProposalCreatedPayload> = {}): ProposalCreatedPayload {
  return { proposalId: PROPOSAL, tenantId: TENANT, organizationId: ORG, ...overrides }
}

function discrepancy(overrides: Partial<Discrepancy> = {}): Discrepancy {
  return {
    id: 'd-1',
    type: 'product_not_found',
    severity: 'error',
    resolved: false,
    metadata: null,
    ...overrides,
  }
}

describe('rfq_intake clear-catalog-discrepancies', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('resolves the catalog miss that would otherwise disable Accept', async () => {
    const blocker = discrepancy()
    const { ctx, flush } = contextWith({
      actions: [{ id: 'action-1' }],
      discrepancies: [blocker],
    })

    await handler(proposalCreated(), ctx)

    expect(blocker.resolved).toBe(true)
    // The row records who decided and why; the UI hides it, the audit trail keeps it.
    expect(blocker.metadata).toMatchObject({
      resolvedBy: 'rfq_intake:clear-catalog-discrepancies',
    })
    expect(flush).toHaveBeenCalled()
  })

  it('asks only for product_not_found, so it can never become a blanket resolve', async () => {
    const { ctx, wheres } = contextWith({
      actions: [{ id: 'action-1' }],
      discrepancies: [discrepancy()],
    })

    await handler(proposalCreated(), ctx)

    // Missing quantities, an unresolved currency and an unmatched contact are real
    // information for whoever accepts; this subscriber must never touch them.
    expect(wheres.discrepancies).toMatchObject({
      type: { $in: ['product_not_found'] },
      resolved: false,
    })
  })

  it('looks only at this module\'s action type', async () => {
    const { ctx, wheres } = contextWith({ actions: [] })

    await handler(proposalCreated(), ctx)

    expect(wheres.actions).toMatchObject({ actionType: 'create_quote', proposalId: PROPOSAL })
  })

  it('does nothing when the proposal has no RFQ action', async () => {
    const { ctx, flush, find } = contextWith({ actions: [] })

    await handler(proposalCreated(), ctx)

    // One lookup, then out — it must not go on to read discrepancies.
    expect(find).toHaveBeenCalledTimes(1)
    expect(flush).not.toHaveBeenCalled()
  })

  it('does nothing when the RFQ action carries no blocker', async () => {
    const { ctx, flush } = contextWith({ actions: [{ id: 'action-1' }], discrepancies: [] })

    await handler(proposalCreated(), ctx)

    expect(flush).not.toHaveBeenCalled()
  })

  it('fails closed on incomplete scope rather than widening the query', async () => {
    const { ctx, find } = contextWith({ actions: [{ id: 'action-1' }] })

    await handler(proposalCreated({ organizationId: null }), ctx)

    expect(find).not.toHaveBeenCalled()
  })
})

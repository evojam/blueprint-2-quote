import { describe, expect, it } from '@jest/globals'
import { interceptors } from '../commands/interceptors'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const DEAL = '33333333-3333-4333-8333-333333333333'
const QUOTE = '44444444-4444-4444-8444-444444444444'
const ORDER = '77777777-7777-4777-8777-777777777777'

function buildCtx(rows: Array<Record<string, unknown>>) {
  const persisted: Array<Record<string, unknown>> = []
  const queries: Array<Record<string, unknown>> = []
  const em = {
    fork: () => em,
    findOne: async (_entity: unknown, where: Record<string, unknown>) => {
      queries.push(where)
      // Compare only the keys the caller actually filtered on. Hard-coding `tenantId`
      // here made the fake stricter than the store it stands in for, which is what let
      // the old `ctx.auth`-derived scoping look correct in tests while failing on the
      // public acceptance path.
      return (
        rows.find((row) =>
          Object.entries(where).every(([key, value]) => {
            if (key === 'deletedAt') return true
            return row[key] === value
          }),
        ) ?? null
      )
    },
    create: (_entity: unknown, data: Record<string, unknown>) => data,
    persist: (data: Record<string, unknown>) => { persisted.push(data) },
    flush: async () => {},
  }
  const ctx = {
    commandId: 'sales.quotes.convert_to_order',
    auth: { tenantId: TENANT, orgId: ORG },
    selectedOrganizationId: ORG,
    container: { resolve: (name: string) => (name === 'em' ? em : null) },
  }
  return { ctx: ctx as never, persisted, queries }
}

const sourceLink = {
  id: 'link-1',
  dealId: DEAL,
  documentId: QUOTE,
  documentKind: 'quote',
  tenantId: TENANT,
  organizationId: ORG,
}

const interceptor = interceptors[0]

describe('deal_links.link-converted-order', () => {
  it('targets the installed conversion command', () => {
    expect(interceptor.targetCommand).toBe('sales.quotes.convert_to_order')
  })

  it('links the new order to the same deal as the converted quote', async () => {
    const { ctx, persisted } = buildCtx([sourceLink])

    await interceptor.afterExecute?.({ quoteId: QUOTE }, { orderId: ORDER }, ctx)

    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      dealId: DEAL,
      documentId: ORDER,
      documentKind: 'order',
      tenantId: TENANT,
      organizationId: ORG,
    })
  })

  it('does nothing when the converted quote was never linked to a deal', async () => {
    const { ctx, persisted } = buildCtx([])

    await interceptor.afterExecute?.({ quoteId: QUOTE }, { orderId: ORDER }, ctx)

    expect(persisted).toHaveLength(0)
  })

  it('scopes the source lookup to the organization and takes the tenant from the row', async () => {
    const { ctx, queries, persisted } = buildCtx([sourceLink])

    await interceptor.afterExecute?.({ quoteId: QUOTE }, { orderId: ORDER }, ctx)

    // The source row is found by organization — an organization id belongs to exactly one
    // tenant — and the tenant that scopes the write comes from that row, not from the
    // actor. See the comment on the interceptor for why reading it off `ctx.auth` was a
    // bug rather than a style.
    expect(queries[0]).toMatchObject({ documentId: QUOTE, organizationId: ORG })
    expect(queries[0]).not.toHaveProperty('tenantId')
    expect(persisted[0]).toMatchObject({ tenantId: TENANT, organizationId: ORG })
  })

  /**
   * Regression: a customer accepting their quote.
   *
   * `sales/api/quotes/accept/route.ts:130` builds the command context with `auth: null` —
   * the customer holds a quote token, not a session — and carries no `tenantId` on it.
   * While this hook read the tenant off `ctx.auth`, it returned early for every customer
   * acceptance, so an order created by a customer signing was never linked to its deal.
   * Only staff-side conversions ever linked. Verified by sabotage: restoring
   * `ctx.auth?.tenantId` turns this case red and leaves every other case in this file green.
   */
  it('links the order when the customer accepted, with no auth on the context', async () => {
    const { ctx, persisted } = buildCtx([sourceLink])
    ;(ctx as unknown as { auth: unknown }).auth = null

    await interceptor.afterExecute?.({ quoteId: QUOTE }, { orderId: ORDER }, ctx)

    expect(persisted).toEqual([
      { dealId: DEAL, documentId: ORDER, documentKind: 'order', tenantId: TENANT, organizationId: ORG },
    ])
  })

  it('fails closed and writes nothing when the context carries no scope', async () => {
    const { ctx, persisted } = buildCtx([sourceLink])
    ;(ctx as unknown as { auth: unknown }).auth = null
    ;(ctx as unknown as { selectedOrganizationId: unknown }).selectedOrganizationId = null

    await interceptor.afterExecute?.({ quoteId: QUOTE }, { orderId: ORDER }, ctx)

    expect(persisted).toHaveLength(0)
  })

  it('does not link twice when the order already has a link', async () => {
    const { ctx, persisted } = buildCtx([
      sourceLink,
      { id: 'link-2', dealId: DEAL, documentId: ORDER, documentKind: 'order', tenantId: TENANT, organizationId: ORG },
    ])

    await interceptor.afterExecute?.({ quoteId: QUOTE }, { orderId: ORDER }, ctx)

    expect(persisted).toHaveLength(0)
  })
})

// Mirrors the payload `sales.quotes.convert_to_order`'s own `buildLog` writes
// (`sales/commands/documents.ts` ~line 6757): `payload.undo = { quote: before,
// order: after }`, persisted as `ActionLog.commandPayload` and read back via
// `extractUndoPayload`.
function buildUndoLogEntry(orderId: string | null) {
  return {
    commandPayload: {
      undo: {
        quote: { quote: { id: QUOTE, dealId: DEAL } },
        order: orderId ? { order: { id: orderId } } : null,
      },
    },
  }
}

// Factory, not a shared const: `afterUndo` mutates the found row in place
// (`link.deletedAt = new Date()`) before persisting it, and `findOne` in the
// fake `em` returns rows by reference — a shared object would leak the
// mutation from one test into the next.
function buildOrderLink() {
  return {
    id: 'link-2',
    dealId: DEAL,
    documentId: ORDER,
    documentKind: 'order',
    tenantId: TENANT,
    organizationId: ORG,
  }
}

describe('deal_links.link-converted-order — afterUndo', () => {
  it('soft-deletes the order link when the conversion is undone', async () => {
    const { ctx, persisted } = buildCtx([sourceLink, buildOrderLink()])
    const undoContext = { input: { quoteId: QUOTE }, logEntry: buildUndoLogEntry(ORDER), undoToken: 'tok-1' }

    await interceptor.afterUndo?.(undoContext as never, ctx)

    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ documentId: ORDER, documentKind: 'order' })
    expect((persisted[0] as { deletedAt?: Date }).deletedAt).toBeInstanceOf(Date)
  })

  it('does nothing when no matching order link exists', async () => {
    const { ctx, persisted } = buildCtx([sourceLink])
    const undoContext = { input: { quoteId: QUOTE }, logEntry: buildUndoLogEntry(ORDER), undoToken: 'tok-2' }

    await interceptor.afterUndo?.(undoContext as never, ctx)

    expect(persisted).toHaveLength(0)
  })

  it('writes nothing when the context carries no scope', async () => {
    const { ctx, persisted } = buildCtx([sourceLink, buildOrderLink()])
    ;(ctx as unknown as { auth: unknown }).auth = null
    ;(ctx as unknown as { selectedOrganizationId: unknown }).selectedOrganizationId = null
    const undoContext = { input: { quoteId: QUOTE }, logEntry: buildUndoLogEntry(ORDER), undoToken: 'tok-3' }

    await interceptor.afterUndo?.(undoContext as never, ctx)

    expect(persisted).toHaveLength(0)
  })
})

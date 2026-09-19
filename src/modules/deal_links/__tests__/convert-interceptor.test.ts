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
      return (
        rows.find(
          (row) =>
            row.documentId === where.documentId &&
            row.documentKind === where.documentKind &&
            row.tenantId === where.tenantId &&
            row.organizationId === where.organizationId,
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

  it('scopes the lookup to the acting tenant and organization', async () => {
    const { ctx, queries } = buildCtx([sourceLink])

    await interceptor.afterExecute?.({ quoteId: QUOTE }, { orderId: ORDER }, ctx)

    expect(queries[0]).toMatchObject({ tenantId: TENANT, organizationId: ORG })
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

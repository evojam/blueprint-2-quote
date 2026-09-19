import { describe, expect, it, jest } from '@jest/globals'

jest.mock('@open-mercato/shared/lib/commands', () => ({
  registerCommand: jest.fn(),
}))

import { createDocumentLinkCommand } from '../commands/document-links'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const DEAL = '33333333-3333-4333-8333-333333333333'
const QUOTE = '44444444-4444-4444-8444-444444444444'

const OTHER_TENANT = '55555555-5555-4555-8555-555555555555'
const OTHER_ORG = '66666666-6666-4666-8666-666666666666'

function buildCtx(overrides: { tenantId?: string | null; organizationId?: string | null } = {}) {
  const created: Array<Record<string, unknown>> = []
  const dataEngine = {
    createOrmEntity: async ({ data }: { data: Record<string, unknown> }) => {
      created.push(data)
      return { id: 'link-1', ...data }
    },
  }
  // NOTE: `overrides.tenantId ?? TENANT` cannot distinguish "not passed" from
  // an explicit `null` (both are nullish), which made the "fails closed" test
  // below silently pass `TENANT` regardless of the override. Using `in`
  // preserves an explicit `null` so that test actually exercises the no-tenant
  // path.
  const ctx = {
    auth: {
      tenantId: 'tenantId' in overrides ? overrides.tenantId : TENANT,
      orgId: 'organizationId' in overrides ? overrides.organizationId : ORG,
    },
    selectedOrganizationId: 'organizationId' in overrides ? overrides.organizationId : ORG,
    container: {
      resolve: (name: string) => {
        if (name === 'dataEngine') return dataEngine
        throw new Error(`unexpected resolve: ${name}`)
      },
    },
  }
  return { ctx: ctx as never, created }
}

describe('deal_links.document_links.create', () => {
  it('persists the link with the scope taken from the command context', async () => {
    const { ctx, created } = buildCtx()

    await createDocumentLinkCommand.execute(
      { dealId: DEAL, documentId: QUOTE, documentKind: 'quote' },
      ctx,
    )

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      dealId: DEAL,
      documentId: QUOTE,
      documentKind: 'quote',
      tenantId: TENANT,
      organizationId: ORG,
    })
  })

  /**
   * The eventual caller forwards a payload produced by a model. Scope keys in it
   * are not evidence of anything; the context is.
   */
  it('ignores tenant and organization supplied in the payload', async () => {
    const { ctx, created } = buildCtx()

    await createDocumentLinkCommand.execute(
      {
        dealId: DEAL,
        documentId: QUOTE,
        documentKind: 'quote',
        tenantId: OTHER_TENANT,
        organizationId: OTHER_ORG,
      },
      ctx,
    )

    expect(created[0]).toMatchObject({ tenantId: TENANT, organizationId: ORG })
  })

  it('rejects a document kind outside the two known values', async () => {
    const { ctx } = buildCtx()

    await expect(
      createDocumentLinkCommand.execute(
        { dealId: DEAL, documentId: QUOTE, documentKind: 'invoice' },
        ctx,
      ),
    ).rejects.toThrow()
  })

  it('fails closed when the context carries no tenant', async () => {
    const { ctx, created } = buildCtx({ tenantId: null })

    await expect(
      createDocumentLinkCommand.execute(
        { dealId: DEAL, documentId: QUOTE, documentKind: 'quote' },
        ctx,
      ),
    ).rejects.toThrow()
    expect(created).toHaveLength(0)
  })
})

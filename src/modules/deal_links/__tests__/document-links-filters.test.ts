import { describe, expect, it } from '@jest/globals'
import { buildDocumentLinkFilters, documentLinksListQuerySchema } from '../lib/document-links-filters'

const DEAL_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const DOCUMENT_ID = 'bbbbbbbb-0000-4000-8000-000000000002'

describe('buildDocumentLinkFilters', () => {
  it('filters by deal when only a deal is given', () => {
    expect(buildDocumentLinkFilters({ dealId: DEAL_ID })).toEqual({ deal_id: DEAL_ID })
  })

  it('filters by document when only a document is given', () => {
    expect(buildDocumentLinkFilters({ documentId: DOCUMENT_ID })).toEqual({
      document_id: DOCUMENT_ID,
    })
  })

  // A future unlink path asks exactly this: "the row joining THIS deal to THIS document".
  it('narrows to one pair when both are given', () => {
    expect(buildDocumentLinkFilters({ dealId: DEAL_ID, documentId: DOCUMENT_ID })).toEqual({
      deal_id: DEAL_ID,
      document_id: DOCUMENT_ID,
    })
  })

  // Byte-identical behaviour to before this slice: no parameter, no filter.
  it('installs no filter when neither is given', () => {
    expect(buildDocumentLinkFilters({})).toEqual({})
  })

  it('ignores empty strings rather than filtering on them', () => {
    expect(buildDocumentLinkFilters({ dealId: '', documentId: '' })).toEqual({})
  })
})

describe('documentLinksListQuerySchema', () => {
  // Regression oracle for the route's untestable `querySchema` (M-9 of the final
  // review): if `documentId` were ever dropped from this schema, every
  // `buildDocumentLinkFilters` test above would still pass while the document
  // tab silently listed every link in the caller's organization instead of
  // this document's — a fail-open within the tenant, not an empty list.
  it('parses documentId and leaves it optional', () => {
    const withDocumentId = documentLinksListQuerySchema.parse({
      documentId: 'bbbbbbbb-0000-4000-8000-000000000002',
    })
    expect(withDocumentId.documentId).toBe('bbbbbbbb-0000-4000-8000-000000000002')

    const withoutDocumentId = documentLinksListQuerySchema.parse({})
    expect(withoutDocumentId.documentId).toBeUndefined()
  })

  it('rejects a documentId that is not a UUID', () => {
    expect(() => documentLinksListQuerySchema.parse({ documentId: 'not-a-uuid' })).toThrow()
  })

  it('defaults paging and sort when omitted', () => {
    const parsed = documentLinksListQuerySchema.parse({})
    expect(parsed).toMatchObject({
      page: 1,
      pageSize: 50,
      sortField: 'created_at',
      sortDir: 'desc',
    })
  })
})

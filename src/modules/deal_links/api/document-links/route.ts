import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { DealDocumentLink } from '../../data/entities'
import { documentLinkCreateSchema } from '../../commands/document-links'
import { documentLinksRouteAccess, DOCUMENT_LINK_ENTITY_ID } from '../../lib/route-access'

const querySchema = z.object({
  dealId: z.string().uuid().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(50),
  sortField: z.string().optional().default('created_at'),
  sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
})

type Query = z.infer<typeof querySchema>

const listItemSchema = z.object({
  id: z.string(),
  deal_id: z.string(),
  document_id: z.string(),
  document_kind: z.string(),
  created_at: z.string(),
})

const listResponseSchema = z.object({
  items: z.array(listItemSchema),
  total: z.number().optional(),
})

const createdSchema = z.object({ id: z.string() })
const errorSchema = z.object({ error: z.string() })

// `events` and `indexer` are optional on this factory
// (`shared/src/lib/crud/factory.ts:502-503`) and deliberately omitted — see the
// HACK note on the create command.
export const { metadata, GET, POST } = makeCrudRoute({
  metadata: documentLinksRouteAccess,
  orm: {
    entity: DealDocumentLink,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  list: {
    schema: querySchema,
    entityId: DOCUMENT_LINK_ENTITY_ID,
    fields: () => ['id', 'deal_id', 'document_id', 'document_kind', 'created_at'],
    sortFieldMap: { created_at: 'created_at' },
    // `makeCrudRoute` resolves sort from the RAW query params merged with the
    // interceptor query, not from the validated Zod object
    // (`shared/src/lib/crud/factory.ts` — `queryParams = { ...rawQueryParams, ... }`
    // feeding `resolveSortParams`), so the Zod `default('created_at')` /
    // `default('desc')` on `querySchema` above are never consulted when a real
    // request omits `sortField`/`sortDir`. This `defaultSort` is what actually
    // makes the list "newest first" as documented in `openApi` below.
    defaultSort: { field: 'created_at', dir: 'desc' },
    buildFilters: async (q: Query) => {
      const filters: Record<string, unknown> = {}
      if (q.dealId) filters.deal_id = q.dealId
      return filters
    },
  },
  actions: {
    create: {
      commandId: 'deal_links.document_links.create',
      schema: documentLinkCreateSchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => ({ id: String(result.id) }),
      status: 201,
    },
  },
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Deal links',
  summary: 'Links between a CRM deal and its sales documents',
  methods: {
    GET: {
      summary: 'List the sales documents linked to a deal',
      description: 'Returns the quote and order links recorded for one deal, newest first.',
      tags: ['Deal links'],
      query: querySchema,
      responses: [{ status: 200, description: 'Links for the deal.', schema: listResponseSchema }],
      errors: [{ status: 403, description: 'Missing customers.deals.view.', schema: errorSchema }],
    },
    POST: {
      summary: 'Link a sales document to a deal',
      description:
        'Records one deal-to-document link. Scope is taken from the session, never from the body.',
      tags: ['Deal links'],
      requestBody: { schema: documentLinkCreateSchema },
      responses: [{ status: 201, description: 'Link created.', schema: createdSchema }],
      errors: [{ status: 403, description: 'Missing customers.deals.manage.', schema: errorSchema }],
    },
  },
}

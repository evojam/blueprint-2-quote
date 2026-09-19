# Deal ↔ Sales Document Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a CRM deal a durable, scoped link to the quote or order that answers it, readable from a tab on the deal detail page.

**Architecture:** One app-owned module, `deal_links`, owns a single table (`deal_document_links`) holding `deal_id` + `document_id` + `document_kind`. Exactly one write path — the command `deal_links.document_links.create` — is wrapped by a `makeCrudRoute` HTTP route and will later be called by another person's quote-creating command. A command interceptor on the installed `sales.quotes.convert_to_order` follows a linked quote into the order it becomes. An injection widget on the deal detail page reads the route.

**Tech Stack:** Next.js route handlers, MikroORM (PostgreSQL), Zod, Awilix DI, Jest, Open Mercato command bus / `makeCrudRoute` / injection widgets.

**Spec:** `.ai/specs/2026-09-19-deal-document-links.md`

## Global Constraints

Copied from `AGENTS.md` and the spec. Every task's requirements implicitly include these.

- Derive trusted `tenantId` + `organizationId` from the command/route context and **fail closed**. Never read scope from a payload — the eventual caller passes LLM-produced input.
- No cross-module ORM relations. `deal_id` and `document_id` are plain `uuid` scalars with no foreign keys into `customers` or `sales` (`.ai/guides/contracts.md:10`).
- Never edit `node_modules`, `.mercato/generated/**`, or shipped migrations.
- Run `yarn generate` after any change to discovery files, `src/modules.ts`, routes, or widgets.
- Gate after every task: `yarn generate && yarn typecheck && yarn lint`. A red build blocks everyone.
- Run `yarn db:generate` and **read** the produced SQL and snapshot. **Never migrate a database to validate.** Ask the user before applying any migration.
- Localize user-facing strings into `src/modules/deal_links/i18n/*.json` — with the one documented exception in Task 4.
- Record every shortcut inline as `// HACK(hackathon): <what, why, what breaks>`.
- Module id is `deal_links`; entity class `DealDocumentLink`; table `deal_document_links`; entity id string `deal_links:document_link`.

---

### Task 1: Module skeleton, entity, migration

Creates the module and its single table. There is no meaningful failing unit test for an ORM entity declaration, so the verification here is the **generated SQL**, read and checked against the spec's column table before anything is applied.

**Files:**
- Create: `src/modules/deal_links/index.ts`
- Create: `src/modules/deal_links/data/entities.ts`
- Modify: `src/modules.ts` (add the module to `enabledModules`)
- Generated: `src/modules/deal_links/migrations/Migration<timestamp>.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DealDocumentLink` class with properties `id: string`, `tenantId?: string | null`, `organizationId?: string | null`, `dealId: string`, `documentId: string`, `documentKind: 'quote' | 'order'`, `createdAt: Date`, `updatedAt: Date`, `deletedAt?: Date | null`. Tasks 2, 3 and 5 import it from `src/modules/deal_links/data/entities`.

- [ ] **Step 1: Write the module metadata**

Create `src/modules/deal_links/index.ts`:

```ts
import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'deal_links',
  title: 'Deal Links',
  version: '0.1.0',
  description: 'Links a CRM deal to the sales quote or order that answers it.',
  requires: ['customers'],
}
```

- [ ] **Step 2: Write the entity**

Create `src/modules/deal_links/data/entities.ts`:

```ts
import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * A deal and the sales document produced for it.
 *
 * Deliberately NOT an ORM relation in either direction: `deal_id` points into
 * `customers` and `document_id` into `sales`, and a cross-module relation would
 * couple this table to their schemas (`.ai/guides/contracts.md:10`).
 *
 * No unique index on `deal_id`. Whether a deal may carry more than one quote is
 * the calling command's policy, not the schema's, and the schema leaves both
 * options open.
 */
@Entity({ tableName: 'deal_document_links' })
@Index({
  name: 'deal_document_links_deal_idx',
  properties: ['tenantId', 'organizationId', 'dealId', 'deletedAt'],
})
export class DealDocumentLink {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string | null

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'deal_id', type: 'uuid' })
  dealId!: string

  @Property({ name: 'document_id', type: 'uuid' })
  documentId!: string

  @Property({ name: 'document_kind', type: 'text' })
  documentKind!: 'quote' | 'order'

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
```

If `Index` is not exported from `@mikro-orm/decorators/legacy`, match the import used by `node_modules/@open-mercato/core/src/modules/sales/data/entities.ts`, which declares `@Index({ name, properties })` on its own entities.

- [ ] **Step 3: Register the module**

In `src/modules.ts`, add one entry to `enabledModules`, immediately after the `catalog_seed` entry. It goes in the unconditional list, **not** the enterprise block: `rfq_intake` lives behind `OM_ENABLE_ENTERPRISE_MODULES` + `_AGENTS`, and the tab must survive those flags being off.

```ts
  { id: 'deal_links', from: '@app' },
```

- [ ] **Step 4: Regenerate discovery and typecheck**

Run: `yarn generate && yarn typecheck`
Expected: both exit 0. `grep deal_links .mercato/generated/modules.generated.ts` finds the module.

- [ ] **Step 5: Generate the migration**

Run: `yarn db:generate`
Expected: a new file under `src/modules/deal_links/migrations/`.

- [ ] **Step 6: Read the generated SQL and check it against the spec**

Run: `cat src/modules/deal_links/migrations/Migration*.ts`

Confirm the `up()` contains, for table `deal_document_links`: `id uuid` primary key defaulting to `gen_random_uuid()`, nullable `tenant_id` and `organization_id`, non-null `deal_id`, `document_id`, `document_kind`, timestamps `created_at`, `updated_at`, nullable `deleted_at`, and the index `deal_document_links_deal_idx`. Confirm it creates **no foreign key** to `customer_deals` or any `sales_*` table, and that it touches no other table.

**Do not run the migration.** Report the SQL to the user and ask before applying.

- [ ] **Step 7: Commit**

```bash
git add src/modules/deal_links src/modules.ts
git commit -m "feat(deal_links): add the deal-to-sales-document link entity"
```

---

### Task 2: The write command

The single write path. Its caller will eventually be another person's quote-creating command, which passes a payload produced by an LLM — so the scope must come from the command context and the payload's own scope keys must be ignored.

**Files:**
- Create: `src/modules/deal_links/commands/document-links.ts`
- Test: `src/modules/deal_links/__tests__/document-links-create.test.ts`

**Interfaces:**
- Consumes: `DealDocumentLink` from Task 1.
- Produces: command id `'deal_links.document_links.create'`; exported `documentLinkCreateSchema` (Zod object with `dealId: string uuid`, `documentId: string uuid`, `documentKind: 'quote' | 'order'`), exported type `DocumentLinkCreateInput`, and exported `createDocumentLinkCommand`. Task 3 references the command id and the schema.

- [ ] **Step 1: Write the failing test**

Create `src/modules/deal_links/__tests__/document-links-create.test.ts`:

```ts
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
  const ctx = {
    auth: { tenantId: overrides.tenantId ?? TENANT, orgId: overrides.organizationId ?? ORG },
    selectedOrganizationId: overrides.organizationId ?? ORG,
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/modules/deal_links`
Expected: FAIL — `Cannot find module '../commands/document-links'`.

- [ ] **Step 3: Write the command**

Create `src/modules/deal_links/commands/document-links.ts`:

```ts
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { z } from 'zod'
import { DealDocumentLink } from '../data/entities'

/**
 * Non-strict on purpose: unknown keys are STRIPPED rather than rejected. The
 * caller is another command forwarding a model-produced payload, which may carry
 * `tenantId`/`organizationId`; stripping them here is what makes it impossible to
 * write a row into someone else's scope by asking nicely.
 */
export const documentLinkCreateSchema = z.object({
  dealId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentKind: z.enum(['quote', 'order']),
})

export type DocumentLinkCreateInput = z.infer<typeof documentLinkCreateSchema>

function ensureScope(ctx: CommandRuntimeContext): { tenantId: string; organizationId: string } {
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) throw new CrudHttpError(400, { error: 'Tenant context is required' })
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (!organizationId) throw new CrudHttpError(400, { error: 'Organization context is required' })
  return { tenantId, organizationId }
}

const createDocumentLinkCommand: CommandHandler<Record<string, unknown>, DealDocumentLink> = {
  id: 'deal_links.document_links.create',
  async execute(rawInput, ctx) {
    const parsed = documentLinkCreateSchema.parse(rawInput)
    const scope = ensureScope(ctx)
    const de = ctx.container.resolve('dataEngine') as DataEngine

    // HACK(hackathon): no emitCrudSideEffects and no search indexing for link
    // rows. Nothing subscribes to them yet and nothing searches them. What breaks:
    // a future consumer wanting `deal_links.document_link.created` has to add the
    // emission here first.
    return de.createOrmEntity({
      entity: DealDocumentLink,
      data: {
        dealId: parsed.dealId,
        documentId: parsed.documentId,
        documentKind: parsed.documentKind,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      },
    })
  },
}

registerCommand(createDocumentLinkCommand)

export { createDocumentLinkCommand }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/modules/deal_links`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the gate**

Run: `yarn generate && yarn typecheck && yarn lint`
Expected: exit 0; lint reports no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/deal_links/commands src/modules/deal_links/__tests__
git commit -m "feat(deal_links): add the link create command"
```

---

### Task 3: The HTTP route

`GET` lists a deal's links so the tab can render them. `POST` exists so the link can be exercised by hand before the quote-creating command lands — it delegates to Task 2's command rather than writing directly, keeping one write path.

**Files:**
- Create: `src/modules/deal_links/api/document-links/route.ts`
- Test: `src/modules/deal_links/__tests__/document-links-route.test.ts`

**Interfaces:**
- Consumes: `DealDocumentLink` (Task 1), command id `'deal_links.document_links.create'` (Task 2).
- Produces: `GET /api/deal_links/document-links?dealId=<uuid>` returning `{ items: Array<{ id, deal_id, document_id, document_kind, created_at }>, ... }`, and `POST /api/deal_links/document-links` accepting `{ dealId, documentId, documentKind }` and returning `{ id }` with status 201. Task 4's widget calls both.

- [ ] **Step 1: Write the failing test**

This test pins the route's *configuration* — the contract that is easy to break by accident and cheap to assert without booting Next.js.

Create `src/modules/deal_links/__tests__/document-links-route.test.ts`:

```ts
import { describe, expect, it, jest } from '@jest/globals'

jest.mock('@open-mercato/shared/lib/commands', () => ({
  registerCommand: jest.fn(),
}))

import { metadata } from '../api/document-links/route'

describe('deal document links route', () => {
  it('requires authentication on every exposed method', () => {
    expect(metadata.GET?.requireAuth).toBe(true)
    expect(metadata.POST?.requireAuth).toBe(true)
  })

  /**
   * Reading a deal's links is reading the deal. Writing one is changing it. The
   * two features already exist upstream (`customers/acl.ts:17,23`), so the link
   * surface introduces no new grant of its own.
   */
  it('gates reads behind deal view and writes behind deal manage', () => {
    expect(metadata.GET?.requireFeatures).toEqual(['customers.deals.view'])
    expect(metadata.POST?.requireFeatures).toEqual(['customers.deals.manage'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/modules/deal_links/__tests__/document-links-route.test.ts`
Expected: FAIL — `Cannot find module '../api/document-links/route'`.

- [ ] **Step 3: Write the route**

Create `src/modules/deal_links/api/document-links/route.ts`. The `makeCrudRoute` call is modelled on `src/modules/example/api/todos/route.ts:240-376`; the OpenAPI block uses the types in `@open-mercato/shared/lib/openapi/types.ts:29-52`.

```ts
import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { DealDocumentLink } from '../../data/entities'
import { documentLinkCreateSchema } from '../../commands/document-links'

const ENTITY_ID = 'deal_links:document_link' as const

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
  metadata: {
    GET: { requireAuth: true, requireFeatures: ['customers.deals.view'] },
    POST: { requireAuth: true, requireFeatures: ['customers.deals.manage'] },
  },
  orm: {
    entity: DealDocumentLink,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  list: {
    schema: querySchema,
    entityId: ENTITY_ID,
    fields: () => ['id', 'deal_id', 'document_id', 'document_kind', 'created_at'],
    sortFieldMap: { created_at: 'created_at' },
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
```

If `makeCrudRoute`'s destructured exports do not typecheck because the factory always returns `PUT`/`DELETE`, destructure only what exists and re-export nothing else — the file must export exactly `metadata`, `GET`, `POST`, `openApi`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/modules/deal_links`
Expected: PASS, 6 tests total across both files.

- [ ] **Step 5: Run the gate**

Run: `yarn generate && yarn typecheck && yarn lint`
Expected: exit 0. `grep -r "deal_links" .mercato/generated/api-route-metadata.generated.ts` finds the route.

- [ ] **Step 6: Commit**

```bash
git add src/modules/deal_links/api src/modules/deal_links/__tests__
git commit -m "feat(deal_links): expose the link list and create route"
```

---

### Task 4: The deal detail tab

A throwaway probe module, `deal_quote_tab`, already established that this injection host works and that its label is rendered verbatim. The probe has been deleted; its findings survive as the comments and the label test reproduced below. Nothing from it needs removing.

**Files:**
- Create: `src/modules/deal_links/widgets/injection-table.ts`
- Create: `src/modules/deal_links/widgets/injection/deal-documents/widget.ts`
- Create: `src/modules/deal_links/widgets/injection/deal-documents/widget.client.tsx`
- Create: `src/modules/deal_links/i18n/pl.json`, `en.json`, `de.json`, `es.json`, `ko.json`
- Create: `src/modules/deal_links/__tests__/injection-table.test.ts`

**Interfaces:**
- Consumes: `GET /api/deal_links/document-links?dealId=<uuid>` (Task 3).
- Produces: injection widget id `'deal_links.injection.deal-documents'` on spot `'detail:customers.deal:tabs'`, group id `'deal-documents'`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/deal_links/__tests__/injection-table.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { injectionTable } from '../widgets/injection-table'

const DEAL_TABS_SPOT = 'detail:customers.deal:tabs'
// A dotted, lowercase-prefixed token such as `deal_links.tab.label`.
const I18N_KEY_SHAPE = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/

describe('deal detail tab placement', () => {
  it('declares one tab on the deal detail host', () => {
    const slots = injectionTable[DEAL_TABS_SPOT]
    expect(Array.isArray(slots)).toBe(true)
    expect(slots).toHaveLength(1)
  })

  /**
   * Regression oracle for the asymmetry documented in `widgets/injection-table.ts`:
   * the deal host renders `groupLabel` verbatim, while its person and sales
   * siblings pass it through `t()`. An i18n key here reaches the DOM raw.
   *
   * If a customers upgrade adds `t()` to `useDealInjectedTabs`, delete this test
   * together with the literal, in favour of the key `i18n/*.json` already carries.
   */
  it('uses display text for the tab label, not an i18n key', () => {
    const slots = injectionTable[DEAL_TABS_SPOT]
    const slot = (Array.isArray(slots) ? slots[0] : slots) as { groupLabel?: string }
    expect(slot.groupLabel).toBeTruthy()
    expect(slot.groupLabel).not.toMatch(I18N_KEY_SHAPE)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/modules/deal_links/__tests__/injection-table.test.ts`
Expected: FAIL — `Cannot find module '../widgets/injection-table'`.

- [ ] **Step 3: Write the injection table**

Create `src/modules/deal_links/widgets/injection-table.ts`:

```ts
import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Declared as ONE plain object literal with no branching: the fact extractor can
 * only fold a statically known value, so a computed export would publish zero
 * contributions.
 */
export const injectionTable: ModuleInjectionTable = {
  // HACK(hackathon): `detail:customers.deal:tabs` is read by
  // `customers/backend/customers/deals/[id]/hooks/useDealInjectedTabs.tsx:28` but is
  // NOT declared in `customers/extension-points.ts` (which lists only dealHeader,
  // dealStatusBadges, dealFooter) nor in the module's umes-hosts facts. It has no
  // FROZEN status, so a customers upgrade may rename or drop it and this tab then
  // silently disappears — nothing else breaks.
  'detail:customers.deal:tabs': [
    {
      widgetId: 'deal_links.injection.deal-documents',
      kind: 'tab',
      groupId: 'deal-documents',
      // HACK(hackathon): display text, NOT an i18n key, because this host alone
      // renders `groupLabel` verbatim — `useDealInjectedTabs.tsx:38` resolves it as
      // `groupLabel ?? metadata.title ?? tabId` with no `t()`, and the tab bar
      // (`customers/components/detail/DealDetailTabs.tsx:108`) passes it straight to
      // the DOM. Its siblings DO translate: person detail calls
      // `t(groupLabel, groupLabel)` (`people-v2/[id]/page.tsx:312`) and sales calls
      // `t(groupLabel, metadata.title)` (`sales/backend/sales/documents/[id]/page.tsx:4016`).
      // What breaks: this label stays Polish in every locale. The translations are
      // already in `i18n/*.json` under `deal_links.tab.label`; once upstream adds
      // `t()` here, swap the literal back for that key and drop the test that guards
      // this line. The widget body is unaffected — it translates through `useT`.
      groupLabel: 'Wycena',
      priority: -10,
    },
  ],
}

export default injectionTable
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/modules/deal_links/__tests__/injection-table.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the widget module**

Create `src/modules/deal_links/widgets/injection/deal-documents/widget.ts`:

```ts
import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import DealDocumentsWidget from './widget.client'

// No `features` gate here: the route already enforces `customers.deals.view`, and
// a widget-level gate would only make a missing grant look like a broken host.
const widget: InjectionWidgetModule<{ dealId?: string }> = {
  metadata: {
    id: 'deal_links.injection.deal-documents',
    title: 'Deal documents',
    description: 'Lists the quotes and orders linked to this deal.',
    enabled: true,
    requiredModules: ['customers'],
  },
  Widget: DealDocumentsWidget,
}

export default widget
```

- [ ] **Step 6: Write the widget client**

Create `src/modules/deal_links/widgets/injection/deal-documents/widget.client.tsx`. Fetching follows `src/modules/example/widgets/injection/sales-todos/widget.client.tsx`.

```tsx
"use client"

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'

type WidgetContext = { dealId?: string }

type LinkRow = {
  id: string
  document_id: string
  document_kind: string
  created_at?: string
}

export default function DealDocumentsWidget({ context }: InjectionWidgetComponentProps<WidgetContext>) {
  const t = useT()
  const dealId = context?.dealId ?? null
  const [items, setItems] = React.useState<LinkRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    if (!dealId) {
      setLoading(false)
      return () => { cancelled = true }
    }
    setLoading(true)
    setError(null)
    readApiResultOrThrow<{ items?: LinkRow[] }>(
      `/api/deal_links/document-links?dealId=${encodeURIComponent(dealId)}`,
    )
      .then((payload) => {
        if (cancelled) return
        setItems(payload?.items ?? [])
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [dealId])

  if (loading) {
    return <div className="text-sm text-muted-foreground">{t('deal_links.state.loading', 'Loading…')}</div>
  }
  if (error) {
    return <div className="text-sm text-destructive">{t('deal_links.state.error', 'Could not load the linked documents.')}</div>
  }
  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        {t('deal_links.state.empty', 'No quote has been produced for this case yet.')}
      </div>
    )
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-3 rounded border px-3 py-2">
          <span className="text-xs uppercase text-muted-foreground">
            {item.document_kind === 'order'
              ? t('deal_links.kind.order', 'Order')
              : t('deal_links.kind.quote', 'Quote')}
          </span>
          <a
            className="text-sm underline"
            href={`/backend/sales/${item.document_kind === 'order' ? 'orders' : 'quotes'}/${item.document_id}`}
          >
            {item.document_id}
          </a>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 7: Write the translations**

Create `src/modules/deal_links/i18n/pl.json`:

```json
{
  "deal_links.kind.order": "Zamówienie",
  "deal_links.kind.quote": "Wycena",
  "deal_links.state.empty": "Do tej sprawy nie powstała jeszcze żadna wycena.",
  "deal_links.state.error": "Nie udało się wczytać powiązanych dokumentów.",
  "deal_links.state.loading": "Wczytywanie…",
  "deal_links.tab.label": "Wycena"
}
```

Create `src/modules/deal_links/i18n/en.json`:

```json
{
  "deal_links.kind.order": "Order",
  "deal_links.kind.quote": "Quote",
  "deal_links.state.empty": "No quote has been produced for this case yet.",
  "deal_links.state.error": "Could not load the linked documents.",
  "deal_links.state.loading": "Loading…",
  "deal_links.tab.label": "Quote"
}
```

Then copy the English file to the three remaining locales:

```bash
for loc in de es ko; do cp src/modules/deal_links/i18n/en.json "src/modules/deal_links/i18n/$loc.json"; done
```

- [ ] **Step 8: Run the gate**

Run: `yarn generate && yarn typecheck && yarn lint && yarn test src/modules/deal_links`
Expected: all exit 0, 8 tests across three files.

- [ ] **Step 9: Verify in the running app**

Open a deal at `/backend/customers/deals/<id>`, select the **Wycena** tab, and confirm the empty state renders. Then create a link by hand against any existing quote id and confirm the row appears after a reload:

```bash
curl -X POST http://localhost:3000/api/deal_links/document-links \
  -H 'content-type: application/json' \
  -b '<your session cookie>' \
  -d '{"dealId":"<deal uuid>","documentId":"<quote uuid>","documentKind":"quote"}'
```

- [ ] **Step 10: Commit**

```bash
git add src/modules/deal_links
git commit -m "feat(deal_links): show linked sales documents on the deal detail page"
```

---

### Task 5: Follow a quote into its order

`sales.quotes.convert_to_order` emits no event — its body (`sales/commands/documents.ts:6368-7117`) contains no `emitCrudSideEffects` and no `eventBus`, only the audit entry `sales.audit.quotes.convert`. A command interceptor is therefore the only seam, and it is a better one than an event would have been: it sits on the command, so it catches every caller.

**Files:**
- Create: `src/modules/deal_links/commands/interceptors.ts`
- Test: `src/modules/deal_links/__tests__/convert-interceptor.test.ts`

**Interfaces:**
- Consumes: `DealDocumentLink` (Task 1).
- Produces: exported `interceptors: CommandInterceptor[]` containing one entry with id `'deal_links.link-converted-order'` targeting `'sales.quotes.convert_to_order'`. The file name is the auto-discovery convention — no DI registration (see `node_modules/@open-mercato/core/src/modules/communication_channels/commands/interceptors.ts:25`).

- [ ] **Step 1: Write the failing test**

Create `src/modules/deal_links/__tests__/convert-interceptor.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/modules/deal_links/__tests__/convert-interceptor.test.ts`
Expected: FAIL — `Cannot find module '../commands/interceptors'`.

- [ ] **Step 3: Write the interceptor**

Create `src/modules/deal_links/commands/interceptors.ts`:

```ts
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandInterceptor } from '@open-mercato/shared/lib/commands/command-interceptor'
import { DealDocumentLink } from '../data/entities'

/**
 * Carries a deal link across the quote → order conversion.
 *
 * `sales.quotes.convert_to_order` emits NO event — its body
 * (`sales/commands/documents.ts:6368-7117`) writes an audit entry and nothing else —
 * so there is nothing to subscribe to. Intercepting the command instead of its
 * callers means every conversion is caught: staff UI, API, or agent alike.
 *
 * Auto-discovered by the `commands/interceptors.ts` convention; no DI registration.
 */
export const interceptors: CommandInterceptor[] = [
  {
    id: 'deal_links.link-converted-order',
    targetCommand: 'sales.quotes.convert_to_order',
    priority: 50,
    async afterExecute(input, result, ctx) {
      const quoteId = (input as { quoteId?: unknown } | null)?.quoteId
      const orderId = (result as { orderId?: unknown } | null)?.orderId
      if (typeof quoteId !== 'string' || typeof orderId !== 'string') return

      // Fail closed: an unscoped lookup here would search every tenant's links.
      const tenantId = ctx.auth?.tenantId ?? null
      const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
      if (!tenantId || !organizationId) return

      const em = (ctx.container.resolve('em') as EntityManager).fork()

      const source = await em.findOne(DealDocumentLink, {
        documentId: quoteId,
        documentKind: 'quote',
        tenantId,
        organizationId,
        deletedAt: null,
      })
      // The quote did not come from a deal. Not our business.
      if (!source) return

      const existing = await em.findOne(DealDocumentLink, {
        documentId: orderId,
        documentKind: 'order',
        tenantId,
        organizationId,
        deletedAt: null,
      })
      if (existing) return

      em.persist(
        em.create(DealDocumentLink, {
          dealId: source.dealId,
          documentId: orderId,
          documentKind: 'order',
          tenantId,
          organizationId,
        }),
      )
      await em.flush()
    },
  },
]

export default interceptors
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/modules/deal_links`
Expected: PASS, 14 tests across four files.

- [ ] **Step 5: Determine whether `afterExecute` runs before or after commit**

`AGENTS.md` requires effects to stay post-commit, and the convert command holds the quote status flip and the order materialization in one transaction. Find out which side of the commit this hook lands on, rather than assuming:

Run: `grep -n "afterExecute" node_modules/@open-mercato/shared/src/lib/commands/command-interceptor-runner.ts node_modules/@open-mercato/shared/src/lib/commands/command-bus.ts`

Read the surrounding code and establish whether the hook is invoked inside the command's transaction or after it returns. Record the answer as a comment in `interceptors.ts`. If it runs **inside** the transaction, note that the link write is atomic with the conversion and say so explicitly in the comment; if it runs **after**, note that a crash between commit and hook leaves the order unlinked, and add a `HACK(hackathon)` line stating that no reconciliation exists.

- [ ] **Step 6: Run the gate**

Run: `yarn generate && yarn typecheck && yarn lint`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/modules/deal_links/commands/interceptors.ts src/modules/deal_links/__tests__/convert-interceptor.test.ts
git commit -m "feat(deal_links): carry the deal link across quote-to-order conversion"
```

---

## Final verification

- [ ] **Run the full gate**

Run: `yarn generate && yarn typecheck && yarn lint && yarn test`
Expected: all exit 0.

- [ ] **Run the integration suite**

The diff adds an entity, a route, and scoping logic, which `AGENTS.md` makes conditional-mandatory.

Run: `yarn test:integration:ephemeral`

- [ ] **Confirm the working tree is clean**

Run: `git status`
Expected: nothing but intended files; no `.env`, no secret, no `.mercato/generated` artifact staged.

- [ ] **Hand the interface to the quote command's author**

They need exactly three things, and nothing about our schema:

- command id `deal_links.document_links.create`
- input `{ dealId: uuid, documentId: uuid, documentKind: 'quote' | 'order' }`
- scope is taken from the command context; any `tenantId` / `organizationId` in the payload is stripped

- [ ] **Update the research note**

`.ai/notes/deal-quote-tab.md` still describes the probe module and lists open questions this plan answers. Replace the "Sonda osadzania" section with a pointer to `.ai/specs/2026-09-19-deal-document-links.md`, and strike the resolved entries from "Otwarte" — the cardinality question stays open by design.

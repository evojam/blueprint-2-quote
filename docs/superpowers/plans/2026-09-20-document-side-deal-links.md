# Document-Side Deal Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror the deal-side linking tab onto the sales document detail page, so a quote or an order shows the deals it answers and can attach one.

**Architecture:** One injection widget registered under both `sales.document.detail.quote:tabs` and `sales.document.detail.order:tabs` — quotes and orders share a single detail component, so one widget serves both. It reads `GET /api/deal_links/document-links?documentId=<id>`, which needs one additive optional query parameter. The filter builder moves into `lib/` so it is testable; everything else reuses modules that already exist.

**Tech Stack:** Next.js app router, React 19, `@open-mercato/ui/backend` (`ComboboxInput`, injection widgets), Zod, Jest (`testEnvironment: 'node'`), TypeScript.

**Spec:** `.ai/specs/2026-09-20-document-side-deal-links.md`

## Global Constraints

- **One contract change only**, and it is additive: an optional `documentId` query parameter on `GET /api/deal_links/document-links`. Nothing else in `data/entities.ts`, `commands/document-links.ts`, `commands/interceptors.ts` or `lib/route-access.ts` may change. No migration.
- **Never edit** `node_modules/**` or `.mercato/generated/**` by hand.
- **Do not touch the deal-side tab** (`widgets/injection/deal-documents/`). Its known defects are deliberately out of scope for this slice and belong to a separate PR.
- **Scope comes from the session**, never from a request body. The create payload is exactly `dealId`, `documentId`, `documentKind`.
- **Every user-facing string** through `t(key, fallback)`. Locale files `i18n/{en,pl,de,es,ko}.json` keep identical, alphabetically sorted key sets, real Polish in `pl.json`, English mirrored in `de/es/ko`.
- **Jest runs `testEnvironment: 'node'`** — no React rendering, no jsdom, no `@testing-library`. The widget cannot be unit-tested; coverage goes on the pure modules.
- **Never import the route file in a test.** It pulls `makeCrudRoute` → MikroORM's Postgres driver → ESM-only `kysely`, which this Node cannot `require`. That is why filter logic moves to `lib/`.
- **Hackathon Mode:** shortcuts recorded inline as `// HACK(hackathon): <what, why, what breaks>`.

## Reference: shapes this plan depends on

```ts
// The tab injection context the sales document detail page publishes
// (sales/backend/sales/documents/[id]/page.tsx:1975-1984)
type DocumentDetailContext = {
  kind: 'quote' | 'order'
  record: { id?: string; updatedAt?: string } | null
  formId: string
  resourceKind: string      // `sales.quote` | `sales.order`
  resourceId?: string       // the document's id
  retryLastMutation: unknown
}

// GET /api/customers/deals?ids=a,b → snake_case items
type DealListResponse = { items: Array<{ id: string; title: string | null }> }
```

Deal detail href: `/backend/customers/deals/<id>`.

---

### Task 1: The `documentId` filter

**Files:**
- Create: `src/modules/deal_links/lib/document-links-filters.ts`
- Create: `src/modules/deal_links/__tests__/document-links-filters.test.ts`
- Modify: `src/modules/deal_links/api/document-links/route.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DocumentLinkListQuery = { dealId?: string; documentId?: string }`
  - `function buildDocumentLinkFilters(query: DocumentLinkListQuery): Record<string, unknown>`

- [ ] **Step 1: Write the failing test**

Create `src/modules/deal_links/__tests__/document-links-filters.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { buildDocumentLinkFilters } from '../lib/document-links-filters'

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/modules/deal_links/__tests__/document-links-filters.test.ts`
Expected: FAIL — `Cannot find module '../lib/document-links-filters'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/deal_links/lib/document-links-filters.ts`:

```ts
/**
 * Filter builder for `api/document-links/route.ts`'s list, pulled out of the route
 * file so it can be imported and asserted on without dragging in `makeCrudRoute`
 * (and, transitively, MikroORM's Postgres driver and the ESM-only `kysely`
 * package) at module load time — the same reason `lib/route-access.ts` exists.
 * See the HACK note on `../__tests__/document-links-route.test.ts`.
 */
export type DocumentLinkListQuery = {
  dealId?: string
  documentId?: string
}

/**
 * Both filters are optional and independent. Supplying neither yields an empty
 * filter set, which is byte-identical to the behaviour before `documentId`
 * existed — the additive-change guarantee in
 * `.ai/specs/2026-09-20-document-side-deal-links.md`. Supplying both narrows to
 * the single row joining that deal to that document.
 */
export function buildDocumentLinkFilters(
  query: DocumentLinkListQuery,
): Record<string, unknown> {
  const filters: Record<string, unknown> = {}
  if (query.dealId) filters.deal_id = query.dealId
  if (query.documentId) filters.document_id = query.documentId
  return filters
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/modules/deal_links/__tests__/document-links-filters.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the route**

In `src/modules/deal_links/api/document-links/route.ts`:

Add `documentId` to `querySchema`, directly under `dealId`:

```ts
  documentId: z.string().uuid().optional(),
```

Replace the inline `buildFilters` with the shared builder:

```ts
    buildFilters: async (q: Query) => buildDocumentLinkFilters(q),
```

and import it:

```ts
import { buildDocumentLinkFilters } from '../../lib/document-links-filters'
```

Then update the `openApi` GET block so the published contract documents the new
parameter — its `query: querySchema` already picks it up, but the prose must match:

```ts
      description:
        'Returns the links recorded for one deal, for one sales document, or for one deal-document pair, newest first. Supplying neither filter lists every link in scope.',
```

- [ ] **Step 6: Run the gate**

Run: `yarn generate && yarn typecheck && yarn lint && yarn test`
Expected: all exit 0. The existing `document-links-route.test.ts` asserts route ACL metadata only and must still pass untouched.

- [ ] **Step 7: Commit**

```bash
git add src/modules/deal_links/lib/document-links-filters.ts \
        src/modules/deal_links/__tests__/document-links-filters.test.ts \
        src/modules/deal_links/api/document-links/route.ts
git commit -m "$(cat <<'MSG'
feat(deal_links): let the link list filter by document

The route could answer "which documents does this deal have?" but not the
reverse, which is what a tab on the document needs. The parameter is optional
and the filter is installed only when it is supplied, so a caller that omits
it sees byte-identical behaviour.
MSG
)"
```

---

### Task 2: The deal option loader

**Files:**
- Create: `src/modules/deal_links/lib/deal-options.ts`
- Create: `src/modules/deal_links/__tests__/deal-options.test.ts`

**Interfaces:**
- Consumes: `buildSearchParams`, `type ListFetcher`, `type DocumentOption` from `../lib/document-options`.
- Produces: `async function loadDealOptions(query: string | undefined, t: TranslateFn, fetchList: ListFetcher): Promise<DocumentOption[]>`

- [ ] **Step 1: Write the failing test**

Create `src/modules/deal_links/__tests__/deal-options.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals'
import { loadDealOptions } from '../lib/deal-options'
import { OPTION_PAGE_SIZE, type ListFetcher } from '../lib/document-options'

const DEAL_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

const t = ((key: string, fallback?: unknown) =>
  typeof fallback === 'string' ? fallback : key) as never

function fetcherFor(
  response: unknown,
  calls?: Array<{ path: string; params: Record<string, string> }>,
): ListFetcher {
  return (async (path: string, params: Record<string, string>) => {
    calls?.push({ path, params })
    if (response instanceof Error) throw response
    return response
  }) as ListFetcher
}

describe('loadDealOptions', () => {
  it('maps deals to id-and-title options', async () => {
    const options = await loadDealOptions(
      undefined,
      t,
      fetcherFor({ items: [{ id: DEAL_ID, title: 'Kitchen refit' }] }),
    )
    expect(options).toEqual([{ value: DEAL_ID, label: 'Kitchen refit' }])
  })

  it('queries the deals list with the shared search params', async () => {
    const calls: Array<{ path: string; params: Record<string, string> }> = []
    await loadDealOptions(' refit ', t, fetcherFor({ items: [] }, calls))
    expect(calls).toEqual([
      { path: 'customers/deals', params: { pageSize: String(OPTION_PAGE_SIZE), search: 'refit' } },
    ])
  })

  it('omits the search param for an empty query', async () => {
    const calls: Array<{ path: string; params: Record<string, string> }> = []
    await loadDealOptions('   ', t, fetcherFor({ items: [] }, calls))
    expect(calls[0]?.params).toEqual({ pageSize: String(OPTION_PAGE_SIZE) })
  })

  // A deal with no title still has to be pickable — its id is what gets linked.
  it('falls back to a placeholder label when a deal has no title', async () => {
    const options = await loadDealOptions(
      undefined,
      t,
      fetcherFor({ items: [{ id: DEAL_ID, title: '   ' }] }),
    )
    expect(options).toEqual([{ value: DEAL_ID, label: 'Untitled deal' }])
  })

  // There is exactly one source here, so there is nothing to degrade to: a
  // failure must reach the caller rather than render as "no matches".
  it('propagates a failure instead of swallowing it', async () => {
    await expect(loadDealOptions(undefined, t, fetcherFor(new Error('boom')))).rejects.toThrow(
      'boom',
    )
  })

  it('tolerates a response with no items array', async () => {
    expect(await loadDealOptions(undefined, t, fetcherFor({}))).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/modules/deal_links/__tests__/deal-options.test.ts`
Expected: FAIL — `Cannot find module '../lib/deal-options'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/deal_links/lib/deal-options.ts`:

```ts
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { buildSearchParams, type DocumentOption, type ListFetcher } from './document-options'

type DealItem = { id: string; title: string | null }

/**
 * Deal options for the picker on the sales document tab.
 *
 * Unlike `loadDocumentOptions` there is only one source, so there is no half to
 * degrade: a failure propagates to the caller rather than rendering as an empty
 * dropdown.
 *
 * HACK(hackathon): when tenant data encryption is on, the deals route collapses
 * any `search` to "no matches" rather than scanning ciphertext
 * (`customers/api/deals/route.ts:338`). What breaks: on such a tenant this
 * picker only ever shows the unfiltered first page, and typing empties it — so
 * a deal outside that page cannot be linked from the document side at all.
 */
export async function loadDealOptions(
  query: string | undefined,
  t: TranslateFn,
  fetchList: ListFetcher,
): Promise<DocumentOption[]> {
  const data = await fetchList<DealItem>('customers/deals', buildSearchParams(query))
  return (data?.items ?? []).map((item) => ({
    value: item.id,
    label: item.title?.trim() || t('deal_links.documentTab.untitledDeal', 'Untitled deal'),
  }))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/modules/deal_links/__tests__/deal-options.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the gate and commit**

Run: `yarn typecheck && yarn lint && yarn test`

```bash
git add src/modules/deal_links/lib/deal-options.ts src/modules/deal_links/__tests__/deal-options.test.ts
git commit -m "$(cat <<'MSG'
feat(deal_links): search deals for the document-side picker

Reuses the shared search-param builder so both pickers query their list the
same way. One source, so a failure propagates rather than degrading.
MSG
)"
```

---

### Task 3: The tab on the sales document

**Files:**
- Create: `src/modules/deal_links/widgets/injection/document-deals/widget.ts`
- Create: `src/modules/deal_links/widgets/injection/document-deals/widget.client.tsx`
- Modify: `src/modules/deal_links/widgets/injection-table.ts`
- Modify: `src/modules/deal_links/i18n/{en,pl,de,es,ko}.json`

**Interfaces:**
- Consumes: `loadDealOptions` (Task 2); `collectLookupIds`, `fetchLabelMaps`, `applyLinkLabels`, `type LinkRow` from `../../../lib/link-labels`.
- Produces: widget id `deal_links.injection.document-deals`.

- [ ] **Step 1: Add the i18n keys**

Add to `en.json`, alphabetically sorted (same English in `de/es/ko`):

```json
{
  "deal_links.documentTab.empty": "No deal is linked to this document yet.",
  "deal_links.documentTab.error": "Could not load the linked deals.",
  "deal_links.documentTab.label": "Deals",
  "deal_links.documentTab.link.error": "Could not link the deal.",
  "deal_links.documentTab.link.placeholder": "Search deals by title…",
  "deal_links.documentTab.link.submit": "Link",
  "deal_links.documentTab.link.title": "Link a deal",
  "deal_links.documentTab.summary.one": "{count} linked deal",
  "deal_links.documentTab.summary.other": "{count} linked deals",
  "deal_links.documentTab.title": "Linked deals",
  "deal_links.documentTab.unresolved": "not found",
  "deal_links.documentTab.untitledDeal": "Untitled deal"
}
```

And to `pl.json`:

```json
{
  "deal_links.documentTab.empty": "Do tego dokumentu nie jest jeszcze powiązany żaden deal.",
  "deal_links.documentTab.error": "Nie udało się wczytać powiązanych deali.",
  "deal_links.documentTab.label": "Deale",
  "deal_links.documentTab.link.error": "Nie udało się powiązać deala.",
  "deal_links.documentTab.link.placeholder": "Szukaj deali po tytule…",
  "deal_links.documentTab.link.submit": "Powiąż",
  "deal_links.documentTab.link.title": "Powiąż deal",
  "deal_links.documentTab.summary.one": "{count} powiązany deal",
  "deal_links.documentTab.summary.other": "Powiązane deale: {count}",
  "deal_links.documentTab.title": "Powiązane deale",
  "deal_links.documentTab.unresolved": "nie znaleziono",
  "deal_links.documentTab.untitledDeal": "Deal bez tytułu"
}
```

- [ ] **Step 2: Register the widget**

Create `src/modules/deal_links/widgets/injection/document-deals/widget.ts`:

```ts
import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import DocumentDealsWidget from './widget.client'

// No `features` gate: the host page already enforces the sales document's own view
// grant, and a widget-level gate would hide the LIST from users entitled to read it
// just because they cannot write. A missing write grant surfaces as a 403 on use.
const widget: InjectionWidgetModule<{ resourceId?: string }> = {
  metadata: {
    id: 'deal_links.injection.document-deals',
    title: 'Linked deals',
    description: 'Lists the deals linked to this quote or order, and links another.',
    enabled: true,
    requiredModules: ['customers', 'sales'],
  },
  Widget: DocumentDealsWidget,
}

export default widget
```

Add to `src/modules/deal_links/widgets/injection-table.ts`, leaving the existing
`detail:customers.deal:tabs` entry exactly as it is:

```ts
  // `sales.document.detail.{kind}:tabs` IS declared — `sales/extension-points.ts:21-30`
  // publishes it with `kind: ^(order|quote)$` and `surface: ^(tabs|details)$`, and
  // `sales/backend/sales/documents/[id]/page.tsx:4002` resolves and reads it. Unlike
  // the customers spot above, this one is a published host, and it translates
  // `groupLabel` through `t()` (`page.tsx:4016`), so the label below is an i18n key
  // rather than a literal.
  'sales.document.detail.quote:tabs': [
    {
      widgetId: 'deal_links.injection.document-deals',
      kind: 'tab',
      groupId: 'document-deals',
      groupLabel: 'deal_links.documentTab.label',
      priority: -10,
    },
  ],
  'sales.document.detail.order:tabs': [
    {
      widgetId: 'deal_links.injection.document-deals',
      kind: 'tab',
      groupId: 'document-deals',
      groupLabel: 'deal_links.documentTab.label',
      priority: -10,
    },
  ],
```

- [ ] **Step 3: Write the widget**

Create `src/modules/deal_links/widgets/injection/document-deals/widget.client.tsx`. Follow
the deal-side widget's structure and the installed
`customers/components/detail/DealLinkedEntitiesTab.tsx` class strings — read BOTH before
writing. Differences that matter:

1. **The context field is `resourceId`, not `dealId`** (`sales/backend/sales/documents/[id]/page.tsx:1975-1984`).
2. **The list request is `?documentId=<id>`**, the parameter Task 1 added.
3. **The picker searches deals** via `loadDealOptions`, and each option's value is a plain
   deal uuid — no `kind:uuid` encoding, because there is only one kind of thing to pick.
4. **`allowCustomValues={false}` MUST be passed** to `ComboboxInput`. Its default is `true`
   (`@open-mercato/ui/src/backend/inputs/ComboboxInput.tsx:79`), which commits typed text
   that matches no option; the Link button would then arm and silently do nothing. The
   deal-side tab has exactly that defect and this one must not reproduce it. Gate the
   button on the value too: `disabled={!isLikelyUuid(selected) || linking || !documentId}`.
5. **Labels come from the deals half** of `fetchLabelMaps`. Skip the documents half — pass
   `{ ...collectLookupIds(rows), quoteIds: [], orderIds: [] }` so no needless
   `/api/sales/*` request is issued.
6. **The create payload** carries the document's own kind from context:
   `{ dealId: selected, documentId, documentKind: kind }`.

Keep from the deal-side widget: the `requestRef` counter guard, the reset-on-id-change
effect, clearing the selection only on success, and a `HACK(hackathon)` note stating that
the picker renders for anyone who can see the tab because the framework has no
client-side permission hook.

- [ ] **Step 4: Regenerate and run the gate**

Run: `yarn generate && yarn typecheck && yarn lint && yarn test`
Then: `yarn i18n:check-hardcoded && yarn ds:check`
Expected: all exit 0.

If `ds:check` objects to a literal class string copied verbatim from the installed
component, add a scoped `.ds-check-ignore` entry naming file, rule, exact match and the
source it was copied from — the precedent set for `sm:w-[260px]` in the deal-side tab.

- [ ] **Step 5: Commit**

```bash
git add src/modules/deal_links/widgets src/modules/deal_links/i18n
git commit -m "$(cat <<'MSG'
feat(deal_links): show and link deals from the sales document

A quote or an order now carries a Deals tab: which cases it answers, and a
picker to attach another. One widget serves both kinds, because both detail
pages are the same component behind different `initialKind` wrappers.
MSG
)"
```

---

### Task 4: Document the surface and run the preflight

**Files:**
- Modify: `src/modules/deal_links/README.md`

- [ ] **Step 1: Update the README**

In the surfaces table, add a row for the new tab next to the existing deal-side one, and
under the linking section state that a document may carry several deals and that the
picker searches deals by title.

Add to Known gaps:

```markdown
- **Encrypted tenants cannot use the document-side picker.** The deals route collapses a
  `search` to "no matches" when tenant data encryption is on, so only the unfiltered first
  page of deals is reachable from a quote or an order.
```

Keep every existing Known-gaps bullet.

- [ ] **Step 2: Run the full preflight**

```bash
yarn generate && yarn typecheck && yarn lint && yarn test && yarn build
yarn ds:check && yarn i18n:check-hardcoded
```

`yarn test:integration:ephemeral` IS warranted here and should be attempted — this slice
changes an API route's query contract. If the ephemeral environment cannot start in this
checkout, say so plainly in the report rather than skipping it silently.

- [ ] **Step 3: Confirm the tree is clean and commit**

```bash
git status --short
git add src/modules/deal_links/README.md
git commit -m "$(cat <<'MSG'
docs(deal_links): record the document-side tab

MSG
)"
```

## Plan self-review

| Requirement | Task |
|---|---|
| REQ-001 tab lists linked deals with titles and links | Tasks 1 + 3 |
| REQ-002 links a deal, several allowed | Tasks 2 + 3 |
| REQ-003 both document kinds | Task 3 (two injection-table entries, one widget) |
| REQ-004 linked-entities layout | Task 3 |
| REQ-005 unresolved id degrades visibly | Task 3 (step 3, item 5) |
| REQ-006 typed-but-unmatched text cannot arm Link | Task 3 (step 3, item 4) |
| Migration & Backward Compatibility | Task 1 (optional param, filter installed only when supplied; `document-links-filters.test.ts` pins the empty case) |

**Type consistency:** `ListFetcher`, `DocumentOption`, `buildSearchParams` and
`OPTION_PAGE_SIZE` are defined once in `lib/document-options.ts` and imported by
`lib/deal-options.ts` (Task 2) and the widget (Task 3). `buildDocumentLinkFilters` is
defined in Task 1 and consumed only by the route.

**Known plan-level risk:** nothing else in this checkout registers into
`sales.document.detail.*:tabs`, so Task 3 is its first use. It is a declared host read by
the page, but if the widget does not appear, the injection-table key spelling is the first
thing to check.

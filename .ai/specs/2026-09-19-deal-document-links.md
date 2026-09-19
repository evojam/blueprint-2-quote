# Deal ↔ Sales Document Links

**Date**: 2026-09-19
**Status**: Ready for implementation
**Mode**: Hackathon — lean spec, see `AGENTS.md` Hackathon Mode

## TLDR

A CRM deal and the quote (or order) that answers it have no connection today. Add one app-owned module, `deal_links`, that owns a single linking record: `deal_id` + `document_id` + `document_kind`. It ships with the command that writes a link, a CRUD route that reads and writes it over HTTP, a tab on the deal detail page that shows the links, and a command interceptor that follows a quote into the order it converts into.

The command that creates the quote itself is **out of scope** — another person owns it. This slice delivers the interface that command will call.

## Problem Statement

`sales_quotes` has no `deal_id`, `CustomerDeal` has no `metadata` column, and no code in `src/` creates a `SalesQuote`. A deal detail page therefore cannot answer "was a quote ever produced for this case?".

Two directions were rejected during research. Storing `dealId` in the quote's `metadata` fails on read: `sales/api/documents/factory.ts` keeps `metadata` in `detailOnlyProjectionFields`, so listing never returns it and "find quotes for this deal" degenerates into fetching every candidate by id and filtering in memory. Storing the reference in a deal custom field caps the relation at whatever a single field can hold and cannot express the quote → deal direction.

A separate linking record costs one migration and answers both directions at any cardinality.

## Goals

- **REQ-001** — Persist a scoped, app-owned link between one `CustomerDeal` and one sales document, discriminated as `quote` or `order`.
- **REQ-002** — Expose exactly one write path — a command — so validation, tenant/organization scoping, and future idempotency live in one place. The command is the interface the future quote-creating command calls.
- **REQ-003** — Expose an HTTP route that lists links for a deal and creates one, so the link can be exercised before that command exists.
- **REQ-004** — Show the links on the deal detail page, with an honest empty state when no document exists yet.
- **REQ-005** — When a linked quote is converted into an order, record the order as its own link without anyone calling us.

## Non-goals

- The command that creates the quote. Owned by another person; this slice only publishes the interface it calls.
- Rendering quote number, status, or totals. The link answers existence; anything richer is fetched later, in its own slice.
- The quote → deal direction as a UI surface (a "deal" tab on quote detail). The data supports it; no screen is built.
- Cardinality policy. No unique index on `deal_id`, so the command's author may choose one-per-deal or many.
- Crud events and search indexing for link rows. `makeCrudRoute`'s `events` and `indexer` are optional (`shared/src/lib/crud/factory.ts:502-503`) and omitted here.

## Design

### Entity

Module `deal_links`, table `deal_document_links`, entity `DealDocumentLink`:

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `tenant_id` | uuid null | scope |
| `organization_id` | uuid null | scope |
| `deal_id` | uuid | scalar id — **no ORM relation** (`.ai/guides/contracts.md:10`) |
| `document_id` | uuid | the `sales` quote or order id |
| `document_kind` | text | `quote` \| `order` |
| `created_at` / `updated_at` / `deleted_at` | timestamptz | `updated_at` per `AGENTS.md` editable-record rule |

Index on `(tenant_id, organization_id, deal_id, deleted_at)`. No foreign keys into `sales` or `customers` tables.

### Write path

`deal_links.document_links.create`, a `CommandHandler` registered with `registerCommand`. It derives `tenantId` / `organizationId` from the command context and never from the payload, because its eventual caller passes an LLM-produced payload.

### Read/write route

`src/modules/deal_links/api/document-links/route.ts` via `makeCrudRoute`. `GET` lists by `dealId`; `POST` delegates to the command through `actions.create`. Features: `customers.deals.view` for read, `customers.deals.manage` for write (both verified in `customers/acl.ts:17,23`).

### Tab

Injection widget on `detail:customers.deal:tabs`, fetching the route on mount. States: loading, error, empty, list. Each row links to `/backend/sales/quotes/<documentId>`.

### Conversion follow-through

`src/modules/deal_links/commands/interceptors.ts` exports `interceptors` — the file name is the auto-discovery convention, no DI registration (`communication_channels/commands/interceptors.ts`). `afterExecute` on `sales.quotes.convert_to_order` reads `result.orderId`, finds the link whose `document_id` is the converted quote, and writes the matching `order` link. No link for that quote means the quote did not come from a deal; do nothing.

## Verified facts this design rests on

Each was read in the installed source, not recalled:

- `detail:customers.deal:tabs` is consumed by `customers/backend/customers/deals/[id]/hooks/useDealInjectedTabs.tsx:28` but is **not** declared in `customers/extension-points.ts`. Unfrozen host — marked `HACK(hackathon)`.
- That host renders `placement.groupLabel` verbatim (`useDealInjectedTabs.tsx:38`, `DealDetailTabs.tsx:108`), unlike its person and sales siblings which call `t()`. The tab label must be display text, not an i18n key.
- The deal **detail** route enables no enrichers, while the deals **list** route does (`customers/api/deals/route.ts:499`). An enricher cannot feed this tab; a route is required.
- `sales.quotes.convert_to_order` exists (`sales/commands/documents.ts:6372`) and emits **no event** — its body, lines 6368-7117, contains no `emitCrudSideEffects` and no `eventBus`. Only an audit entry, `sales.audit.quotes.convert`. An interceptor is the only seam.
- `SalesQuote.converted_order_id` exists (`sales/data/entities.ts:972`) but is absent from `sales/api/documents/factory.ts`, so the order cannot be derived over HTTP.
- An agent reaches a command only through the action vocabulary, which is `listWorkflowSafeCommands() ∪ activityTypes()` intersected with the agent's `allowedActions` (`agent_orchestrator/lib/runtime/actionVocabulary.ts:39-56`). Our command is called *by* another command, not proposed by a model, so it needs no `registerWorkflowSafeCommands` entry.

## Risks

- **Unfrozen host.** A `customers` upgrade may rename `detail:customers.deal:tabs`; the tab then vanishes silently. Nothing else breaks.
- **Hardcoded tab label.** Forced by the host reading `groupLabel` verbatim. Polish text in every locale until upstream adds `t()`. Guarded by a test so nobody "fixes" it back to a key.
- **Interceptor commit boundary unverified.** `AGENTS.md` requires effects post-commit; the convert command holds quote and order in one transaction. Whether `afterExecute` runs inside or after it is an implementation-time check, not an assumption.
- **Orders created outside the convert command** are not linked.

## Validation

`yarn generate && yarn typecheck && yarn lint` after every task. `yarn db:generate` plus a read of the produced SQL and snapshot — **never migrate a database to validate**, and ask before applying. `yarn test:integration:ephemeral` once the entity, route, and scoping exist.

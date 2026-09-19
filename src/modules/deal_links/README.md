# deal_links

Links a CRM deal to the sales quote or order produced for it.

## What is here

| Surface | Path | Notes |
|---|---|---|
| Entity | `data/entities.ts` | `deal_document_links`. No cross-module ORM relation, no unique index on `deal_id`. |
| Command | `commands/document-links.ts` | `deal_links.document_links.create`. The only write path for a hand-created link. Commits outside the caller's transaction — call it AFTER yours commits. |
| Route | `api/document-links/route.ts` | `GET` (filter by `dealId`, by `documentId`, or by both — both optional, newest first) and `POST`. |
| Deal widget | `widgets/injection/deal-documents/` | The tab on the deal detail page: lists a deal's linked documents and is one of two places a link is created by hand. |
| Document widget | `widgets/injection/document-deals/` | The Deals tab on the sales document detail page (quote and order): lists the deals linked to that document and links another. |
| Convert interceptor | `commands/interceptors.ts` | Carries the link across quote → order conversion. |

## Creating a link by hand

The deal detail tab and the sales document detail tab are the only two surfaces that
create a link by hand; both call the same `deal_links.document_links.create` command
through the same route. There is no standalone backoffice page any more — the deal tab
covers the deal side, and a deal may carry several documents. The document picker on the
deal tab offers quotes and orders in a single field whose value is encoded `kind:uuid`
(`lib/document-ref.ts`), because a dependent picker driven by a separate "kind" field
would need a hand-rolled custom field.

Row labels in the tab come from one batched `?ids=` request per source
(`lib/link-labels.ts`); `makeCrudRoute` supports that param on every route involved, so
nothing upstream was changed. A lookup that fails leaves the row visible with a
shortened id and a "not found" marker instead of hiding it.

The picker is always visible, whether or not the deal already has linked documents, and
is visible to anyone who can see the tab; without `customers.deals.manage` the link
attempt returns 403, surfaced inline.

The mirror surface lives on the sales document: the Deals tab on a quote or an order
detail page lists the deals linked to that document and links another. A document may
carry several deals, the same way a deal may carry several documents — neither
`deal_id` nor `document_id` is uniquely indexed. Its picker searches deals by title
(`lib/deal-options.ts`, backed by `customers/deals`).

## Known gaps

- **No delete.** Neither the module nor the tab can remove a link. A wrong row
  needs hand-written SQL. Deliberate, see
  `.ai/specs/2026-09-19-manual-deal-document-linking.md`.
- **No filtering or sorting beyond deal/document identity** on the list route: it
  understands `dealId` and `documentId` filters (each optional, independently or
  together) and a `created_at` sort, and nothing else.
- **Encrypted tenants** cannot search deals in the picker; the deals route
  collapses `search` to no matches when tenant data encryption is on.
- **Ids are validated, not verified.** `dealId`/`documentId` on the create
  command are checked for UUID shape only, never checked to exist. A bad id
  becomes a dead row in the deal-documents tab today, with no cleanup path —
  the module ships no delete route.
- **The convert interceptor is a second write path.** `commands/interceptors.ts`
  links the resulting order directly with `em.create`/`em.persist`/`em.flush`
  when a linked quote converts to an order, bypassing the create command
  entirely. That row skips the command's Zod validation, gets no audit-log
  entry, and would not be covered by CRUD-cache invalidation if that cache is
  ever enabled.
- **No events, no search indexing.** A created link emits no CRUD side effects
  and is not search-indexed; nothing can subscribe to a link being created and
  nothing can find one by search.
- **No client-side permission gate on the tab picker.** The framework has no hook for it,
  and a widget-level `features` gate would hide the link list as well.
- **No UI for orphaned links.** With the global list page gone, a link row pointing at a
  document that no longer exists can no longer be found through any UI — only SQL.
- **Encrypted tenants cannot use the document-side picker.** The deals route collapses a
  `search` to "no matches" when tenant data encryption is on, so only the unfiltered first
  page of deals is reachable from a quote or an order.

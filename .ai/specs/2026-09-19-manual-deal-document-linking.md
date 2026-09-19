# Linking a Sales Document to a Deal by Hand

**Date**: 2026-09-19
**Status**: Implemented
**Mode**: Hackathon — lean spec, see `AGENTS.md` Hackathon Mode
**Builds on**: `.ai/specs/2026-09-19-deal-document-links.md`

## TLDR

`deal_links` already owns the link record, the write command, an HTTP route and a tab on
the deal detail page, but the only thing that ever created a link was the RFQ intake chain
(`1624aa7`). A human had no way to make one. The deal detail tab now carries a document
picker: search a quote or an order, link it, repeat. Nothing else changes — no entity
change, no command change, no route change.

## Problem Statement

Linking happened only as a side effect of parsing a PDF. When intake linked the wrong
deal, when a quote was produced outside intake, or when a deal predated the feature, the
link could not be made: `POST /api/deal_links/document-links` was reachable only from
code. The tab (`widgets/injection/deal-documents/`) read links but never wrote one, and
displayed raw UUIDs as link text.

## Goals

- **REQ-001** — The deal detail tab creates a link: pick a sales document, press Link.
- **REQ-002** — A deal may carry several documents. The picker stays available whether or
  not links already exist.
- **REQ-003** — Linked rows show the document's `quoteNumber` / `orderNumber`, not its id,
  each linking to its detail page.
- **REQ-004** — The tab reuses `GET`/`POST /api/deal_links/document-links` unchanged. No
  new API contract, no schema change, no new command.
- **REQ-005** — An id that cannot be resolved degrades to a shortened id plus a "not
  found" marker. A dead row stays visible rather than disappearing.
- **REQ-006** — The tab matches the installed "linked people" / "linked companies" tabs on
  the same page, so it does not read as a bolt-on.

## Non-goals

- **Deleting / unlinking.** The module ships no delete command and no `DELETE` route, and
  this slice adds neither. A mistake still needs hand-written SQL. Decided explicitly with
  the requester.
- **A "manage links" modal.** The installed linked-entities tab opens a selection dialog;
  the requester asked for an inline picker and no modal.
- **A global list of every link across deals.** An earlier iteration built one at
  `/backend/deal-links` and it was removed at the requester's direction — see Costs below.
- **Server-side enrichment** of the list response: it would change the GET response shape.
- **Validating that the picked document exists.** The picker only offers ids the sales
  list APIs returned.

## Design

### Reading names without touching the contract

`makeCrudRoute`'s list handler reads a generic `ids` query param out of the RAW params —
`parseIdsParam(queryParams.ids)` then `mergeIdFilter(...)`
(`shared/src/lib/crud/factory.ts:1616`, `shared/src/lib/crud/ids.ts:66`). Both sales
routes are built by that factory, so a batch lookup already exists:

| Source | Request | Label field |
|---|---|---|
| Quotes | `GET /api/sales/quotes?ids=<csv>&pageSize=100` | `quoteNumber` |
| Orders | `GET /api/sales/orders?ids=<csv>&pageSize=100` | `orderNumber` |

The tab loads a deal's links, collects the distinct ids, and issues at most two further
requests. Each fails soft: a rejection contributes an empty map and REQ-005 renders the
shortened id. `lib/link-labels.ts` also resolves deal titles — unused by the tab, which
already knows its deal, and kept because it is tested and costs nothing.

### One picker, kind encoded in the value

`CrudForm`'s and `ComboboxInput`'s `loadSuggestions(query)` receive only the typed query,
never sibling state, so a "kind" selector cannot filter a separate document picker without
a hand-rolled control. Instead one picker offers quotes and orders together with the value
encoded `<kind>:<uuid>` (`lib/document-ref.ts`), decoded at submit. An inconsistent
kind+id pair is therefore unrepresentable.

Within that loader the two halves are deliberately asymmetric (`lib/document-options.ts`):
a quotes failure propagates, because `sales.quotes.view` gates the surface at all and a
real failure must not present as "no results"; an orders failure degrades to no options,
so a user without `sales.orders.view` still gets a working quote picker.

### Layout

The tab copies the Tailwind structure of
`customers/components/detail/DealLinkedEntitiesTab.tsx` — header card with title and
count, then bordered document cards with a round icon, bold number and muted subtitle,
then its empty-state box. Four things are deliberately not copied: the filter over
already-linked rows, pagination, the "Manage links" button and the `LinkEntityDialog`
modal. A deal carries a handful of documents, and the requester asked for no modal.

### Access

The tab renders inside the deal detail page, which already requires
`customers.deals.view`; the route requires `customers.deals.manage` to write. There is no
client-side permission hook in this framework — `shared/src/lib/frontend/` ships only
organization, notification and progress helpers, and a widget-level `features` gate
(`shared/modules/widgets/injection.ts:164`) would hide the link LIST too. So the picker
renders for everyone who can see the tab and a 403 is surfaced inline.

Scope is never sent from the browser: the command derives `tenantId`/`organizationId` from
the session and strips them from the payload (`commands/document-links.ts`).

## Costs and risks

- **Orphaned rows are now invisible.** The command validates that `dealId` and
  `documentId` are well-formed UUIDs but never that they exist, so rows pointing at
  nothing are possible today. With the global list page gone, no UI surfaces them — only
  SQL does.
- **A second write path exists.** `commands/interceptors.ts` carries a link across
  quote-to-order conversion by writing through `em.create`/`persist`/`flush`, bypassing
  the command's Zod validation. Rows it creates are not validated the way the tab's are.
- **Encrypted tenants.** When tenant data encryption is on, the deals route collapses a
  `search` to "no matches" (`customers/api/deals/route.ts:338`). This no longer affects
  the tab, which needs no deal search, but it remains true of the module's environment.

## Testing

`jest.config.cjs` runs `testEnvironment: 'node'`, so the widget itself cannot be rendered
in a test. Coverage lands on the pure modules it is built from:

- `lib/document-ref.ts` — the `<kind>:<uuid>` codec, round trip and rejection of malformed
  input (13 cases);
- `lib/link-labels.ts` — id collection, dedupe, cap, label mapping and the fail-soft path
  (13 cases);
- `lib/document-options.ts` — the merged option list, the quotes/orders asymmetry and the
  search-param shape (8 cases).

The rendered tab is verified by hand.

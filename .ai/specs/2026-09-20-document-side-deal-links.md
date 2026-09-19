# Linking a Deal from the Sales Document

**Date**: 2026-09-20
**Status**: Ready for implementation
**Mode**: Hackathon — lean spec, see `AGENTS.md` Hackathon Mode
**Builds on**: `.ai/specs/2026-09-19-manual-deal-document-linking.md`

## TLDR

The deal detail page can now link a sales document to a deal. The reverse direction has
data but no screen: standing on a quote or an order, you cannot see which deal it answers,
let alone attach one. This slice mirrors the tab onto the sales document detail page, for
both document kinds, and adds the one optional query parameter the existing route needs to
answer "which deals is THIS document linked to?".

## Problem Statement

`GET /api/deal_links/document-links` filters by `dealId` only (`buildFilters` in
`api/document-links/route.ts`). The quote → deal direction was listed as an explicit
non-goal of the original linking spec — "The data supports it; no screen is built" — and
that is still where it stands. A salesperson opening a quote produced by the RFQ intake
chain has no way to see the case it came from, and no way to correct a wrong attachment
from the side they are working on.

## Goals

- **REQ-001** — A tab on the sales document detail page lists the deals linked to that
  document, showing each deal's `title` and linking to its detail page.
- **REQ-002** — The tab links a deal: search by title, press Link. A document may carry
  several deals; nothing blocks the count.
- **REQ-003** — The tab appears on both document kinds, `quote` and `order`.
- **REQ-004** — The tab matches the installed linked-entities layout, as the deal-side tab
  already does.
- **REQ-005** — A deal id that cannot be resolved degrades to a shortened id plus a "not
  found" marker; the row stays visible.
- **REQ-006** — Typing text that matches no deal cannot arm the Link button. The
  deal-side tab has this defect (`ComboboxInput` defaults `allowCustomValues` to `true`,
  so free text commits and the button silently no-ops); this slice does not reproduce it.

## Non-goals

- **Fixing the deal-side tab's defects.** REQ-006's bug, the discarded deal-title lookup,
  and the quotes-propagation claim that `ComboboxInput` swallows are all real and all
  already in `main`. The requester chose to ship this slice first; they belong to a
  separate PR and are recorded in that decision, not fixed here.
- **Deleting / unlinking.** Still no delete command and no `DELETE` route.
- **Blocking cardinality.** Explicitly declined: "na razie nie blokujmy ilości powiązań do
  jednego".
- **A modal.** The picker is inline, as on the deal side.
- **Channel offers** (`sales/channels/offers`). `document_kind` is `quote | order`; channel
  offers are a different entity and are not linkable.

## Design

### The host

`sales/backend/sales/quotes/[id]/page.tsx` and its `orders` sibling are four-line wrappers
around one component, `sales/backend/sales/documents/[id]/page.tsx`, differing only by
`initialKind`. That component publishes a tab injection spot,
`resolveExtensionPointPattern('sales.document.detail.{kind}:{surface}', { kind, surface: 'tabs' })`,
so one widget registered under `sales.document.detail.quote:tabs` and
`sales.document.detail.order:tabs` serves both kinds.

Its context is `{ kind, record, formId, resourceKind, resourceId, retryLastMutation }`, so
the document's kind and id arrive directly — no URL parsing.

Unlike the customers host, this one translates the tab label:
`t(widget.placement.groupLabel, widget.module.metadata.title)`
(`sales/backend/sales/documents/[id]/page.tsx:4016`). The tab therefore declares an i18n
key as its `groupLabel`, rather than the literal string the deal-side tab is stuck with.

### The route parameter

`querySchema` and `buildFilters` gain an optional `documentId`. `buildFilters` moves out of
the route file into `lib/document-links-filters.ts` so it can be unit-tested — importing
the route under Jest pulls in `makeCrudRoute` → MikroORM's Postgres driver → ESM-only
`kysely`, which this Node cannot `require`. That is the same constraint that already forces
`lib/route-access.ts` to exist.

Both filters are independent and may be combined: `?dealId=…&documentId=…` narrows to a
single pair, which is what a future unlink path would ask for.

### Labels

`lib/link-labels.ts` already resolves deal titles through one batched
`GET /api/customers/deals?ids=…` — the half the deal-side tab loads and then discards.
Here it is the half that matters, and the documents half is the one to skip.

## Migration & Backward Compatibility

Required by `.ai/guides/upstream/BACKWARD_COMPATIBILITY.md` §"Deprecation Protocol" item 5,
because this slice touches an API contract surface.

| Surface | Change | Classification |
|---|---|---|
| `GET /api/deal_links/document-links` | New **optional** query parameter `documentId` (uuid) | ✓ ADDITIVE — §7 API Route URLs: "MAY add new optional fields to request/response schemas"; the change matrix marks API route request-field additions OK |
| `GET` response schema | Unchanged | ✓ No change |
| `POST /api/deal_links/document-links` | Unchanged | ✓ No change |
| Route URL, HTTP methods, ACL | Unchanged | ✓ No change |
| `deal_document_links` table | Unchanged — no migration | ✓ No change |
| `deal_links.document_links.create` command | Unchanged | ✓ No change |
| `widgets/injection-table.ts` | New spot entries; existing `detail:customers.deal:tabs` entry untouched | ✓ ADDITIVE |

A caller that omits `documentId` gets byte-identical behaviour to today — the filter is only
installed when the parameter is present. No deprecation, no bridge and no `UPGRADE_NOTES.md`
entry is required, because nothing is removed, renamed or narrowed.

## Risks

- **Encrypted tenants cannot search deals.** With tenant data encryption on, the deals
  route collapses a `search` to "no matches" rather than scanning ciphertext
  (`customers/api/deals/route.ts:338`). The deal-side tab never needed a deal search; this
  one is built on it, so on such a tenant the picker shows only the unfiltered first page
  and typing empties it. Recorded as a `HACK(hackathon)`.
- **No client-side permission gate.** Same as the deal-side tab: the framework offers no
  hook, and a widget-level `features` gate would hide the list from users entitled to see
  it. A user without `customers.deals.manage` sees the control and gets a 403 inline.
- **The spot is unproven.** Nothing else in this checkout registers into
  `sales.document.detail.*:tabs`. It is declared in the sales module's
  `extension-points.ts` and read by the page, so it is a published host rather than an
  undeclared one — unlike `detail:customers.deal:tabs`, which the deal-side tab uses on a
  HACK note. Lower risk than what already ships, but first use nonetheless.

## Testing

`testEnvironment: 'node'`, so no rendering. Coverage lands on:

- `lib/document-links-filters.ts` — `dealId` alone, `documentId` alone, both together,
  neither, and malformed input;
- `lib/deal-options.ts` — option shape, search-param shape, empty query, failure
  propagation;
- `lib/route-access.ts` — unchanged assertions still pass.

The rendered tab is verified by hand.

# Sending a Quote Advances the RFQ Funnel

**Date**: 2026-09-20
**Status**: Ready for implementation
**Mode**: Hackathon — lean spec, see `AGENTS.md` Hackathon Mode
**Builds on**: `.ai/specs/2026-09-19-deal-document-links.md`

## TLDR

When a quote is sent to the customer, the RFQ case it answers should move to
`Oferta wysłana`. The funnel stage and the command that writes it already exist; what is
missing is a trigger, because `POST /api/sales/quotes/send` emits nothing. This slice
wraps that installed route through `entry.overrides.routes.api`, and moves the linked deal
forward only — never backward, never out of a closed stage.

## Problem Statement

`sales/api/quotes/send/route.ts:190-196` sets `quote.status = 'sent'` directly inside
`em.transactional`. It is not a command, it emits no event, and it is not a
`makeCrudRoute` route. Measured against the four UMES seams:

| Seam | Reaches this route? | Why |
|---|---|---|
| Typed subscriber | No | `sales/events.ts` declares no `sales.quote.sent`, and the route emits no `sales.quote.updated` either |
| Command interceptor | No | there is no command to target |
| API interceptor | No | interceptors run inside `makeCrudRoute`; the `[...slug]` dispatcher does not apply them, and this route is hand-written |
| Mutation guard | No | the route builds `runMutationGuards([legacyGuard], …)` — only the `crudMutationGuardService` bridge. It never calls `getAllMutationGuardInstances()`, unlike `staff/api/guards.ts:105` or the eudr routes |

So a funnel move has to come from replacing the route, and the app already has a working
precedent for exactly that: `PUBLIC_QUOTE_ACCEPT_ROUTE_OVERRIDE`.

## Goals

- **REQ-001** — Sending a quote that is linked to an RFQ case moves that case to the
  `sent` stage (`Oferta wysłana`) of the RFQ funnel.
- **REQ-002** — The move is forward-only. A case already at `sent` or past it does not move,
  so re-sending the same quote is a no-op.
- **REQ-003** — A case in a stage whose label reads as won or lost — in *any* pipeline, via
  the installed `TERMINAL_PIPELINE_STAGE_LABELS` — never moves. Closing beats sending.
- **REQ-004** — The funnel move never changes the outcome of the send. It runs after the
  installed handler answered 2xx, and any failure inside it is logged, not surfaced: the
  customer already has the e-mail.
- **REQ-005** — Every send path is covered — staff UI, API client, agent — because the
  override replaces the route, not the button.
- **REQ-006** — The override key is pinned by a test against the generated API surface, and
  the `applyApiRouteOverrides` call is pinned by a test against `bootstrap-common.ts`.

## Non-goals

- **Adding the seam upstream.** A PR adding `getAllMutationGuardInstances()` to the send
  route (one line — it already builds the guard input and runs `afterSuccess` post-commit)
  or a `sales.quote.sent` event is the right long-term fix. Out of scope here; recorded in
  the HACK note so the wrapper can be deleted when it lands.
- **Seeding the RFQ funnel anywhere.** See Risks — a deployed environment needs
  `mercato rfq_intake seed-pipeline` first, and that is an operator decision.
- **Moving a case on any other quote transition** (accepted, expired, cancelled).
- **Any UI change.** The funnel tab already renders whatever stage the deal is in.

## Design

One handler, wrapping the installed one:

1. Read the request body once as text; hand a reconstructed `Request` to the installed
   `POST`, and keep the text to read `quoteId` from.
2. If the response is not ok, return it untouched — nothing was sent.
3. Resolve trusted scope the same way the installed route does (`getAuthFromRequest` +
   `resolveOrganizationScopeForRequest`), then resolve the case the quote answers.
4. Apply the direction guard, and on a pass call the existing `rfq_intake.deal.advance`
   with `stage: 'sent'`.

**The direction guard** is a pure function over the deal's current stage, so it is unit
tested without a database:

| Current stage | Moves? |
|---|---|
| none | yes |
| an RFQ stage before `sent` | yes |
| an RFQ stage at or after `sent` | no (REQ-002) |
| label reads won/lost in any pipeline | no (REQ-003) |
| a foreign, non-terminal stage | yes — the case enters the RFQ funnel |

That last row is a deliberate choice, not an oversight: a deal parked in the stock
`Default Pipeline` is exactly the deployed situation, and pulling it into the RFQ funnel
on send is the intended behaviour. The terminal-label check is what stops that from
dragging a finished deal backwards.

**Shared resolution.** `resolveCaseId` currently lives inside
`subscribers/sync-deal-value.ts`. It moves to `lib/quoteCase.ts` and both callers import
it, so "which case does this quote answer" keeps exactly one answer
(`metadata.rfqDealId` first, the `deal_document_links` row second).

**Registration** goes through `applyApiRouteOverrides` in `src/bootstrap-common.ts`, *not*
`entry.overrides.routes.api` in `src/modules.ts` — `ClientBootstrap.tsx:66` imports
`@/modules` in the browser, so naming a server handler there pulls the installed sales
route and `server-only` into the client graph and breaks `yarn build`. This is the reason
already documented on the accept override.

## Risks

- **Silent no-op without a seeded funnel.** `resolveRfqStageId` looks for a pipeline named
  `RFQ`; on an environment that has only the stock `Default Pipeline`, `deal.advance` logs
  a warning and returns `{ moved: false }`. The feature will look broken on the deployed
  environment until `yarn remote-db --env <env> -- yarn mercato rfq_intake seed-pipeline`
  runs — which also demotes `Default Pipeline` and leaves existing deals on their old
  stages. Operator decision, see `rfq-process-sync`.
- **Wrapper masks upstream drift.** If the installed route changes signature or metadata,
  the wrapper hides it. Mitigated by REQ-006's key test.
- **Two containers per send.** The wrapper resolves its own container after the installed
  handler resolved one. Measured cost is one extra scoped resolution on a rare operation.

## Validation

- Unit: the direction guard across all five rows above; the override key against
  `.mercato/generated/openapi.generated.json`; the `bootstrap-common.ts` wiring.
- Gate: `yarn generate && yarn typecheck && yarn lint && yarn test`.
- Manual: send a quote from a deal-linked case and confirm the funnel tab moves; re-send
  and confirm it does not move again.

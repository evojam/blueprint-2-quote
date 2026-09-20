# An Accepted Quote Closes the RFQ Case

**Date**: 2026-09-20
**Status**: Ready for implementation
**Mode**: Hackathon — lean spec, see `AGENTS.md` Hackathon Mode
**Builds on**: `.ai/specs/2026-09-20-quote-sent-advances-funnel.md`

## TLDR

When a quote is converted into an order — the customer clicking accept on their quote
link, or a salesperson converting by hand — the RFQ case it answers should close as won.
Unlike the send route, this one goes through a command, so the ordinary UMES seam applies
and nothing has to be replaced.

## Problem Statement

The previous slice moves a case to `Oferta wysłana` when its quote goes out. Nothing then
moves it again: a case whose quote the customer signed sits in `Oferta wysłana` forever,
and the funnel stops telling the truth at exactly the point people care about most.

Unlike `POST /api/sales/quotes/send`, the acceptance path is well behaved.
`sales/api/quotes/accept/route.ts:138` calls `sales.quotes.convert_to_order` through the
command bus, and so does the staff-side `sales/api/quotes/convert/route.ts`. A command
interceptor catches both. `deal_links` already intercepts this exact command, which is the
proof the hook fires.

## Goals

- **REQ-001** — Converting a quote linked to an RFQ case closes that case as won.
- **REQ-002** — Both conversion paths count: the customer's acceptance and a manual
  conversion from the backoffice. A conversion is the win whoever clicked it.
- **REQ-003** — The close sets the deal's `status`, `closureOutcome` **and** terminal
  stage, not just the stage. A deal that reads `Closed Won` on the board while its data
  says `open` is worse than one that never moved.
- **REQ-004** — Converting the same quote twice does not write the deal a second time.
- **REQ-005** — A case previously marked lost is still closed as won.
- **REQ-006** — The close can never fail the conversion. On the acceptance path this hook
  runs inside the customer's transaction, so a throw would roll back their signature.
- **REQ-007** — Scope is derived without `ctx.auth`, which is `null` when the customer
  accepts.

## Non-goals

- **Reopening the case when the conversion is undone.** Recorded as a known gap; see
  Risks.
- **Distinguishing who converted.** Deliberately out: the command receives the same input
  from both routes, and keying off `ctx.auth === null` would be a brittle proxy for
  "the customer did it".
- **Fixing `deal_links`' interceptor**, which has the `ctx.auth` bug described below. Same
  command, different module, separate change.

## Design

`src/modules/rfq_intake/commands/interceptors.ts`, `afterExecute` on
`sales.quotes.convert_to_order`.

**The write is `customers.deals.update` with `status: 'win'` and no `pipelineStageId`.**
This is the load-bearing detail. `customers/commands/deals.ts:798-801` resolves the
closure stage only when the caller passes no stage:

```
parsed.pipelineStageId === undefined && requestedClosureOutcome
  ? await loadClosurePipelineStageSnapshot(...)
```

So `rfq_intake.deal.advance` — which exists, names a `won` stage, and looks like the
obvious tool — is the wrong one here: it sets `pipelineStageId`, skipping that branch and
leaving `status: 'open'` with a null `closureOutcome`. Letting the installed command find
the terminal stage by label is also why `RFQ_PIPELINE_STAGES` spells its closing stages in
English (already recorded in `lib/pipeline.ts`).

**Scope comes from the quote row, not from the actor.** The acceptance route builds its
command context with `auth: null` (`accept/route.ts:128-136`) — the customer holds a
token, not a session — and carries no `tenantId` on it. Of what an interceptor receives,
only `selectedOrganizationId` is populated on both paths. So: organization from the
context, tenant from the quote read within that organization. Never an unscoped read;
missing scope means the hook does nothing.

**The guard is pure** (`shouldCloseAsWon`): skip a case already closed as won, close
anything else. Note the deliberate asymmetry with the send-side guard, which refuses to
touch a closed case — there nothing new had happened, here the customer signed.

## Risks

- **The close is not atomic with the acceptance.** `CommandInterceptorContext` carries no
  `transactionalEm`, so the write runs on a forked EM in its own transaction while the
  acceptance transaction is still open. An acceptance that rolled back after this point
  would leave the case won with no order. The window is one commit wide, and `deal_links`
  already carries the same tradeoff on the same command. Closing it needs an upstream
  change.
- **Undo does not reopen the case.** The convert command's undo hard-deletes the order;
  the deal stays `Closed Won`, repairable only by hand.
- **`deal_links`' own interceptor never fires on customer acceptance.** It reads
  `ctx.auth?.tenantId` and returns early when that is null, so an order created by a
  customer accepting a quote is never linked to its deal. Pre-existing, unrelated to this
  slice, and worth its own fix.

## Validation

- Unit: the pure guard across won/lost/open/absent; the interceptor's target; the
  `status`-without-stage shape of the write; the no-auth acceptance path; already-won
  idempotency; fail-closed on an invisible quote; failure swallowed; renamed input
  reported.
- Gate: `yarn generate` (new discovery file) then typecheck, lint, test, build.
- Manual: accept a quote as the customer and confirm the case reads Closed Won with a
  closed status, not merely a moved card.

# RFQ Sales Quote Replacement

**Date**: 2026-09-20
**Status**: Ready for implementation — approved 2026-09-20

## TLDR

`rfq_intake.analysis` starts from an existing Sales quote and fills that quote from the document analysis. Its legacy input name remains `dealId`, but it now contains the UUID of a `SalesQuote`. The flow replaces all quote lines with deterministic catalog and measurement results; it does not create a quote or mutate a CRM deal.

## Problem Statement

Workflow instance `85458af6-ea6c-450f-a294-f16d5148621d` received Sales quote `16278518-0780-4868-b324-5861f92bbf90` as `dealId`. The existing graph treated it as a CRM deal, wrote measurement ownership as `customers:customer_deal`, and had the agent propose only `rfq_intake.quote.create`. The instance completed without changing the target quote: it had zero lines and zero totals.

## Overview and Success Measures

- **Primary outcome:** one completed workflow replaces the target Sales quote's line set with valid calculated lines and recalculated totals.
- **Leading indicators:** workflow output identifies the target quote and line count; Sales audit entries show the line mutations.
- **Baseline:** target `QUOTE-20260920-00004` is empty after the completed instance.
- **Market / product reference:** N/A — this is an internal correction using the installed Sales command surface.

## Goals

- **REQ-001** — `dealId` resolves only to a scoped, non-deleted Sales quote.
- **REQ-002** — One approved proposal replaces every existing target quote line with validated deterministic lines.
- **REQ-003** — The graph performs no CRM-deal stage mutation, customer-deal attachment write, or quote creation.
- **REQ-004** — The workflow preserves an unsent quote's status; an update of a sent quote uses the installed Sales invalidation-to-`draft` behavior.

## Non-goals

- Creating a Sales quote, resolving/linking/advancing a CRM deal, setting up a quote-status dictionary, or sending the quote.
- New UI, API routes, entities, migrations, direct ORM writes, automatic retries, or compensation.

## Proposed Solution

Replace the deal-targeted graph steps with a Sales-quote-targeted pipeline. The quote drafter proposes `rfq_intake.quote.replace` rather than a creation action. A reachable post-disposition `UPDATE_ENTITY` activity applies the approved proposal, because `INVOKE_AGENT` disposition persists approval but never executes its proposed actions.

`rfq_intake.quote.replace` reuses the existing deterministic geometry, product/variant, unit, and pricing calculation code. It validates the target quote and candidate lines before deleting existing lines; it then invokes the installed `sales.quotes.lines.delete`, `sales.quotes.lines.upsert`, and `sales.quotes.update` commands under the workflow principal.

### Design Decisions and Alternatives

| Decision | Rationale | Alternative considered | Why rejected / deferred |
|---|---|---|---|
| Keep the `dealId` field name but use quote UUID semantics | User requested compatibility of the field name while starting from Sales quote detail. | Rename to `quoteId`. | Breaking ProcessDefinition and workflow input contract. |
| Replace all lines | A workflow result is a full derived quotation, not an incremental add. | Append workflow lines. | Re-runs would accumulate duplicates. |
| Use explicit post-proposal activity | Approval and action execution are separate installed Agent Orchestrator operations. | Assume auto-approval executes actions. | Proven false by the recorded instance. |
| Sequential installed Sales commands | Reuses scoped Sales calculations and audit commands without editing installed code. | App-owned atomic direct ORM replacement. | Requires a new canonical mutation primitive and was declined. |

## Domain Vocabulary and Business Rules

| Term / invariant | Precise meaning or rule | Source of truth | Failure behavior |
|---|---|---|---|
| `dealId` | Legacy field name; value is a Sales quote UUID. | Workflow input and scoped Sales quote lookup. | Missing, foreign, deleted, or non-quote ID fails before mutation. |
| target quote | The one Sales quote named by `dealId`. | `SalesQuote`. | No fallback to a CRM deal or new quote. |
| replacement set | Every existing line is deleted, then every surviving derived item is upserted. | `rfq_intake.quote.replace`. | No deletion when validation leaves zero items. |
| sent quote | Quote where `status = 'sent'`. | Installed Sales update command. | Clears `acceptanceToken` and `sentAt`, then sets `draft`. |

// HACK(hackathon): Sales exposes individual line delete/upsert commands but no atomic replacement primitive. The demo starts the replacement once; a failure between operations can leave a partial line set and requires operator inspection/re-run. No retry, compensation, or concurrent-edit protection ships in this slice.

## Users, Permissions, and Scope

| Actor | Allowed outcomes | Scope rule | Required feature IDs |
|---|---|---|---|
| Authenticated process starter | Starts analysis for one Sales quote. | Tenant and organization derive from the process principal; `dealId` is checked against them. | Existing process run features. |
| Workflow principal | Reads agent output and mutates the quote through commands. | Same trusted tenant and organization must match the quote and all source records. | `sales.quotes.manage`, Agent Orchestrator and workflow command grants. |

No agent payload carries tenant, organization, or trusted workflow identity. Missing scope fails closed before every query.

## Reuse and Ownership Map

| Capability | Reuse / extend / app-own | Existing module | Integration seam | Why |
|---|---|---|---|---|
| Quote persistence, math, sent reset | reuse | installed `sales` | existing quote/line commands and `salesCalculationService` | Sales remains record and calculation owner. |
| Measurement and catalog calculation | extend | `rfq_intake` | existing deterministic quote calculation functions | Preserves source-grounded quantities and prices. |
| Proposal application | app-own | `rfq_intake` | workflow-safe command after `INVOKE_AGENT` | The installed disposition service intentionally does not effect actions. |
| Durable process | reuse | installed `workflows` | existing `rfq_intake.analysis` | Preserves instance history and process visibility. |

## Architecture and Data Flow

```text
Sales quote page / process start { dealId: quoteId, __files }
  → rfq_intake.analysis
  → PDF intake → room measurement → catalog match
  → quote drafter proposal: rfq_intake.quote.replace
  → explicit apply_quote activity
  → installed Sales line delete/upsert/update commands
  → updated target Sales quote and workflow output
```

The graph is `START → extract_pdf → measure_rooms → match_catalog → draft_quote → apply_quote → END`. It removes `mark_quoting` and `mark_review`; both call `rfq_intake.deal.advance` and are invalid for a Sales quote target. `measure_rooms` correlates to the workflow and quote without writing a `customers:customer_deal` attachment.

The `apply_quote` activity writes the stable informational output `context.quoteUpdate = { quoteId, lineCount, warnings, updatedAt }`. It does not claim crash-safe idempotency.

## User Journeys

### Journey J-001 — Populate an existing quote

1. An authorized user starts `rfq_intake.analysis` from a Sales quote and passes its UUID as `dealId`.
2. The workflow extracts the PDF, measures rooms, and matches catalog products in trusted scope.
3. The drafter proposes one line replacement action; the workflow applies the selected action after disposition.
4. Sales shows the same quote with the replacement lines and recalculated totals.
5. A missing quote, empty valid result, denied grant, or Sales command failure produces a truthful failed workflow rather than a new quote or CRM write.

## UI and Interaction Contracts

N/A — existing `/backend/sales/quotes/[id]` is the only affected surface. No UI component, route, navigation, or user-facing string changes.

## Data Models

N/A — reuses `SalesQuote`, `SalesQuoteLine`, Agent Proposal, Agent Run, and Workflow Instance. No migration or new entity. Quote metadata retains unrelated keys and adds the source marker, workflow instance ID, and measurement run ID.

## API, Command, and Error Contracts

| Method / command | Path / ID | Auth and feature gate | Input | Success response / event | Errors and concurrency |
|---|---|---|---|---|---|
| Workflow-safe command | `rfq_intake.quote.replace` | derived scope + `sales.quotes.manage` | `{ dealId, roomMeasurementsRunId, items }` | `{ quoteId, lineCount, warnings }` | Missing/foreign quote or run fails before line deletion. |
| Workflow-safe command | `rfq_intake.quote.apply_proposal` | derived scope + workflow action vocabulary | `{ workflowInstanceId, stepId: 'draft_quote' }` | forwards replacement result to `context.quoteUpdate` | Absent selected proposal or unsupported action fails. |
| Installed command | `sales.quotes.lines.delete` / `upsert` / `sales.quotes.update` | installed Sales authorization | command-specific bodies | Sales audit and total recalculation | Sequential only; partial state is the documented hackathon tradeoff. |

## Events, Jobs, Notifications, and Cross-Module Flows

| Trigger | Producer | Consumer | Side effect | Retry / idempotency / audit behavior |
|---|---|---|---|---|
| Approved quote-drafter proposal | Agent Orchestrator disposition | `apply_quote` workflow activity | Executes one allowed replacement action. | Immutable proposal/workflow records; no automatic retry in this slice. |
| Quote line mutations | installed Sales commands | installed Sales audit/calculation services | Recalculate target quote totals; sent quote resets to draft. | Installed command audit; sequential replacement shortcut documented above. |

## Security, Privacy, and Compliance

- **Authorization:** workflow principal, Sales feature gates, and installed Sales command authorization remain authoritative.
- **Tenant isolation:** every quote, run, proposal, catalog, and line operation is scoped by trusted tenant and organization.
- **Sensitive data:** no PDF text or model transcript enters quote metadata or workflow context.
- **Abuse and failure modes:** untrusted model values are limited to validated item identifiers/bases/room IDs; they cannot choose scope or an arbitrary command.

## Integration Coverage

| Test ID | Level | Setup / fixture | Actions | Assertions | Requirement IDs |
|---|---|---|---|---|---|
| TEST-001 | unit | scoped quote, accepted measurement run, products, existing lines | execute replacement command | old lines replaced, totals recalculated, no quote created | REQ-001, REQ-002 |
| TEST-002 | unit | foreign/missing quote and no-surviving-item proposal | execute replacement command | no Sales mutation | REQ-001, REQ-002 |
| TEST-003 | unit | sent target quote | execute replacement command | installed reset-to-draft outcome remains intact | REQ-004 |
| TEST-004 | unit | workflow config | inspect graph and safe-command registrations | no deal stage/attachment write; `apply_quote` reachable after drafter | REQ-003 |
| TEST-005 | browser/manual smoke | local Sales quote with a valid PDF | run process once, open quote detail | target quote shows generated lines/totals | REQ-001–REQ-004 |

## Implementation Phases

### Phase 1 — Replace target quote lines

- **Depends on:** existing deterministic quote calculation helpers and installed Sales commands.
- **Outcome:** `rfq_intake.quote.replace` fills one scoped Sales quote from a valid item proposal.
- **Deliverables:** command, action schema/agent contract, focused tests.
- **Requirements closed:** REQ-001, REQ-002, REQ-004.
- **Tests:** TEST-001–TEST-003.
- **Validation:** focused Jest suites, `yarn generate`, `yarn typecheck`; lint was explicitly waived for this run.
- **Exit gate:** a test quote has replacement lines and truthful totals; no mutation on invalid input.

### Phase 2 — Apply approved workflow proposal

- **Depends on:** Phase 1 exit gate.
- **Outcome:** the existing workflow executes the selected proposal against its target quote.
- **Deliverables:** `apply_quote` command/activity, graph cutover, workflow output, focused tests.
- **Requirements closed:** REQ-003.
- **Tests:** TEST-004.
- **Validation:** `yarn generate`, focused suites, `yarn typecheck`.
- **Exit gate:** no CRM-deal activity remains and an actual local run updates the requested quote.

## Requirement Traceability

| Requirement | Journey / surface | Data/API/event contracts | Phase | Tests | Acceptance criterion |
|---|---|---|---|---|---|
| REQ-001 | J-001, existing Sales quote detail | `dealId` quote lookup, replacement command | Phase 1 | TEST-001, TEST-002, TEST-005 | AC-001 |
| REQ-002 | J-001 | derived line set and Sales commands | Phase 1 | TEST-001, TEST-002 | AC-001, AC-002 |
| REQ-003 | J-001, workflow instance | workflow graph and post-disposition command | Phase 2 | TEST-004, TEST-005 | AC-003 |
| REQ-004 | J-001, Sales quote detail | installed sent update behavior | Phase 1 | TEST-003 | AC-004 |

## Rollout, Migration, and Rollback

`rfq_intake.analysis` and the field name `dealId` remain stable, but this process now requires a Sales quote UUID rather than a CRM deal UUID. Existing callers must pass the quote UUID; a CRM-deal UUID fails closed and never creates a quote. Add operator migration guidance to `UPGRADE_NOTES.md` when implementation starts. Rollback restores the old graph and command contract; no schema migration or data conversion is required.

## Risks and Tradeoffs

| Risk / tradeoff | Impact | Mitigation / detection | Residual risk |
|---|---|---|---|
| Sequential line replacement fails halfway | Quote can be partially updated. | Workflow error and Sales audit expose the state; operator inspects/re-runs. | Accepted HACK(hackathon) for one-run demo path. |
| Wrong target UUID | Data could be written to a wrong quote in scope. | Quote lookup is scope-bound and user starts from its detail page. | Same-organization selection remains an authorized user action. |
| Sent quote changes | Customer acceptance link becomes stale. | Installed Sales update resets it to `draft`. | Operator must resend after review. |

## Acceptance Criteria

- [ ] **AC-001** — Starting the workflow with Sales quote `16278518-0780-4868-b324-5861f92bbf90` replaces its lines from the approved proposal and yields non-zero totals when a valid item survives.
- [ ] **AC-002** — The workflow creates no Sales quote and mutates no CRM deal.
- [ ] **AC-003** — The graph contains a reachable post-disposition proposal-application activity and no customer-deal attachment target.
- [ ] **AC-004** — Unsent quotes retain their status; sent quotes follow the installed reset-to-draft behavior.

## Final Compliance Report

| Check | Status | Evidence / resolution |
|---|---|---|
| Applicable rules and skills reviewed | pass | Root `AGENTS.md`, `om-spec-writing`, `om-build-workflow`, `om-troubleshooter`, workflow and Sales module guidance. |
| Data, APIs, events, UI, and tests consistent | pass | Existing Sales records/commands only; traceability above. |
| Workflow is end-to-end without catch-all phase | pass | Two dependency-ordered phases with concrete exit gates. |
| Platform-native mechanism selected | pass | Existing workflow, Agent Orchestrator disposition, Sales commands, and calculation service. |
| UI contract complete | N/A | No changed UI surface. |
| Phases have tests and observable exits | pass | TEST-001–TEST-005 and phase exit gates. |

Verdict: Ready for implementation

## Open Questions

N/A — the user approved retaining `dealId`, replacing all lines, leaving unsent status unchanged, accepting sequential one-run semantics, and implementation on 2026-09-20.

## POC Estimate Amendment — Approved 2026-09-20

`rfq_intake.analysis` MAY create or replace lines on an unsent draft Sales quote from measurements marked `estimated`, including when the drawing has neither a scale nor a source dimension. This is an intentional hackathon shortcut: the generated quote MUST remain draft, MUST carry `rfqEstimate: true` metadata with every estimated input's reason and confidence, and MUST NOT be sent automatically. Human review before sending is the accepted control.

The room-measurements contract adds `method: 'estimated'`, `confidence`, and `estimationReason` to estimated linear inputs. The resolver accepts positive estimated values as billable quantities and reports estimate provenance to the quote command. Source-grounded values continue unchanged.

### Amendment Acceptance Criteria

- [ ] **AC-005** — A missing wall length can be emitted as a positive estimated value and used to calculate a draft quote line.
- [ ] **AC-006** — A Sales quote containing any estimated input remains draft and records estimate provenance in metadata.
- [ ] **AC-007** — No workflow path sends a quote automatically.

## Changelog

| Date | Change |
|---|---|
| 2026-09-19 | Original creation-oriented draft. |
| 2026-09-20 | Rewritten as approved quote-target replacement workflow specification. |
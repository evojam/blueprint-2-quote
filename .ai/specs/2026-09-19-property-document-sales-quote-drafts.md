# RFQ PDF Intake to Catalog Match

**Date**: 2026-09-19  
**Status**: Ready for implementation — approved 2026-09-19

## TLDR

Replace the execution graph behind the existing `rfq_intake.analysis` workflow with exactly two stages: `property_documents.pdf_intake`, then `property_documents.catalog_matcher`. The accepted-RFQ subscriber and the seeded manual `ProcessDefinition` remain the only entry points. The workflow ends after matching; room analysis, quote composition, Sales quote creation, CRM stage changes, UI, migrations, and later agents are deliberately outside this slice.

## Problem Statement

`rfq_intake.analysis` currently invokes the PDF intake, then enters deferred plan/requirement commands and CRM status actions. The intended smallest useful pipeline is a verified PDF brief handed once to catalog matching. An intake result descriptor is not a matcher input: `brief.json` is a scoped `AgentRunArtifact`, so the handoff must resolve the exact correlated run and validate its stored bytes before sending text to the native matcher.

## Overview and Success Measures

- **Primary outcome:** an accepted or manually started RFQ executes `pdf_intake → catalog_matcher → END` under one trusted tenant and organization.
- **Leading indicators:** one successful correlated intake run; at most one successful matcher run for the workflow's `match_catalog` logical stage.
- **Baseline:** the current graph contains deferred downstream commands and unrelated plan/CRM steps.
- **Market / product reference:** N/A — this corrects internal orchestration using installed workflow and agent primitives; no external product behavior is adopted.

## Goals

- **REQ-001** — Reuse `rfq_intake.analysis`, its accepted-RFQ entry point, and its manual `ProcessDefinition` trigger. Do not register a second workflow or process definition.
- **REQ-002** — Invoke `pdf_intake`, then exactly one matcher invocation over the complete verified raw brief, then end.
- **REQ-003** — Derive and enforce tenant/organization scope for every run/artifact lookup and never invoke the matcher for missing, foreign, corrupt, empty, or oversized input.
- **REQ-004** — Make matcher-stage retries safe: a previously successful correlated matcher run is reused; a fresh attempt has a unique invocation identity.
- **REQ-005** — Extend `property_documents.catalog_matcher` for full-brief grouped matching while preserving its published legacy single-text contract for one minor release.

## Non-goals

- Room/page analysis, temporary Attachments, quote composition, Sales quote creation, CRM stage mutation, notifications, UI, entities, migrations, and new triggers.
- Truncating or silently segmenting an invalid/oversized brief.
- Adding any future agent before the terminal step. Those additions require a separate spec amendment and workflow phase.
- Changing `property_documents.pdf_intake`, its file contract, the Inbox subscriber, or the manual ProcessDefinition trigger model.

## Proposed Solution

`rfq_intake.analysis` retains its stable ID and existing start seams, but its graph becomes `START → extract_pdf → match_catalog → END`. `extract_pdf` remains the built-in `INVOKE_AGENT` activity for `property_documents.pdf_intake`; `match_catalog` is the existing workflow-safe `rfq_intake.requirements.match` command.

The command derives trusted scope from its workflow command context, finds the successful intake `AgentRun` by scope, workflow instance, and `PDF_AGENT_ID`, validates that its artifact outcome names `brief.json`, then validates the scoped artifact metadata, SHA-256, JSON shape, and UTF-8 byte length. It invokes the matcher with the complete text only after that validation. Before a new call, it queries `ok` matcher runs for the same scope, workflow instance, `match_catalog` step, and matcher ID, then accepts only an output that strict-parses as the grouped v2 envelope. A successful grouped result is returned rather than rerun. A fresh attempt gets a new opaque invocation ID because `(workflowInstanceId, stepId, invocationId)` is the installed immutable execution identity.

The matcher adds a grouped full-brief mode. The existing legacy mode is retained as a bridge; the RFQ command uses only grouped mode. No data is copied into workflow context, an Attachment, an event, a log, or a new app table.

### Design Decisions and Alternatives

| Decision | Rationale | Alternative considered | Why rejected / deferred |
|---|---|---|---|
| Replace the existing graph, retain `rfq_intake.analysis` | Keeps process visibility, manual start, caller attribution, and all existing registry callers | Register a second short workflow | Duplicates processes and risks two analysis runs per RFQ |
| Read `brief.json` from `AgentRunArtifact` | This is the trusted persisted output plane for file agents | Pass outcome descriptor or filesystem path to matcher | Descriptors contain metadata, not bytes; paths are untrusted/nonportable |
| One grouped full-brief matcher run | Preserves all requirements inside the PDF while bounding work to 40 needs | Per-paragraph or truncated legacy matcher calls | Loses coverage and makes arbitrary segmentation product behavior |
| Legacy + grouped matcher union | Preserves published agent ID/contract during migration | Rename/replace matcher ID | Breaks direct callers and workflow references |
| Reuse successful correlated run, mint a new ID only after failed attempt | Avoids duplicate accepted stage results without a new app entity | New RFQ operation/checkpoint table | A migration is disproportionate for this two-stage pipeline; introduce one only with a future durable multi-agent state machine |

## Domain Vocabulary and Business Rules

| Term / invariant | Precise meaning or rule | Source of truth | Failure behavior |
|---|---|---|---|
| RFQ analysis | One execution of `rfq_intake.analysis` | Workflows + Agent Orchestrator | Missing trusted scope or process definition prevents a run |
| Accepted intake | `pdf_intake` `AgentRun` with matching scope/workflow, `status: ok`, `resultKind: artifact`, and valid artifact result | Agent Orchestrator | Matcher is not invoked |
| Raw brief | Exact `{ brief: string }` in scoped `brief.json` | `AgentRunArtifact` | Reject invalid JSON, wrong metadata/digest, empty value, or more than 65,536 UTF-8 bytes |
| Logical matcher stage | The `match_catalog` workflow step for one workflow instance | `AgentRun` query under full scope | Reuse only an `ok` matcher output strict-parsing as grouped v2; an error or legacy envelope never becomes a result |
| Fresh matcher attempt | One retry invocation with a new opaque ID | AgentRun correlation triple | Does not overwrite prior audit rows |
| Grouped matcher result | 0–40 source-grounded need groups, each matched only to scoped tool results | `property_documents.catalog_matcher` result schema and run trace | Invalid output/tool grounding is terminal |

## Users, Permissions, and Scope

| Actor | Allowed outcomes | Scope rule | Required feature IDs |
|---|---|---|---|
| RFQ acceptor | Starts the existing process after accepting the RFQ action | Subscriber resolves acting user, tenant, organization, deal, and source PDF server-side | Existing Inbox, process, workflow, and agent-run features |
| Manual process starter | Starts the seeded `rfq_intake.analysis` process | Installed ProcessDefinition derives the workflow initiator; no system fallback | `agent_orchestrator.processes.run` plus existing workflow/agent permissions |
| Workflow principal | Runs PDF intake and catalog matcher | Installed workflow principal is the authenticated triggering user; trusted scope is compared to command payload | `agent_orchestrator.agents.run`, `catalog.products.view`, and enabled workflow-safe command |

No payload field can widen scope. `tenantId` and `organizationId` are derived from command context, then compared to interpolated values. Missing scope fails closed.

## Reuse and Ownership Map

| Capability | Reuse / extend / app-own | Existing module or new module | Integration seam | Why |
|---|---|---|---|---|
| Workflow execution | reuse | `workflows`, `agent_orchestrator` | existing `rfq_intake.analysis` and `ProcessDefinition` | Preserves the business-visible process and authenticated initiator |
| PDF extraction | reuse | `property_documents` | `INVOKE_AGENT` `property_documents.pdf_intake` | File agent owns server-authored artifact generation |
| Brief-to-matcher adapter | app-own | `rfq_intake` | existing workflow-safe command | Validates/correlates durable output without file/context leakage |
| Catalog retrieval and ACL | reuse | `catalog` | `catalog.search_products`, `catalog.get_product_bundle` | Catalog remains data and authorization owner |
| Full-brief matching | extend | `property_documents` | stable `property_documents.catalog_matcher` ID | Adds grouped reasoning without a second agent ID |

## Architecture and Data Flow

```text
accepted RFQ / manual ProcessDefinition
  → rfq_intake.analysis
  → INVOKE_AGENT property_documents.pdf_intake
  → verify scoped correlated AgentRunArtifact brief.json
  → agentRuntime.run(property_documents.catalog_matcher, grouped input)
  → END
```

- **Module boundaries:** `property_documents` owns agent contracts; `catalog` owns catalog reads/ACL; `rfq_intake` owns workflow-local artifact correlation; Agent Orchestrator owns run persistence and immutable tracing.
- **Extension points:** code-defined workflow plus installed `INVOKE_AGENT` and `registerWorkflowSafeCommands`; no custom workflow activity or direct database mutation.
- **Alternatives considered:** direct artifact/file handoff is not a supported matcher input; a temporary Attachment is not needed because the matcher accepts text.
- **Compatibility:** workflow/process ID and both start seams remain stable. The matcher ID remains stable; legacy payload/result behavior stays available for one minor version.

## User Journeys

### Journey J-001 — Analyze an RFQ brief against the catalog

1. An authorized user accepts an RFQ action, or manually starts the existing process definition.
2. The existing process start resolves the authenticated initiator and scoped PDF input, then enters `rfq_intake.analysis`.
3. `extract_pdf` invokes `property_documents.pdf_intake` and persists its artifact run.
4. `match_catalog` loads the exact correlated `brief.json`, validates it, then invokes grouped matcher mode once.
5. A valid matcher result is persisted as a scoped research run and the workflow reaches `END`.
6. A missing/foreign/corrupt/rejected intake, invalid brief, unavailable scope, or matcher error fails the workflow. The system neither fabricates a match nor executes future stages.

## UI and Interaction Contracts

N/A — existing Agent Orchestrator Process, Workflow, and run pages display state. No page, widget, route, navigation, mutation surface, user-facing string, or design-system behavior changes.

## Data Models

N/A — existing scoped `AgentRun` and `AgentRunArtifact` records are reused. No entity, table, migration, or snapshot changes.

## API, Command, and Error Contracts

| Method / command | Path / ID | Auth and feature gate | Input | Success response / event | Errors and concurrency | Requirement IDs |
|---|---|---|---|---|---|---|
| Workflow activity | `INVOKE_AGENT` | Existing workflow principal + `agent_orchestrator.agents.run` | Existing scoped PDF `__files` envelope | Existing artifact result | Installed retry/cancel behavior; no change to intake | REQ-001, REQ-002 |
| Workflow-safe command | `rfq_intake.requirements.match` | Existing command enablement; trusted workflow scope | `{ tenantId, organizationId, workflowInstanceId, stepId }` | Existing grouped research `AgentRun` result | Reject foreign/missing/corrupt/empty/oversized brief; reuse only matching grouped-v2 result | REQ-002–REQ-004 |
| Agent invocation, legacy | `property_documents.catalog_matcher` | `agent_orchestrator.agents.run`, `catalog.products.view` | `{ text: string[1..4000], limit?: integer[1..10] }` | `{ kind:'research', data:{ matches, unmatchedTerms } }` | Existing provider/tool/schema failures | REQ-005 |
| Agent invocation, grouped | `property_documents.catalog_matcher` | same | `{ mode:'grouped', text: UTF-8 string[1..65536 bytes], maxNeeds: integer[1..40], limitPerNeed: integer[1..10] }` | `{ kind:'research', data:{ contractVersion:2, needs, warnings } }` | No truncation; terminal on provider/tool/schema/grounding failure | REQ-002, REQ-005 |

Grouped result contract:

```ts
type GroupedMatcherResult = {
  kind: 'research'
  data: {
    contractVersion: 2
    needs: Array<{
      needIndex: number // unique 0..39
      sourceExcerpt: string // verbatim substring of the brief, 1..500 chars
      queryTerms: string[] // unique 1..4 normalized terms
      matches: Array<{
        catalogProductId: string // copied from scoped tool result
        title: string // copied from scoped tool result
        score: number // 0.60..1
        matchedEvidence: string[] // 1..5 concrete strings
        reason: string
      }> // 0..limitPerNeed, unique IDs, descending score
      unmatchedTerms: string[] // 0..20
    }> // 0..maxNeeds
    warnings: string[] // 0..100
  }
}
```

Every group invokes `catalog.search_products` exactly once. Returned product IDs must occur in that group’s tool result. The agent never writes catalog data. `mode: 'grouped'` and `data.contractVersion: 2` are the public migration discriminators; grouped-run reuse requires the full strict v2 parse rather than field-presence heuristics.

## Events, Jobs, Notifications, and Cross-Module Flows

| Trigger | Producer | Consumer | Side effect | Retry / idempotency / audit behavior |
|---|---|---|---|---|
| Existing accepted RFQ | `rfq_intake` subscriber | existing process starter | Starts `rfq_intake.analysis` | Existing process idempotency key remains authoritative |
| Existing manual trigger | Agent Orchestrator ProcessDefinition | existing process starter | Starts the same workflow with an actor | Existing process authorization/audit applies |
| `extract_pdf` completion | Workflow engine | `rfq_intake.requirements.match` | One matcher stage | AgentRun trace is immutable; command reuses only a successful same logical stage |

No new event, queue, subscriber, timer, user task, notification, or progress surface is added.

## Security, Privacy, and Compliance

- **Authorization:** installed workflow, Agent Orchestrator, and catalog feature checks remain authoritative. No role-name check or client scope is trusted.
- **Tenant isolation:** every run/artifact query contains `tenantId`, `organizationId`, `workflowInstanceId`, expected agent ID, and `deletedAt: null`; payload scope is only an equality assertion against trusted context.
- **Sensitive data:** PDF text remains in authorized artifact storage and the in-memory matcher call. It is never copied into an entity, process context, event payload, application log, or UI response.
- **Prompt injection:** PDF text and catalog fields are untrusted data; matcher instructions keep them non-authoritative and allow only the two scoped catalog read tools.
- **Abuse and failure modes:** validate JSON/MIME/size/digest and UTF-8 byte limit before inference; reject rather than truncate. A tool/provider/schema failure is terminal, never converted into empty/fabricated matches.

## Integration Coverage

| Test ID | Level | Setup / fixture | Actions | Assertions | Requirement IDs |
|---|---|---|---|---|---|
| TEST-001 | unit | current workflow config/process definition | inspect graph, transitions, command safe-list | exactly `START → extract_pdf → match_catalog → END`; stable ID and manual/Inbox seams stay | REQ-001, REQ-002 |
| TEST-002 | unit | scoped successful intake run plus `brief.json` | execute `requirements.match` | complete exact text reaches matcher once in grouped mode; command returns its result | REQ-002, REQ-003 |
| TEST-003 | security | foreign run/artifact, malformed JSON, wrong MIME/digest, empty and 65,537-byte brief | execute command | terminal error and zero matcher calls | REQ-003 |
| TEST-004 | retry | successful grouped-v2 matcher run for same workflow/stage, then repeat command | execute command twice | second execution reuses only the v2 result and makes zero new runtime call; legacy or failed run gets a fresh invocation ID | REQ-004 |
| TEST-005 | contract | legacy and grouped matcher fixtures | register agent and parse outputs | legacy payload/result remains valid; grouped bounds, unique groups, excerpts, and result ordering are enforced | REQ-005 |

## Implementation Phases

### Phase 1 — Two-stage RFQ analysis

- **Depends on:** existing `rfq_intake.analysis`, `pdf_intake`, matcher registration, ProcessDefinition, and accepted-RFQ start path.
- **Outcome:** one scoped RFQ PDF creates one verified grouped catalog-matching run and ends without unrelated side effects.
- **Why this order / value delivered:** the complete smallest pipeline works without introducing state storage or a future-agent abstraction.
- **Deliverables:** narrowed workflow graph; narrowed workflow-safe command list; artifact-to-brief command adapter; grouped matcher contract with legacy bridge; ProcessDefinition text; focused tests; amended spec/upgrade note.
- **Independent slices / estimated commits:** serial — matcher grouped schema must exist before its command can validate a result; workflow wiring follows the command.
- **Requirements closed:** REQ-001–REQ-005.
- **Tests:** TEST-001–TEST-005.
- **Validation:** focused Jest suites, then `yarn generate && yarn typecheck && yarn lint`.
- **Exit gate:** a scoped fixture proves graph order, exactly one full-brief grouped matcher call, no call on invalid data, successful-run reuse, and legacy matcher compatibility.

## Requirement Traceability

| Requirement | Journey / surface | Data/API/event contracts | Phase | Tests | Acceptance criterion |
|---|---|---|---|---|---|
| REQ-001 | J-001, existing Process/Workflow views | stable `rfq_intake.analysis` and ProcessDefinition | Phase 1 | TEST-001 | AC-001 |
| REQ-002 | J-001 | `INVOKE_AGENT`, `requirements.match`, grouped matcher | Phase 1 | TEST-001, TEST-002 | AC-001 |
| REQ-003 | J-001 | scoped AgentRun/Artifact read and brief validation | Phase 1 | TEST-002, TEST-003 | AC-002 |
| REQ-004 | J-001 | AgentRun workflow/step/invocation correlation | Phase 1 | TEST-004 | AC-003 |
| REQ-005 | J-001 and legacy direct callers | matcher input/result union | Phase 1 | TEST-005 | AC-004 |

## Extension-Surface Traceability

| Surface | Reference capability and exact file | Classification | Phase | Self-contained test |
|---|---|---|---|---|
| Existing code workflow | `src/modules/example/workflows.ts` | emitted-example | Phase 1 | TEST-001 |
| Existing native agent definition | `src/modules/property_documents/ai-agents.ts` | currently-unbound | Phase 1 | TEST-005 |

## Migration & Backward Compatibility

`rfq_intake.analysis` and `property_documents.catalog_matcher` are public stable IDs and are not renamed or removed. The workflow’s graph is intentionally changed to the approved two-stage behavior; its old plan/CRM steps are no longer reachable from that workflow.

The matcher keeps legacy `{ text ≤ 4000, limit? }` input and its flat result envelope for at least one minor release. Grouped callers opt in explicitly with `mode: 'grouped'`, `maxNeeds`, and `limitPerNeed`, and receive `data.contractVersion: 2`; this is the documented public migration discriminator. Mark the legacy contract `@deprecated` with migration guidance to grouped mode, add an `UPGRADE_NOTES.md` entry, and include these changes in the spec-linked release note. No external API route, event ID, DB schema, or generated contract *shape* changes.

## Rollout, Migration, and Rollback

No database migration or `db:generate` is needed. Run `yarn generate` with the `ai-agents.ts` discovery change and commit the intentionally updated generated agent-registration artifacts; their export/entry shape remains unchanged. Existing tenants must retain `rfq_intake.requirements.match` in their workflow-safe command allowlist; remove `plans.analyze` and `deal.advance` from this workflow’s registration only, not from unrelated command implementations.

Rollback restores the previous code workflow graph and matcher implementation; no persisted source artifact or agent run needs conversion. The legacy matcher path remains available throughout the compatibility window.

## Risks and Tradeoffs

| Risk / tradeoff | Impact | Mitigation / detection | Residual risk |
|---|---|---|---|
| Full brief exceeds 65,536 bytes | No catalog result for unusually large PDF | byte-limit validation before model invocation and explicit terminal run error | Requires a later deliberate chunking agent/stage |
| Retry after partial failure | duplicate cost or ambiguous result | full correlation; reuse completed run; new invocation identity only after failure | A failed attempt remains an immutable audit row |
| Legacy callers depend on flat result | compatibility break | union bridge, deprecation JSDoc, upgrade note, dedicated contract test | Temporary dual contract until next minor removal window |
| Future agents are requested | accidental scope creep | terminal workflow and explicit non-goal | Each agent addition needs a spec amendment/approval |

## Acceptance Criteria

- [ ] **AC-001** — An accepted or manually started scoped RFQ executes exactly `pdf_intake → catalog_matcher → END` under existing `rfq_intake.analysis`; no second workflow or process is registered.
- [ ] **AC-002** — A valid correlated `brief.json` invokes grouped matcher mode once with its exact full text; a missing, foreign, corrupt, empty, or oversized brief invokes it zero times.
- [ ] **AC-003** — Re-executing the matcher command after a successful correlated result returns that result and starts no second accepted matcher run.
- [ ] **AC-004** — Legacy matcher input/output remains valid while grouped mode enforces its need, excerpt, tool-grounding, scope, and score bounds.

## Final Compliance Report

| Check | Status | Evidence / resolution |
|---|---|---|
| Applicable `AGENTS.md` files and routed guides/skills reviewed | pass | root rules, `om-build-workflow`, `om-spec-writing`, workflow guide, artifact-handoff lesson, installed Agent Orchestrator contract |
| Data models, APIs, events, UI, and tests are internally consistent | pass | no new data/UI/event surface; contracts map to TEST-001–TEST-005 |
| Every workflow completes end to end without a catch-all integration phase | pass | one complete two-stage Phase 1 |
| Platform-native reuse and extension points were chosen before custom code | pass | existing process/workflow, built-in `INVOKE_AGENT`, workflow-safe command, AgentRun correlation |
| UI contracts identify references, canonical components, and theme/state coverage | N/A | no changed UI surface |
| Every phase has dependencies, bounded slices, tests, value, and observable exit gate | pass | Phase 1 and AC-001–AC-004 |
| Migration and compatibility requirements are explicit | pass | legacy matcher bridge, deprecation, upgrade note, no schema migration |

Verdict: Ready for implementation

## Open Questions

N/A — on 2026-09-19 the user chose a two-stage cutover, retained accepted-RFQ plus manual triggers, and explicitly deferred future agents until later pipeline changes.

## Changelog

| Date | Change |
|---|---|
| 2026-09-19 | Replaced prior quote-draft scope with the approved two-stage RFQ PDF-to-catalog pipeline. |
| 2026-09-19 | Finalized grouped matcher migration, artifact handoff, correlation, compatibility, and Phase 1 evidence. |
| 2026-09-19 | User approved the written specification for implementation planning. |

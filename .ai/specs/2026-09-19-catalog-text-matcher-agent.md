# Catalog Text Matcher Agent

**Date**: 2026-09-19
**Status**: Ready for implementation

## TLDR

Add `property_documents.catalog_matcher`, a read-only native Agent Orchestrator agent that accepts text and returns ranked matches to any scoped `catalog_product`. It reuses `catalog.search_products` and `catalog.get_product_bundle`, requires no service marker, and never mutates catalog data. The smallest complete slice is one typed agent, one strict result schema, focused contract coverage, and a real scoped smoke run.

## Problem Statement

Property-document text needs to be mapped to catalog records, but this application does not mark services through a canonical category, tag, attribute, or product type. Filtering candidates by an absent marker would discard valid matches. The matcher therefore needs to search every catalog product available in the caller's trusted tenant and organization scope, rank grounded candidates, and return only identifiers obtained from catalog tools.

The existing catalog assistant is conversational and broad. It does not expose the narrow machine-readable result required by downstream document processing.

## Overview and Success Measures

- **Primary outcome:** valid input produces a schema-valid ranked list containing at most the requested number of catalog products, or an empty list when no candidate reaches the confidence threshold.
- **Leading indicators:** the agent is registered as native/read-only, exposes only the two approved catalog tools, and its strict result schema rejects invented fields and scores outside `0..1`.
- **Baseline:** no dedicated property-document-to-catalog matching agent exists.
- **Market / product reference:** Algolia separates retrieval from ranking and recommends observable matching evidence; Elastic recommends hybrid lexical and semantic retrieval for robust candidate ranking. This slice reuses the catalog's existing hybrid search rather than adding another index: https://www.algolia.com/doc/guides/managing-results/relevance-overview/in-depth/defining-relevance and https://www.elastic.co/docs/solutions/search/hybrid-semantic-text.

## Goals

- **REQ-001** — Map one bounded text input to ranked candidates from any scoped `catalog_product`, without requiring a service marker.
- **REQ-002** — Return a strict, explainable research result whose IDs are grounded in catalog tool responses.
- **REQ-003** — Preserve tenant, organization, user, and ACL enforcement by using only the installed scoped catalog tools.
- **REQ-004** — Return no match rather than fabricate a candidate when evidence is insufficient.

## Non-goals

- Classifying whether a catalog record represents a service.
- Searching categories, offers, prices, variants, or other catalog entities as independently matchable outcomes.
- Creating, updating, assigning, or otherwise mutating catalog or property-document records.
- Adding a new search index, embedding pipeline, API route, workflow, UI, or persistence model.
- Guaranteeing that a model-assigned relevance score is a calibrated probability.

## Proposed Solution

Implement one native `defineAgent` research agent in `src/modules/property_documents/ai-agents.ts`. Its closed read-only tool allowlist contains `catalog.search_products` and `catalog.get_product_bundle`. The agent accepts a top-level object with `text` and optional `limit`, performs one bounded hybrid search, optionally enriches the strongest candidates, and emits a strict result containing ranked matches plus unmatched terms.

The agent does not classify whether a catalog record is a service. Every `catalog_product` returned by the scoped search is eligible regardless of product type, category, tag, or custom field.

### Design Decisions and Alternatives

| Decision | Rationale | Alternative considered | Why rejected / deferred |
|---|---|---|---|
| Native `defineAgent` runtime | The job needs typed object-mode reasoning and existing read-only tools, but no files, skills, scripts, or subagents | OpenCode file agent matching the previous room-dimensions change | Adds manifest/profile/MCP/cache layers without providing a needed capability |
| Stable ID `property_documents.catalog_matcher` | Describes actual behavior without implying that catalog records carry a service classification | `property_documents.service_matcher` | Misleading while any catalog product is eligible |
| Existing catalog tools only | Preserves installed authorization, scope, hybrid search, and product-bundle semantics | New app-owned database query or search index | Duplicates platform behavior and risks scope drift |
| Model ranking after bounded retrieval | Allows semantic comparison of title, description, SKU, tags, categories, and attributes | Deterministic string-score implementation | Would underuse existing hybrid retrieval and require premature ranking policy |
| Fixed threshold `0.60` | Makes empty-result behavior explicit while keeping the value clearly advisory | Always return the top result | Produces false matches when evidence is weak |

## Domain Vocabulary and Business Rules

| Term / invariant | Precise meaning or rule | Source of truth | Failure behavior |
|---|---|---|---|
| Catalog candidate | One `catalog_product` returned by `catalog.search_products` in the active scope | Catalog tool response | Never introduce an ID absent from a tool response |
| Match | A candidate with model score `>= 0.60` and concrete positive evidence | Agent comparison over tool data | Omit below-threshold candidates |
| Score | Advisory number in `0..1`, used only for descending ranking | Agent output schema and prompt | Reject out-of-range output |
| Evidence | One to five concise facts found in input and candidate fields | Input plus search/bundle results | Do not use generic claims or hidden reasoning |
| Limit | Requested maximum result count, integer `1..10`; default `5` | Agent input | Invalid or absent values fall back to `5`; never exceed `10` |
| Unmatched term | Material input concept not supported by any returned match | Agent comparison | Return an empty array when all material concepts are matched |

Input `text` must be a trimmed non-empty string no longer than 4,000 characters. The installed native-agent contract has no per-agent input Zod schema, so the prompt treats malformed or oversized input as invalid and returns `{ matches: [], unmatchedTerms: [] }` without calling catalog tools. Output validation remains deterministic through Zod.

The search call uses `{ q: normalizedQuery, limit: candidateLimit }`, where `normalizedQuery` is one to four product/service terms derived from the full input by removing measurements, quantities, addresses, and generic location wording and normalizing inflected action terms to their catalog noun/base form. `candidateLimit = min(30, max(10, limit * 3))`. If normalization finds no product/service term, the agent returns no matches without searching and records the material input in `unmatchedTerms`. Otherwise it calls search exactly once. The agent may call `catalog.get_product_bundle` only for candidate IDs returned by that search and for no more than `limit` candidates. Matches have unique IDs, are sorted by descending score, and are truncated to `limit`.

## Users, Permissions, and Scope

| Actor | Allowed outcomes | Scope rule | Required feature IDs |
|---|---|---|---|
| Authorized staff user or workflow principal | Run the matcher and consume advisory research output | Trusted tenant and exactly one organization from runtime context | `agent_orchestrator.agents.run`, `catalog.products.view` |

`tenantId`, `organizationId`, `userId`, and granted features come from the authenticated Agent Orchestrator run context. None is accepted from agent input. The installed catalog tools fail closed when scope or feature access is missing.

## Reuse and Ownership Map

| Capability | Reuse / extend / app-own | Existing module or new module | Integration seam | Why |
|---|---|---|---|---|
| Scoped hybrid candidate retrieval | reuse | `catalog` | `catalog.search_products` | Canonical tenant/organization-scoped search |
| Product detail enrichment | reuse | `catalog` | `catalog.get_product_bundle` | Canonical categories, tags, descriptions, variants, prices, custom fields, and attribute schema |
| Typed advisory agent | app-own | `property_documents` | additive `defineAgent` entry in `ai-agents.ts` | Property-document-specific matching contract |
| Agent execution and result persistence | reuse | `agent_orchestrator` | native runtime and `research` envelope | Canonical ACL, tracing, guardrails, schema validation, and run records |

## Architecture and Data Flow

```text
Playground / INVOKE_AGENT
  -> trusted run scope + { text, limit? }
  -> property_documents.catalog_matcher
       -> derive normalized 1..4-term catalog query
       -> catalog.search_products({ q: normalizedQuery, candidateLimit })
       -> catalog.get_product_bundle({ productId }) for selected candidates
  -> strict { kind: "research", data: { matches, unmatchedTerms } }
  -> Agent Orchestrator persists advisory run result
```

- **Module boundaries:** `catalog` remains the source of truth and owns every read. `property_documents` owns only the matcher prompt and output schema. Agent Orchestrator owns execution and result validation.
- **Extension points:** additive `ai-agents.ts` discovery using the installed `defineAgent` contract.
- **Alternatives considered:** a file agent is unnecessary because the matcher has no file plane, embedded skill, sandbox script, or subagent.
- **Compatibility:** the new agent ID and result contract are additive. Once released, the ID and result fields are frozen/stable under the AI registry compatibility contract.

## User Journeys

### Journey J-001 — Match document text to catalog products

1. An authorized user or workflow invokes `property_documents.catalog_matcher` with `{ text, limit? }`.
2. The agent removes measurements and generic location wording, normalizes inflected action terms to a catalog-oriented noun or base form, and searches the active tenant and organization catalog without applying a service marker.
3. It optionally fetches details for the strongest returned candidates.
4. It returns up to `limit` grounded matches ordered by score, plus material unmatched terms.
5. Missing scope, denied `catalog.products.view`, or tool failure ends the run as an error; weak evidence returns a successful empty match list.

## UI and Interaction Contracts

N/A — no new or changed UI. The generated agent appears in the existing Agent Orchestrator list, detail, Playground, and workflow agent picker.

### UI architecture

N/A — existing installed surfaces and states are reused unchanged.

## Data Models

N/A — no entity, migration, cache, durable domain write, or new sensitive-data field. Agent Orchestrator persists the existing scoped run input and research result under its installed policy.

## API, Command, and Error Contracts

| Method / command | Path / ID | Auth and feature gate | Input | Success response / event | Errors and concurrency | Requirement IDs |
|---|---|---|---|---|---|---|
| Existing diagnostic run / workflow invocation | `property_documents.catalog_matcher` | authenticated run + `agent_orchestrator.agents.run` + `catalog.products.view` | `{ text: string[1..4000], limit?: integer[1..10] }` | `{ kind: \"research\", data: { matches: Match[], unmatchedTerms: string[] } }` | existing provider/tool/schema errors; missing scope or ACL fails closed; no domain concurrency | REQ-001–REQ-004 |

`Match` is strict and requires:

- `catalogProductId`: UUID copied from a tool response;
- `title`: non-empty catalog title copied from a tool response;
- `score`: finite number from `0` through `1`;
- `matchedEvidence`: one to five non-empty strings;
- `reason`: non-empty concise explanation.

The result payload is strict, contains at most ten unique matches, and contains at most twenty non-empty unmatched terms. No new HTTP route or command is introduced.

## Events, Jobs, Notifications, and Cross-Module Flows

N/A — no new event, job, notification, subscriber, or mutation. Durable business use continues through an existing workflow `INVOKE_AGENT` step; direct Playground execution is diagnostic.

## Security, Privacy, and Compliance

- **Authorization:** both catalog tools retain `catalog.products.view`; the native runner executes them under the caller's effective ACL.
- **Tenant isolation:** trusted scope is injected by Agent Orchestrator and enforced again by catalog tools. Input cannot supply or widen scope.
- **Sensitive data:** free text and matched catalog details remain inside the existing AI run/tool trace policy. The result excludes raw tool payloads and hidden reasoning.
- **Abuse and failure modes:** input and catalog text are untrusted data, never instructions. The closed tool allowlist prevents writes. IDs, titles, and evidence must be copied from tool results. Missing tools, ACL, scope, or provider configuration fail the run rather than returning invented data.

## Integration Coverage

| Test ID | Level | Setup / fixture | Actions | Assertions | Requirement IDs |
|---|---|---|---|---|---|
| TEST-001 | contract | import property-documents agents and load registry | inspect `property_documents.catalog_matcher` | native runtime, research result, researcher type, max four steps, exact two-tool allowlist, runnable sample | REQ-001, REQ-003 |
| TEST-002 | schema | use the registered agent result schema | parse valid and invalid research envelopes | accepts strict ordered match shape; rejects wrappers, extra fields, duplicate/over-limit matches, empty evidence, and out-of-range scores | REQ-002, REQ-004 |
| TEST-003 | live scoped smoke | configured model and seeded catalog in one tenant/org | invoke sample text through actual Agent Orchestrator runtime | every ID exists in captured catalog tool results; count respects limit; output is score-sorted; no mutation call occurs | REQ-001–REQ-004 |

## Implementation Phases

### Phase 1 — Complete read-only catalog matcher

- **Depends on:** none
- **Outcome:** the application discovers and can run the typed matcher end to end.
- **Why this order / value delivered:** schema, prompt, tool allowlist, registry entry, and smoke evidence form one coupled executable contract.
- **Deliverables:** result schema, native agent definition, updated brief, focused tests, generated registry output, and live smoke evidence.
- **Independent slices / estimated commits:** one cohesive slice; no parallel ownership needed.
- **Requirements closed:** REQ-001–REQ-004
- **Tests:** TEST-001–TEST-003
- **Validation:** focused Jest test, `yarn generate`, `yarn typecheck`, `yarn lint`, then a real scoped run.
- **Exit gate:** a real sample returns either grounded score-sorted matches within the requested limit or an honest empty list, and registry inspection proves the closed read-only tool set.

## Requirement Traceability

| Requirement | Journey / surface | Data/API/event contracts | Phase | Tests | Acceptance criterion |
|---|---|---|---|---|---|
| REQ-001 | J-001, existing Playground/workflow | additive agent ID and bounded input | Phase 1 | TEST-001, TEST-003 | AC-001 |
| REQ-002 | J-001 | strict research result schema | Phase 1 | TEST-002, TEST-003 | AC-001, AC-002 |
| REQ-003 | J-001 | installed scoped catalog tools | Phase 1 | TEST-001, TEST-003 | AC-003 |
| REQ-004 | J-001 | threshold and empty-result rule | Phase 1 | TEST-002, TEST-003 | AC-002 |

## Rollout, Migration, and Rollback

No migration or setup change. Roll out by running generation and restarting the application processes that cache discovered agent definitions. Roll back by removing the additive agent definition, schema, tests, and generated output before consumers depend on the ID.

### Migration & Backward Compatibility

This change adds one new stable AI agent ID and does not modify existing IDs, tool contracts, APIs, schemas, or generated registry shapes. After release, `property_documents.catalog_matcher` and its required output fields must not be renamed or removed without the repository's deprecation protocol.

## Risks and Tradeoffs

| Risk / tradeoff | Impact | Mitigation / detection | Residual risk |
|---|---|---|---|
| Model score is not calibrated | Consumers may over-trust small score differences | Document advisory semantics, threshold weak matches, expose concrete evidence | Human review may still be needed |
| Search returns a narrow candidate set | Correct product may never reach model ranking | Normalize the input to 1–4 catalog-oriented terms before one hybrid search and retrieve up to three times requested limit, capped at 30 | Index quality and model query normalization still bound recall |
| Product data contains prompt-like text | Candidate content could try to redirect the model | Explicit untrusted-data rule and closed read-only tool allowlist | Provider guardrails remain probabilistic |
| Native contract lacks an input Zod schema | Malformed input rejection is prompt-enforced | Exact input instructions and live invalid-input smoke when runtime is available | Not equivalent to deterministic request validation |
| Bundle calls consume steps/tokens | Large requests could be slow or expensive | `limit <= 10`, candidate cap 30, bundle cap equal to result limit, loop max four | Provider latency remains external |

## Acceptance Criteria

- [ ] **AC-001** — Running `property_documents.catalog_matcher` with the sample text and `limit: 5` returns no more than five unique matches sorted by descending score, with every ID and title grounded in catalog tool results.
- [ ] **AC-002** — Every returned match has score `>= 0.60`, concrete evidence, and a concise reason; no credible match produces `matches: []` rather than a fabricated record.
- [ ] **AC-003** — The agent is native and read-only, exposes only `catalog.search_products` and `catalog.get_product_bundle`, and missing catalog ACL or trusted scope fails closed.
- [ ] **AC-004** — With scoped product `Malowanie ścian`, input `Pomalowanie lokalu 120 m²` retrieves and returns that product without listing the unfiltered catalog.

## Final Compliance Report

| Check | Status | Evidence / resolution |
|---|---|---|
| Applicable `AGENTS.md` files and routed guides/skills reviewed | pass | root rules, AI workflow guide, Agent Orchestrator 0.8.0 rules, catalog 0.8.0 rules, compatibility contract |
| Data models, APIs, events, UI, and tests are internally consistent | pass | no new model/API/event/UI; traceability maps the additive agent contract |
| Every workflow completes end to end without a catch-all integration phase | pass | one bounded native-agent journey and one complete phase |
| Platform-native reuse and extension points were chosen before custom code | pass | installed `defineAgent`, scoped catalog tools, native runtime |
| UI contracts identify references, canonical components, and theme/state coverage | pass | N/A — installed Agent Orchestrator surfaces are unchanged |
| Every phase has dependencies, bounded slices, tests, value, and an observable exit gate | pass | Phase 1 defines tests, validation, and a live-run exit gate |

Verdict: Ready for implementation

## Open Questions

N/A — the user approved the native runtime, stable ID, all-product eligibility, thresholded ranked result, and read-only tool scope on 2026-09-19.

## Changelog

| Date | Change |
|---|---|
| 2026-09-19 | Initial ready specification based on `agent-catalog.md`, the approved design, and installed Open Mercato 0.8.0 contracts |

# RFQ Analysis to Sales Quote Draft

**Date**: 2026-09-19  
**Status**: Ready — approved 2026-09-19

## TLDR

Extend the existing code-defined workflow `rfq_intake.analysis` and its seeded Agent Orchestrator `ProcessDefinition`; do **not** add a second workflow, a second process definition, or an `EXECUTE_FUNCTION` activity.

```text
property_documents.pdf_intake
├─ every pdf-page-####.png → property_documents.room_dimensions once per page
└─ complete raw brief ─────→ property_documents.catalog_matcher once
                                      ↓
                property_documents.quote_draft_composer once
                                      ↓
                  deterministic editable Sales quote draft
```

`catalog_matcher` owns bounded multi-need discovery inside its single run and performs one grounded Catalog search per detected need. `room_dimensions` runs for every generated page PNG; pages without visible rooms return an empty result. Existing Sales **Send quote** remains the human approval boundary.
## Rebased Baseline

The rebase brought these already-implemented contracts from `main`:

- workflow ID `rfq_intake.analysis`, triggered by `rfq_intake.rfq.created`;
- scoped Agent Orchestrator `ProcessDefinition` pointing at that workflow, with a manual trigger, setup seeding, `seed-process [--force]`, and query-index publication;
- `CustomerDeal` as the RFQ/case anchor;
- stage movement `new → quoting → review`;
- `INVOKE_AGENT` for `property_documents.pdf_intake`;
- command `rfq_intake.plans.analyze`, invoking `room_dimensions` once per plan artifact;
- command `rfq_intake.requirements.match`, invoking `catalog_matcher` once per requirement;
- deterministic workflow correlation through `workflowInstanceId`, `stepId`, and invocation IDs;
- `rfq_intake` action/subscriber wiring from accepted Inbox RFQ to the workflow, including propagation of `executedByUserId` as event `userId`.

The current graph ends after catalog matching. This slice adds composition and quote creation to that graph and hardens the artifact handoff used by the existing plan step.

## Approved Raw-Input Contract

The approved intake amendment changes `property_documents.pdf_intake` to strict `{ brief: rawText }`, strict non-semantic `pdf-pages.json`, and one captured `pdf-page-####.png` per PDF page. Installed Agent Orchestrator 0.8.0 caps `AgentResult.artifacts` at 20, so the result names only the two JSON control artifacts while the file plane captures the full set as scoped `AgentRunArtifact` rows. This specification reuses the intake amendment's post-return validator for the exact inventory-declared/captured set and does not recreate parsing inside intake.

Downstream behavior is now resolved:

1. `rfq_intake.plans.analyze` materializes every validated `pdf-page-####.png` through the scoped app bridge and invokes `room_dimensions` exactly once per page, with concurrency 3. The PDF limit is the intake contract's `MAX_PDF_PAGES = 48`; this stage does not retain the old `MAX_ITEMS = 40` page truncation.
2. `rfq_intake.requirements.match` strict-parses captured `brief.json` and invokes `catalog_matcher` exactly once with the complete raw brief. Inside that run, the matcher identifies at most 40 bounded needs and performs one scoped Catalog search per need.

There is no separate page-classification or brief-segmentation stage. A non-plan page legitimately yields no rooms. Need discovery is part of the matcher contract and its grouped result, not another workflow activity.
## Requirements

- **REQ-001** — Extend the existing `rfq_intake.analysis` workflow rather than registering a second document-analysis workflow.
- **REQ-002** — Preserve the logical order `pdf_intake → room_dimensions once per generated page PNG → catalog_matcher once over the complete raw brief → quote_draft_composer`, accepting at most one result for each logical invocation.
- **REQ-003** — Create at most one editable, unsent `SalesQuote` per scoped workflow instance when at least one line has grounded quantity evidence and a valid current Catalog price.
- **REQ-004** — Every emitted quote line must reference a product returned by the corresponding matcher result; the model cannot choose prices, variants, currency, tenant, organization, customer, or channel.
- **REQ-005** — Unmatched needs, failed page analyses, invalid quantities, and missing prices become bounded warnings. Zero valid priced lines creates no quote and still leaves the RFQ in the human-review stage with an actionable result.
- **REQ-006** — Retries and crash recovery must not duplicate accepted agent results, temporary page Attachments, Sales quote numbers, or Sales quotes.
- **REQ-007** — All reads and writes fail closed on trusted tenant and organization scope.

## Non-goals

- A second Process Definition or replacement process cockpit. The seeded definition for `rfq_intake.analysis` is reused; milestones, outcome schema, and manual-start UX remain unchanged.
- A second workflow for the same RFQ document chain.
- A custom Workflow activity type or `EXECUTE_FUNCTION` bridge.
- A new quote approval UI. Existing Sales edit/send behavior is reused.
- Multiple source PDFs in one RFQ. The subscriber selects exactly one scoped PDF; zero or multiple PDFs is an actionable analysis error.
- Variant selection without explicit variant evidence from a future matcher contract.
- Automatically sending the quote.

## Domain Vocabulary and Invariants

| Term | Contract | Source of truth | Failure behavior |
|---|---|---|---|
| RFQ | Existing scoped `CustomerDeal` opened from the accepted Inbox action | `customers` | Missing/foreign deal fails closed |
| Source action | Executed `InboxProposalAction` that opened the RFQ | `inbox_ops` | Missing/foreign/inactive action fails quote preparation |
| Source PDF | Exactly one scoped PDF Attachment selected from the source e-mail | Attachments + Inbox e-mail | Zero/multiple PDFs creates an idempotent visible rejection outcome; no workflow or AgentRun starts |
| Process definition | Existing scoped Agent Orchestrator definition that points at `rfq_intake.analysis`; it is a business-facing entry/projection, not an execution graph | `agent_orchestrator.process_definitions` + `rfq_intake` seeder | Missing row affects cockpit discoverability/manual start, not the code event trigger; DB `workflow_definitions` shadowing is a separate contract |
| Page result | One accepted `room_dimensions` result per validated `pdf-page-####.png` | correlated `AgentRun` | Non-plan page may return no rooms; individual failure is recorded and remaining pages continue |
| Matcher result | One accepted `catalog_matcher` run containing at most 40 source-grounded need groups | correlated `AgentRun` | Failed run is terminal; individual needs may be unmatched |
| Composer result | One strict research result over all bounded brief/room/matcher evidence | `property_documents.quote_draft_composer` | Invalid result is terminal; no business mutation occurs |
| Grounded line | Matcher product ID + positive quantity + structured evidence references | composer output replayed by deterministic command | Invalid or ambiguous line is omitted with a warning |
| Quote customer | The RFQ's single linked company when present, otherwise its primary linked person | Customers read contract | Missing or ambiguous customer prevents quote creation |
| Quote channel | Scoped action payload `channelId`, otherwise installed first-channel resolution | Inbox action + installed Sales helper | Missing/foreign channel prevents quote creation |
| Quote currency | Active scoped action currency, otherwise installed channel-currency resolution | Inbox action + Currencies | Missing/inactive/foreign currency prevents quote creation |
| Authoritative price | Scoped product-level candidates in quote currency, resolved through `catalogPricingService.resolvePrice`, then identity-validated | Catalog pricing service | Missing, variant, substituted, foreign, or invalid result omits the line |
| Approval | Existing Sales **Send quote** action | Sales | Draft remains unsent until operator action |

## Existing Workflow Extension

The workflow ID and trigger remain unchanged:

```text
rfq_intake.rfq.created
→ rfq_intake.analysis
```

Revised graph:

```text
START
→ mark_quoting                         existing UPDATE_ENTITY
→ prepare_analysis                     new UPDATE_ENTITY command
→ extract_pdf                          existing INVOKE_AGENT pdf_intake
→ measure_plans                        existing stable step/command ID, now all page PNGs
→ match_catalog                        existing command ID, one raw-brief run
→ compose_quote                        new UPDATE_ENTITY command
→ create_quote_draft                   new UPDATE_ENTITY command
→ mark_review                          existing UPDATE_ENTITY, moved after quote attempt
→ END
```

Agent view:

```text
pdf_intake
→ room_dimensions × every validated page PNG, concurrency 3
→ catalog_matcher × 1 complete raw brief
→ quote_draft_composer × 1
```

`prepare_analysis`, `create_quote_draft`, and stage movements are deterministic commands, not AI-agent stages. `measure_plans` keeps its existing step ID for compatibility but expands to every page PNG; `match_catalog` keeps its step ID and changes to one raw-brief run. Both remain workflow-safe commands because the engine has no dynamic fan-out and cannot express the matcher's internal multi-search loop as static transitions.

### Why no `EXECUTE_FUNCTION`

The existing workflow already uses the platform-native pattern needed here: built-in `INVOKE_AGENT` for the direct intake step and workflow-safe `UPDATE_ENTITY` commands for dynamic fan-out and deterministic mutations. Adding `EXECUTE_FUNCTION` would create a second orchestration convention without solving a missing capability.

The commands use `registerWorkflowSafeCommands` and strict interpolation, matching the existing module.

### Existing Agent Orchestrator process

The seeded scoped `ProcessDefinition` continues to point at `rfq_intake.analysis`. It does not duplicate or shadow the code workflow; only a core Workflows `workflow_definitions` row with the same workflow ID can shadow code registration.

This slice keeps the existing process name and updates both the code workflow description and the process description to describe all-page room analysis, one grouped raw-brief match, composition, and quote drafting. Process reconciliation changes from whole-array trigger ownership to a merge: it preserves every existing operator trigger and existing manual-trigger restriction, appending the default manual trigger only when no manual trigger exists. Because the installed trigger list is capped at 20, a definition with 20 non-manual triggers fails reconciliation atomically with bounded `process_trigger_capacity_exhausted`; the operator must free a slot before retrying. It also preserves milestones, UI metadata, and every other operator-owned field. The manual entry remains diagnostic: callers must supply the same scoped action/deal/PDF context, and `prepare_analysis` fails closed when it is absent.

## Event and Input Changes

`rfq_intake.rfq.created` gains the stable source action and authenticated actor while preserving existing fields:

```ts
{
  actionId,
  userId,
  dealId,
  proposalId,
  emailId,
  tenantId,
  organizationId,
  __files: { attachments: [{ attachmentId: selectedPdfAttachmentId }] }
}
```

The subscriber re-reads the executed action and keeps the implemented actor field: trusted `executedByUserId` becomes event `userId`. For a valid source it additionally emits with explicit trusted event options `{ persistent: true, tenantId, organizationId }`; payload scope alone is not trusted by the Workflow wildcard subscriber. The workflow maps `actionId`, `userId`, and `__files` into context, so built-in and custom activities execute under the authenticated actor and declared grants.

Before emission, the subscriber resolves the executed action, proposal, e-mail, deal, and Attachments in trusted scope and filters attachments by PDF media type:

- exactly one PDF: emit the scoped workflow event;
- zero or multiple PDFs: execute idempotent app command `rfq_intake.analysis.reject`, persist a `review_required` operation with bounded failure code, move the deal to review, and emit no workflow event or AgentRun.

The rejection command keys the operation by source action and makes the reason visible in the RFQ analysis widget. Events and operation rows contain IDs/codes only, never document content or model output.
## Commands and Stable IDs

| Command | Purpose | Required behavior |
|---|---|---|
| `rfq_intake.analysis.reject` | Persist an invalid source-cardinality outcome outside the workflow | Idempotent by scoped action; no AgentRun; move deal to review |
| `rfq_intake.analysis.prepare` | Revalidate source action/deal/PDF, bind the operation, and resolve scoped quote configuration | No agent runs before source validation succeeds |
| `rfq_intake.plans.analyze` | Materialize and analyze every captured page PNG | Exact validated artifact set; one room run per page; concurrency 3; retry-safe |
| `rfq_intake.requirements.match` | Invoke the matcher once with captured raw brief | One accepted run; matcher performs bounded per-need searches; retry-safe |
| `rfq_intake.quote.compose` | Load strict correlated evidence and invoke `quote_draft_composer` once | No price/scope/business mutation in agent input or output |
| `rfq_intake.quote.create` | Replay evidence, resolve pricing, create/recover the Sales quote, and persist the visible outcome | At most one quote; zero valid lines returns warnings without a quote |
| `rfq_intake.deal.advance` | Existing pipeline transition | `review` runs after quote attempt; rejection uses the same transition contract |

The workflow commands use `registerWorkflowSafeCommands` with strict interpolation. `rfq_intake.analysis.reject` is invoked by the scoped subscriber, not by Workflow. The existing `plans.analyze` and `requirements.match` IDs remain stable even though their input artifacts change with the approved intake cutover.
## Agent Contracts

### Existing agents

- `property_documents.pdf_intake`: one PDF; amended contract produces strict `{ brief: rawText }`, strict `pdf-pages.json`, and one captured `pdf-page-####.png` per source page.
- `property_documents.room_dimensions`: exactly one staged PNG; returns structured rooms/dimensions or an empty `data` array when the page contains no supported room evidence.
- `property_documents.catalog_matcher`: one complete raw brief up to 65,536 UTF-8 bytes; discovers at most 40 source-grounded needs, performs one bounded Catalog search per need, and returns grouped candidates without price.

### New composer agent

Stable ID: `property_documents.quote_draft_composer`.

The amended matcher contract is:

```ts
type CatalogMatcherInput = {
  text: string // complete brief, 1..65,536 UTF-8 bytes
  maxNeeds: 40
  limitPerNeed: 5
}

type CatalogMatcherResult = {
  kind: 'research'
  data: {
    needs: Array<{ // 0..40, unique needIndex
      needIndex: number // integer 0..39
      sourceExcerpt: string // exact brief substring, 1..500 chars
      queryTerms: string[] // 1..4 unique terms, each 1..100 chars
      matches: Array<{ // 0..5, unique catalogProductId
        catalogProductId: string
        title: string // 1..500 chars
        score: number // 0.6..1
        matchedEvidence: string[] // 1..5 entries, each 1..500 chars
        reason: string // 1..1,000 chars
      }>
      unmatchedTerms: string[] // 0..20 entries, each 1..500 chars
    }>
    warnings: string[] // 0..100 entries, each 1..500 chars
  }
}
```

The command rejects an empty brief or more than 65,536 UTF-8 bytes before invoking the matcher; it never truncates. The matcher emits at most 40 unique need groups, each with an exact bounded excerpt copied from the complete brief, and calls `catalog.search_products` exactly once per group. Independent searches may be issued together. Acceptance validates the AgentRun trace: every group has one matching query call, and every `catalogProductId` occurred in that call's scoped result. Duplicate groups, excerpts not found verbatim in the brief, more than four query terms, missing/extra searches, invented IDs, and cross-group substitution are rejected.

Composer input is a bounded deterministic projection:

```ts
type QuoteDraftComposerInput = {
  matcherRunId: string
  needs: Array<{
    needIndex: number
    sourceExcerpt: string
    candidates: Array<{
      productId: string // deterministic projection of catalogProductId
      title: string
      score: number
      evidence: string[] // deterministic projection of matchedEvidence
      reason: string
    }>
  }>
  pages: Array<{
    sourcePage: number
    pageArtifactId: string
    roomRunId: string
    rooms: RoomObservation[]
  }>
}

type RoomDimensionRef = {
  kind: 'room_dimension'
  roomRunId: string
  roomId: string
  dimensionIndex: number
}

type QuoteLineDerivation =
  | {
      kind: 'brief_explicit'
      formula: 'identity'
      evidence: { kind: 'brief_need'; needIndex: number }
    }
  | {
      kind: 'room_measurement'
      formula: 'identity'
      evidence: RoomDimensionRef
    }
  | {
      kind: 'room_area' | 'room_perimeter'
      formula: 'rectangle_area' | 'rectangle_perimeter'
      evidence: {
        horizontal: RoomDimensionRef
        vertical: RoomDimensionRef
      }
    }

type QuoteDraftComposerResult = {
  kind: 'research'
  data: {
    lines: Array<{ // 0..40, unique needIndex
      needIndex: number
      productId: string
      quantity: number
      quantityUnit: string | null
      derivation: QuoteLineDerivation
      description: string // 1..1,000 chars
    }>
    unresolvedNeeds: Array<{ // 0..40, unique needIndex
      needIndex: number
      reason: string // 1..1,000 chars
    }>
    warnings: string[] // 0..100 entries, each 1..500 chars
  }
}
```

Candidate input is limited to the top three matcher results per need, with the bounds above. The composer cannot return tenant/organization/customer/channel/currency, variant, price, tax, discount, or quote status. Every `productId` must occur in that need's matcher candidates.

Each matcher `needIndex` must appear exactly once across the composer result: either one quote line or one unresolved entry. Duplicate lines, duplicate unresolved entries, missing need indexes, and resolved/unresolved overlap reject the whole composer result. Evidence references are typed coordinates, never model-authored reasoning. The create command reloads the accepted matcher and room runs in scope. A brief quantity is accepted only when a narrow deterministic parser finds exactly one positive quantity/unit in the referenced `sourceExcerpt` and it matches the proposed quantity after canonical conversion. Area/perimeter requires one horizontal and one vertical dimension from the same room.
## Quantity, UoM, and Pricing

The deterministic create command replays every derivation against source evidence:

- `brief_explicit`: exact positive quantity stated in the brief;
- `room_measurement`: one explicit measurement from one referenced room;
- `room_area`: `horizontal × vertical` from one unambiguous room;
- `room_perimeter`: `2 × (horizontal + vertical)` from one unambiguous room.

It canonicalizes units through Dictionaries/Catalog and requires the product base/default sales unit or an active conversion. Unsupported or ambiguous derivations are omitted.

Pricing flow per valid line:

1. load the matched product in trusted tenant/organization;
2. build current product-level price candidates for the resolved currency (`productVariantId = null`);
3. call `catalogPricingService.resolvePrice(rows, { channelId, customerId, quantity, date })`;
4. require the returned price ID and product/variant/currency identity to belong to the original candidate map;
5. re-read that price ID in scope and validate resolver-adjusted amount/tax values;
6. pass the normalized Sales line to `sales.quotes.create`.

A pricing extension may adjust amount/tax for the same price identity. It may not introduce a foreign product, variant, currency, or row.

## Artifact Handoff Correction

The existing `rfq_intake.plans.analyze` calls proposal-only command `agent_orchestrator.artifact.promote`, but RFQ analysis has no approved `attachments.attach_artifact` proposal. Remove that call.

Replacement:

- reuse the intake amendment's post-return validator for captured `brief.json`, strict `pdf-pages.json`, and the exact inventory-declared `pdf-page-####.png` set in trusted scope;
- strict-parse the captured brief bytes and pass the complete `brief` string to the one matcher invocation;
- materialize every page artifact as one scoped temporary Attachment through the public Attachment service;
- atomically persist `{ artifactId, attachmentId, sourcePage }` in the operation through the service's transactional link callback;
- invoke `room_dimensions` once for every mapping and return existing mappings/runs on retry.

No page is classified or filtered before room analysis. No installed file or `AgentRunArtifact.promotedAttachmentId` is modified.
## Data Model

### `RfqQuoteDraftOperation`

Table: `rfq_intake_quote_draft_operations`.

| Field | Contract |
|---|---|
| `id` | UUID primary key |
| `tenant_id`, `organization_id` | required trusted scope; leading composite indexes |
| `action_id`, `deal_id` | required scalar cross-module IDs; scoped action unique key; no ORM relation |
| `workflow_instance_id` | nullable until a valid event starts; scoped unique when present |
| `input_hash` | normalized IDs + workflow contract version; replay mismatch fails |
| `source_pdf_count` | bounded source-cardinality diagnostic |
| `analysis_checkpoint` | bounded JSONB containing logical stage/attempt IDs, accepted run IDs, artifact-to-Attachment mappings, and warning codes/counts; no raw model/document content |
| `composer_run_id` | accepted composer AgentRun ID, nullable until composed |
| `customer_entity_id`, `channel_id`, `currency_code` | nullable until scoped resolution succeeds; no untrusted fallback |
| `reserved_quote_number` | nullable until generated once immediately before Sales creation |
| `quote_id` | nullable scalar SalesQuote ID, set once |
| `status` | `analyzing | composed | creating | completed | review_required | failed` |
| `failure_code` | bounded non-sensitive diagnostic code |
| `created_at`, `updated_at` | framework-managed timestamps |

The rejection path creates or reloads the operation by scoped `action_id`. The valid workflow's prepare step locks that row, verifies its input hash and non-rejected state, then binds `workflow_instance_id`; it never creates a second operation for the same action.

One migration and snapshot are generated and reviewed. The migration is never applied without explicit approval.
## Correlation and Recovery

A version-pinned app adapter reads Agent Orchestrator 0.8.0 `AgentRun`, `AgentRunSession`, and `AgentRunArtifact` rows using full trusted scope plus exact workflow/step/invocation predicates.

Logical invocation keys:

- PDF: existing workflow activity correlation;
- room: `page:<artifactId>:<attempt>`;
- matcher: `raw-brief:<briefArtifactId>:<attempt>`;
- composer: `quote-composer:<attempt>`.

Rules:

- terminal `ok`: strict-parse and accept once;
- terminal `error`: one replacement attempt, then unresolved/terminal according to stage policy;
- `cancelled`: terminal non-success;
- `running`: wait/reload until the persisted deadline; after the deadline atomically abandon only the logical attempt and expire its orphanable session rows;
- late output from an abandoned attempt remains trace-only;
- room failures remain bounded per-page warnings; the single matcher or composer run failing is terminal.

The adapter never performs an unlocked read followed by the installed unconditional run-failure command.

## Quote Idempotency

`rfq_intake.quote.create` claims the operation and:

1. returns the stored `quoteId` when completed;
2. rejects a mismatched `input_hash`;
3. resolves customer/channel/currency again in trusted scope;
4. validates and prices all grounded lines;
5. when zero valid lines remain, sets `review_required`, persists bounded warning codes for the RFQ widget, and returns without a quote;
6. reserves one Sales quote number and stores it before calling Sales;
7. calls `sales.quotes.create` with metadata `{ rfqDealId, rfqActionId, workflowInstanceId, operationId }`;
8. after a crash, searches the scoped Sales contract by reserved number and verifies `metadata.operationId` before retrying;
9. stores exactly one `quoteId`.

The scoped Sales quote-number unique constraint is the final duplicate barrier.

## Permissions and Scope

The workflow-safe command declarations and workflow execution principal must cover the exact installed features used by the extended graph:

- `customers.people.view`, `customers.companies.view`, `customers.deals.view`, `customers.deals.manage`;
- `inbox_ops.proposals.view`;
- `attachments.view`, `attachments.manage`;
- `agent_orchestrator.agents.view`, `agent_orchestrator.agents.run`, `agent_orchestrator.trace.view`;
- `catalog.products.view`, `dictionaries.view`, `currencies.view`;
- `sales.channels.view`, `sales.settings.view`, `sales.quotes.view`, `sales.quotes.manage`, `sales.documents.number.edit`.

Process cockpit users need `agent_orchestrator.processes.view`; manual diagnostic starts additionally need `agent_orchestrator.processes.run`. Those features do not become Workflow execution-principal grants. `seed-process --force` is an operator CLI reconciliation path, not a runtime permission.

All six RFQ Workflow command IDs are intentionally not `defaultEnabled`: existing `rfq_intake.deal.advance`, `rfq_intake.plans.analyze`, `rfq_intake.requirements.match`, plus new `rfq_intake.analysis.prepare`, `rfq_intake.quote.compose`, and `rfq_intake.quote.create`. Rollout must read the tenant's current workflow-command allowlist and persist its union with all six IDs through the installed configuration path; it must not replace or narrow unrelated enabled entries. An unset policy/new organization enables none of them until this explicit step, so readiness fails before any RFQ is accepted when one is missing.

Every command derives tenant and organization from trusted Workflow command context. Payload scope is compared to trusted scope and never broadens it. Missing scope is an error, not unrestricted access.

## UI Contract

No new page is authored. A read-only `rfq_intake` UMES widget is added to the existing Customer Deal detail:

- it loads the latest operation by `dealId` under trusted tenant/organization and `customers.deals.view`;
- it shows localized analysis state and bounded warning/failure codes under Deal view permission;
- it returns and renders `quoteId`/the Sales quote link only when the caller also has `sales.quotes.view`; otherwise quote existence/identity is omitted, not merely linked to an inaccessible page;
- it covers loading, empty, and error states and exposes no raw document/model content;
- it makes invalid-PDF, missing-configuration, and zero-valid-line outcomes actionable even when no quote exists.

Successful creation still produces an existing Sales quote in draft/unsent state. Operators use the existing Sales quote detail to edit lines, dates, customer/channel/currency, comments, and prices. Existing **Send quote** remains the only approval/send action. Quote comments may carry bounded unresolved warnings; quote metadata contains IDs/counts only.
## Failure Behavior

| Failure | Result |
|---|---|
| Invalid/foreign action, deal, or scope | fail closed with no workflow or business write |
| Zero or multiple scoped source PDFs | no workflow or AgentRun; one `review_required` operation; deal moves to review; widget shows localized correction |
| Captured brief/page set is incomplete | stop before semantic agents; bounded widget failure |
| One page materialization or room run fails | continue remaining pages; warning |
| Non-plan page | accepted empty room result; not an error |
| Empty raw brief or raw brief over 65,536 UTF-8 bytes | matcher and composer are skipped; operation records `brief_empty` or `brief_too_large`; quote creation resolves `review_required`; widget shows correction; raw input is never truncated |
| Matcher run fails or grouped result is invalid | workflow fails; no composer/quote; widget shows bounded failure |
| One matcher need has no candidates | unresolved need; continue |
| Composer result invalid | workflow fails; no quote; widget shows bounded failure |
| Missing customer/channel/currency | no quote; operation `review_required`; deal moves to review; widget shows corrective warning |
| Invalid quantity/UoM/price | omit line; warning |
| Zero valid lines | no quote; operation and widget show review-required outcome |
| Sales create crashes after commit | recover same quote by reserved number + operation metadata |
| Existing DB-customized workflow shadows `rfq_intake.analysis` | rollout stops; do not silently deploy code steps that will not execute |
## Integration Coverage

| Test | Level | Observable contract |
|---|---|---|
| TEST-001 | workflow definition | Existing `rfq_intake.analysis` executes intake → page fan-out → one matcher → composer → quote create → review; no second workflow or `EXECUTE_FUNCTION` |
| TEST-002 | event/security | Valid source emits scoped `actionId`, implemented actor field `userId`, exactly one PDF, and explicit tenant/organization event options; foreign data fails closed |
| TEST-003 | invalid source | Zero/multiple PDFs create one visible review outcome and no workflow/AgentRun, including on redelivery |
| TEST-004 | page handoff | Every captured PNG becomes one scoped Attachment and one room invocation without `agent_orchestrator.artifact.promote`; retry reuses mappings/runs |
| TEST-005 | non-plan page | Text/cover PNG produces an accepted empty room result and does not block later pages |
| TEST-006 | matcher fan-in | Complete raw brief produces exactly one matcher AgentRun, at most 40 source-grounded need groups, and exactly one Catalog search per need |
| TEST-007 | matcher security | Non-verbatim excerpt, extra search, duplicate need, invented/foreign product ID, and cross-group substitution are rejected |
| TEST-008 | composer contract | Product IDs come only from that need's matcher candidates; typed references replay; collection/string bounds, exact need partition, duplicate lines, missing needs, and resolved/unresolved overlap are enforced |
| TEST-009 | quote integration | Configured customer/channel/currency and valid Catalog data produce exactly one editable unsent quote linked by metadata to the deal/action/workflow |
| TEST-010 | partial result | Failed page, unmatched need, invalid quantity, and unpriced product produce bounded warnings; valid lines still create one partial draft |
| TEST-011 | zero-line result | No valid priced line creates no quote, sets review-required outcome, moves the deal to review, and surfaces correction in the deal widget |
| TEST-012 | security | Foreign action/deal/run/artifact/product/price/customer/channel/currency IDs fail closed with no leaked output or write; a Deal-only user receives status but no `quoteId`/quote link |
| TEST-013 | recovery | Crashes after agent success, Attachment commit, quote-number reservation, and Sales create recover accepted runs/mappings/the same quote without duplicates |
| TEST-014 | pricing extension | Same-identity resolver adjustment is accepted; unknown/variant/foreign-currency/substituted price identities are rejected |
| TEST-015 | browser smoke | Deal widget exposes success/no-quote outcomes; quote-authorized users can open the generated editable unsent quote with existing Send quote action, while Deal-only users see no quote link |
| TEST-016 | raw-brief bounds | 65,536 UTF-8 bytes is accepted intact; empty, 65,537-byte, and multibyte-over-limit briefs create visible review outcomes with zero matcher/composer runs and no truncation |
| TEST-017 | process projection | Exactly one scoped ProcessDefinition points at `rfq_intake.analysis`; updated descriptions are indexed; force preserves milestones/UI metadata, schedule/event triggers, and existing manual-trigger restrictions while ensuring a manual trigger exists; 20 non-manual triggers fail without mutation; missing manual context fails in prepare |
| TEST-018 | command enablement | Unset/partial policy blocks execution; rollout unions all six RFQ command IDs into the tenant allowlist without removing unrelated enabled IDs |
## Implementation Phase

### Phase 1 — Extend the existing RFQ workflow to a draft quote

- **Depends on:** approved raw-input intake amendment, rebased `rfq_intake.analysis`, its event/action/deal wiring, the three existing property-document agents, Catalog, Currencies, Attachments, Customers, Sales, Workflows, and Agent Orchestrator.
- **Outcome:** one accepted RFQ analyzes every generated page, matches the complete raw brief in one grouped run, and produces at most one reviewable Sales quote.
- **Deliverables:** amended matcher input/output/instructions; composer agent; trusted event scope/actor and single-PDF rejection; operation entity/migration; scoped run/artifact adapter; all-page Attachment bridge; prepare/compose/create commands; existing command recovery hardening; compatible workflow steps; non-destructive six-command allowlist rollout; existing ProcessDefinition metadata/trigger reconciliation; ACL-gated deal outcome widget; exact workflow-safe grants; localized labels/errors; focused tests.
- **Independent slices:** matcher contract and tests; operation/artifact adapter; quote composer/pricing command; deal widget. Shared workflow/command integration is serialized after those contracts land.
- **Requirements closed:** REQ-001 through REQ-007.
- **Tests:** TEST-001 through TEST-018.
- **No duplicate infrastructure:** no second Process Definition, workflow ID, activity type, workflow DI function, classifier, segmenter, or launch UI.
- **Validation:** `yarn generate`, focused tests, `yarn db:generate` with SQL/snapshot review, `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build`, `yarn test:integration:ephemeral`, then Inbox-to-quote and browser smoke. Never migrate a real database for validation.
- **Exit gate:** an accepted PDF produces one room trace per generated PNG, one grouped matcher trace over the complete raw brief, one composer trace, and at most one editable unsent quote; partial/zero-line, scope, retry, and pricing-substitution cases behave as specified.

## Requirement Traceability

| Requirement | Contract / surface | Phase | Tests | Acceptance |
|---|---|---|---|---|
| REQ-001 | existing `rfq_intake.analysis` + seeded ProcessDefinition reuse | Phase 1 | TEST-001, TEST-017 | AC-001, AC-012 |
| REQ-002 | exact page fan-out + one grouped matcher run | Phase 1 | TEST-004–TEST-007, TEST-016 | AC-001–AC-003, AC-011 |
| REQ-003 | operation + deterministic Sales quote creation | Phase 1 | TEST-009, TEST-011, TEST-013 | AC-004, AC-007 |
| REQ-004 | matcher/composer/pricing grounding | Phase 1 | TEST-007, TEST-008, TEST-012, TEST-014 | AC-003, AC-005, AC-009 |
| REQ-005 | partial/no-quote behavior + Deal widget | Phase 1 | TEST-005, TEST-010, TEST-011, TEST-015, TEST-016 | AC-002, AC-006, AC-010, AC-011 |
| REQ-006 | operation/run/Attachment/quote recovery | Phase 1 | TEST-003, TEST-004, TEST-013 | AC-007 |
| REQ-007 | event, command, artifact, Catalog, Sales, and widget scope | Phase 1 | TEST-002, TEST-003, TEST-012, TEST-018 | AC-009, AC-010, AC-013 |

## Extension-Surface Traceability

| Surface | Reference capability and exact file | Classification | Phase | Self-contained test |
|---|---|---|---|---|
| Code workflow extension | `workflows.code-definition` — `src/modules/example/workflows.ts` | emitted-example | Phase 1 | TEST-001 |
| Typed RFQ event and subscriber | `events.typed-definitions` / `events.ephemeral-subscriber` — `src/modules/example/events.ts`, `src/modules/example/subscribers/example-event.ts` | emitted-example | Phase 1 | TEST-002, TEST-003 |
| Scoped operation entity/migration | `data.entities` / `data.migrations` — `src/modules/example/data/entities.ts`, `src/modules/example/migrations/.snapshot-open-mercato.json` | emitted-example | Phase 1 | TEST-003, TEST-013 |
| Workflow-safe commands | `commands.write` — `src/modules/example/commands/todos.ts` | emitted-example | Phase 1 | TEST-004, TEST-006, TEST-013 |
| Matcher and composer agents | `ai.agent` — `src/modules/example/ai-agents.ts` | emitted-example | Phase 1 | TEST-006–TEST-008 |
| Deal detail outcome widget | `umes.injection.rendered-widget` — `src/modules/example/widgets/injection/customer-priority-detail/widget.ts`, `src/modules/example/widgets/injection/customer-priority-detail/widget.client.tsx` | emitted-example | Phase 1 | TEST-011, TEST-015 |
| Existing process projection | catalog-only — no `example` ProcessDefinition contribution; adapt `src/modules/rfq_intake/lib/processDefinition.ts` against the installed Agent Orchestrator contract | catalog-only | Phase 1 | TEST-017 |
## Compatibility and Rollout

This slice extends stable workflow ID `rfq_intake.analysis`; it does not replace or alias it. The intake cutover is clean: every caller migrates from `floor-plans.json`/parsed `requirements[]` to the exact captured page set and raw `brief`. The matcher ID remains stable, but its input/result schemas intentionally change from one requirement/flat matches to one raw brief/grouped needs; repository search found only the RFQ command and matcher tests as consumers, and both migrate in this slice. New stable IDs are additive:

- `property_documents.quote_draft_composer`;
- `rfq_intake.analysis.reject`;
- `rfq_intake.analysis.prepare`;
- `rfq_intake.quote.compose`;
- `rfq_intake.quote.create`;
- `rfq_intake:quote_draft_operation`.

Before rollout, execute these scoped gates:

1. A core Workflows `workflow_definitions` row with workflow ID `rfq_intake.analysis` shadows the code graph. If present, stop and reconcile it explicitly.
2. Active code-workflow instances resolve against the current in-memory graph. Keep the existing `measure_plans` and `match_catalog` step IDs, but before deploying the structural graph/context change, drain or explicitly cancel every scoped `rfq_intake.analysis` instance in `RUNNING`, `PAUSED`, `WAITING_FOR_ACTIVITIES`, `FORKED`, or `COMPENSATING`, then verify the active count is zero.
3. The Agent Orchestrator `process_definitions` row merely points at that workflow and does not shadow it. New organizations receive it through setup. Change reconciliation so force updates the repo name/description and ensures a manual trigger without replacing the trigger array. For existing organizations, inspect Studio edits before running `mercato rfq_intake seed-process --force`; schedule/event triggers, manual-trigger restrictions, milestones, UI metadata, and all other operator-owned fields must survive. If all 20 trigger slots are occupied without a manual trigger, reconciliation performs no mutation and instructs the operator to free a slot.
4. Read the current tenant workflow-command allowlist and write back its union with all six RFQ command IDs. Do not rely on the unset policy and do not replace unrelated enabled IDs.

Run `yarn generate` after agent/workflow/command discovery changes. Generate and review the new migration, but ask before applying it.

## Risks and Tradeoffs

| Risk | Mitigation | Residual |
|---|---|---|
| Up to 48 room runs plus 40 Catalog searches increase latency/cost | room concurrency 3, grouped searches in one bounded matcher run, correlated checkpoints, at most two attempts | largest accepted RFQ remains slow |
| Complete raw brief can exceed model input budget | command uses UTF-8 byte length with an exact 65,536-byte limit, never truncates, and exposes `review_required` | oversized documents need manual review |
| Internal AgentRun adapter is version-sensitive | one pinned 0.8.0 adapter, exact scoped predicates, HACK comment with upgrade break condition | framework upgrade may require replacement |
| Replacing proposal-only promotion creates temporary page Attachments | focused bridge/retry tests and operation mappings | up to 48 temporary Attachments accumulate until cleanup is added |
| First-channel fallback selects an unintended channel | prefer explicit action channel; expose resolved channel on editable quote | operator must review |
| Catalog match or quantity inference is wrong | verbatim excerpts, per-need search boundaries, evidence replay, editable unsent quote | human review remains required |
| DB workflow shadow hides new code steps | pre-rollout shadow check; stop instead of silently proceeding | customized deployments require manual reconciliation |
| Process metadata or triggers drift from the extended graph | update repo-owned text; force-reconcile only after Studio-edit review; merge the required manual trigger without deleting/loosening operator triggers; stop atomically when all 20 slots are occupied | unreconciled existing organizations show stale process text until an operator frees a slot |
| Active version-1 code runs resolve against the replaced in-memory graph | preserve existing step IDs; drain/cancel all active scoped RFQ instances and verify zero before deploy | deployment waits for long-running attempts |
| Missing RFQ command enablement stops at the first UPDATE_ENTITY step | rollout unions all six IDs into the current tenant policy and verifies readiness before accepting RFQs | each tenant requires explicit configuration |

## Acceptance Criteria

- [ ] **AC-001** — Existing `rfq_intake.analysis`, and no duplicate workflow, executes accepted results in the order `pdf_intake → room_dimensions once per generated page PNG → catalog_matcher once over complete raw brief → quote_draft_composer`.
- [ ] **AC-002** — Every generated PNG up to the intake limit gets exactly one accepted room invocation; non-plan pages may return empty rooms without blocking the chain.
- [ ] **AC-003** — One matcher run discovers at most 40 verbatim-grounded needs and performs exactly one scoped Catalog search per need.
- [ ] **AC-004** — A configured successful run creates exactly one scoped editable unsent Sales quote linked by metadata to its RFQ deal, source action, workflow instance, and operation.
- [ ] **AC-005** — Every quote line is grounded in that need's matcher candidates and replayable quantity evidence; price identity/scope/currency are post-validated.
- [ ] **AC-006** — Mixed valid/invalid needs create one partial draft with bounded warnings; zero valid lines creates no quote and still exposes a corrective review outcome on the deal.
- [ ] **AC-007** — Retry/crash paths create no duplicate accepted run, Attachment mapping, operation, quote number, or quote.
- [ ] **AC-008** — Existing Sales edit and Send quote behavior is unchanged and remains the approval boundary.
- [ ] **AC-009** — Foreign or missing scope/ACL/source/business IDs fail closed; the event carries trusted scope options and authenticated actor; users without `sales.quotes.view` receive no quote identity/link from the Deal widget.
- [ ] **AC-010** — Zero/multiple PDFs and every no-quote outcome are visible in the scoped Customer Deal widget without starting an invalid agent chain.
- [ ] **AC-011** — A complete 65,536-byte UTF-8 brief is accepted intact; empty and over-limit briefs start no matcher/composer run, are never truncated, and produce a visible `review_required` outcome.
- [ ] **AC-012** — One scoped Agent Orchestrator ProcessDefinition continues to point at `rfq_intake.analysis`; descriptions/manual start remain discoverable, reconciliation preserves operator triggers/restrictions and every other operator-owned field, and a full non-manual trigger list fails without mutation.
- [ ] **AC-013** — All six RFQ workflow-safe commands are explicitly enabled for the tenant by non-destructive allowlist union before RFQ execution; unrelated enabled commands remain enabled.

## Final Compliance Report

| Check | Status | Evidence |
|---|---|---|
| Rebased implementation inspected | pass | latest `origin/main` at `ecee3cb`; workflow, subscriber actor propagation, ProcessDefinition seeder/CLI/indexing, setup, commands, and tests inspected |
| Existing workflow/process reused | pass | extension targets `rfq_intake.analysis` and its seeded ProcessDefinition; no duplicate workflow/process, classifier, segmenter, or `EXECUTE_FUNCTION` |
| Raw-input decisions resolved | pass | every page goes to `room_dimensions`; complete brief goes to one internally multi-searching matcher |
| Installed contract changes reviewed | pass | trusted event scope, Workflow safe commands, ProcessDefinition projection, AgentRuntime correlation, Attachment bridge, Catalog search/pricing, Sales create, and backward compatibility |
| Data/API/event/test contracts internally consistent | pass | two post-rebase review rounds closed command enablement, active-instance cutover, trigger preservation/capacity, and quote-link ACL; final reviewer found no P1/P2 findings |
| User specification approval | pass | approved by the user after latest-main synchronization and post-rebase review |

**Verdict: Ready for implementation planning**

## Open Questions

N/A — Q-001 and Q-002 were resolved by the user on 2026-09-19: analyze every generated PNG with `room_dimensions`, and pass the complete raw brief once to an internally multi-searching `catalog_matcher`.

## Changelog

| Date | Change |
|---|---|
| 2026-09-19 | Initial standalone property-document-to-quote draft |
| 2026-09-19 | Corrected agent order and added recovery/pricing contracts |
| 2026-09-19 | Rebased onto `origin/main`; replaced the proposed duplicate workflow/`EXECUTE_FUNCTION` design with an extension of existing `rfq_intake.analysis`; incorporated the existing Deal/event/agent chain and corrected its artifact handoff |
| 2026-09-19 | Marked blocked after PDF intake changed to raw text plus every page PNG; floor-plan selection and brief-requirement segmentation now require a separately approved downstream contract. |
| 2026-09-19 | Re-review fixed trusted event scope/actor, invalid-source outcome, typed evidence replay, quote-number permission, and visible no-quote results; the preprocessing-owner blocker remains. |
| 2026-09-19 | Resolved preprocessing decisions: every page PNG goes to `room_dimensions`; one matcher run receives the complete raw brief and performs bounded per-need searches internally. |
| 2026-09-19 | Fresh-context re-review passed after adding exact raw-brief byte-boundary behavior and bounded, mutually exclusive composer result collections. |
| 2026-09-19 | Rebased onto `ecee3cb`; reused the newly seeded Agent Orchestrator ProcessDefinition, retained `userId`, separated process projection from workflow shadowing, and added safe metadata reconciliation coverage. |
| 2026-09-19 | Post-rebase review preserved stable step IDs, added an active-instance drain gate and six-command allowlist union, made ProcessDefinition trigger reconciliation non-destructive, and ACL-gated quote identity/link rendering. |
| 2026-09-19 | Added the installed 20-trigger boundary: reconciliation stops atomically when no slot is available for the required manual trigger. |
| 2026-09-19 | User approved the post-rebase specification; status advanced to Ready. |

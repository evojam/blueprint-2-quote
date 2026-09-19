# RFQ Sales Quote Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `rfq_intake.analysis` workflow so one accepted property RFQ produces at most one scoped, editable, unsent Sales quote grounded in PDF, room, Catalog, quantity, and current-pricing evidence.

**Architecture:** Keep the code-defined Workflow as the sole execution graph and the existing Agent Orchestrator `ProcessDefinition` as its business-facing projection. A scoped `RfqQuoteDraftOperation` is the durable idempotency record. Commands own validation, retry/recovery, evidence replay, pricing, and Sales mutation; agents only return bounded research. A read-only Customer Deal widget exposes the bounded outcome and conditionally exposes the quote identity under `sales.quotes.view`.

**Tech Stack:** TypeScript 6, Next.js 16 route handlers, MikroORM/PostgreSQL, Zod 4, Open Mercato 0.8.0 Workflows/Agent Orchestrator/Attachments/Catalog/Customers/Sales, Jest 30, Playwright.

**Spec:** `.ai/specs/2026-09-19-property-document-sales-quote-drafts.md`

## Global Constraints

- Never edit `node_modules`, `.mercato/generated/**`, shipped framework migrations, or generated facts by hand.
- Every operation, action, deal, agent run, artifact, attachment, Catalog row, price, customer, channel, currency, and quote read must include trusted `tenantId` and `organizationId`; missing scope fails closed.
- Keep scalar cross-module IDs only. Do not add ORM relations from `rfq_intake` to installed modules.
- Preserve Workflow ID `rfq_intake.analysis` and step IDs `measure_plans` and `match_catalog`.
- Preserve command IDs `rfq_intake.deal.advance`, `rfq_intake.plans.analyze`, and `rfq_intake.requirements.match`; add only the three approved Workflow commands and subscriber-only rejection command.
- Never truncate the brief. Accept 1–65,536 UTF-8 bytes; empty or larger input becomes a visible `review_required` outcome before matcher/composer invocation.
- Agents cannot choose scope, customer, channel, currency, variant, price, tax, discount, status, or quote number.
- Create no quote unless at least one line survives deterministic evidence replay, unit normalization, and current product-level price resolution.
- Never call `agent_orchestrator.artifact.promote` for captured PDF page artifacts. Use `attachmentService.createScoped` with `privateAttachments` and `persistLink`.
- Never migrate a database during implementation or validation. Run `yarn db:generate`, review the generated SQL/snapshot, then stop for explicit approval before any migration.
- Keep the existing Sales **Send quote** action as the only approval/send boundary.
- Before deploying the changed graph, verify there is no DB `workflow_definitions` shadow for `rfq_intake.analysis` and zero active instances in `RUNNING`, `PAUSED`, `WAITING_FOR_ACTIVITIES`, `FORKED`, or `COMPENSATING`.

## Review Focus

1. Scope and ACL fail-closed behavior, especially optional quote identity in the Deal API.
2. One operation per scoped action and one quote per scoped operation/workflow across every crash boundary.
3. Exact AgentRun correlation and two-attempt recovery without unlocked unconditional run failure.
4. One matcher search per need and proof that every accepted product ID came from that need's scoped tool result.
5. Deterministic quantity/UoM replay and price identity checks after `catalogPricingService.resolvePrice`.
6. Workflow command allowlist union preserving unrelated IDs.
7. Process trigger reconciliation preserving all operator-owned triggers/restrictions and failing atomically at 20 non-manual triggers.
8. Deal-only users receiving status/warnings but no quote existence, ID, or link.

---

### Task 1: Add the durable quote-draft operation

**Files:**
- Create: `src/modules/rfq_intake/data/entities.ts`
- Create: `src/modules/rfq_intake/data/validators.ts`
- Create: `src/modules/rfq_intake/lib/quoteDraftOperation.ts`
- Create: `src/modules/rfq_intake/__tests__/quote-draft-operation.test.ts`
- Generate: `src/modules/rfq_intake/migrations/` (one `yarn db:generate`-named `Migration*.ts` file)
- Generate: `src/modules/rfq_intake/migrations/.snapshot-open-mercato.json`

**Contract to implement:**

```ts
export const quoteDraftStatusSchema = z.enum([
  'analyzing',
  'composed',
  'creating',
  'completed',
  'review_required',
  'failed',
])

export type PageCheckpoint = {
  sourcePage: number
  artifactId: string
  attachmentId: string | null
  roomAttemptRunIds: string[]
  acceptedRoomRunId: string | null
  status: 'pending' | 'ok' | 'warning'
}

export type AgentStageCheckpoint = {
  attemptRunIds: string[]
  acceptedRunId: string | null
  status: 'pending' | 'ok' | 'failed'
}

export type AnalysisCheckpoint = {
  version: 1
  pdfRunId: string | null
  pages: PageCheckpoint[]
  matcher: AgentStageCheckpoint
  composer: AgentStageCheckpoint
  warningCodes: string[]
}
```

`RfqQuoteDraftOperation` must contain the exact approved fields: `id`, `tenantId`, `organizationId`, `actionId`, `dealId`, nullable `workflowInstanceId`, `inputHash`, `sourcePdfCount`, validated JSONB `analysisCheckpoint`, nullable `composerRunId`, nullable `customerEntityId`, nullable `channelId`, nullable `currencyCode`, nullable `reservedQuoteNumber`, nullable `quoteId`, `status`, nullable `failureCode`, `createdAt`, and `updatedAt`.

Indexes and uniqueness:

```ts
@Unique({ name: 'rfq_quote_draft_scope_action_uq', properties: ['tenantId', 'organizationId', 'actionId'] })
@Unique({ name: 'rfq_quote_draft_scope_workflow_uq', properties: ['tenantId', 'organizationId', 'workflowInstanceId'] })
@Index({ name: 'rfq_quote_draft_scope_deal_idx', properties: ['tenantId', 'organizationId', 'dealId', 'createdAt'] })
```

`quoteDraftOperation.ts` exports:

```ts
export type QuoteDraftScope = { tenantId: string; organizationId: string }
export function computeQuoteDraftInputHash(input: {
  actionId: string
  dealId: string
  pdfAttachmentId: string | null
  contractVersion: 1
}): string
export async function findOperationByAction(em: EntityManager, scope: QuoteDraftScope, actionId: string): Promise<RfqQuoteDraftOperation | null>
export async function findOperationByWorkflow(em: EntityManager, scope: QuoteDraftScope, workflowInstanceId: string): Promise<RfqQuoteDraftOperation | null>
export async function loadOperationForUpdate(em: EntityManager, scope: QuoteDraftScope, operationId: string): Promise<RfqQuoteDraftOperation>
export async function findLatestOperationForDeal(em: EntityManager, scope: QuoteDraftScope, dealId: string): Promise<RfqQuoteDraftOperation | null>
```

- [ ] Write tests proving scoped action replay returns the same row, a mismatched input hash fails, workflow binding is unique, out-of-scope lookup returns `null`, checkpoint bounds reject more than 48 pages/2 attempts/100 warnings, and latest-by-deal ordering is deterministic.
- [ ] Run `yarn test src/modules/rfq_intake/__tests__/quote-draft-operation.test.ts --runInBand`. Expected: FAIL because the entity/store do not exist.
- [ ] Implement the entity, strict checkpoint/status schemas, SHA-256 canonical input hash, pessimistic-write claim/load helpers, and bounded warning insertion. Never store document text, model reasoning, tool payloads, or quote line data in the checkpoint.
- [ ] Run the focused test again. Expected: PASS.
- [ ] Run `yarn db:generate`.
- [ ] Read the generated migration and snapshot. Verify one table, scoped indexes, the two scoped unique constraints, nullable workflow uniqueness, JSONB checkpoint, timestamps, and no cross-module foreign keys. Do not run `yarn db:migrate`.
- [ ] Commit: `feat(rfq_intake): add durable quote draft operation`

---

### Task 2: Gate intake and bind trusted RFQ context

**Files:**
- Modify: `src/modules/rfq_intake/events.ts`
- Modify: `src/modules/rfq_intake/subscribers/start-rfq-analysis.ts`
- Create: `src/modules/rfq_intake/commands/quote-draft.ts`
- Create: `src/modules/rfq_intake/lib/quoteConfiguration.ts`
- Modify: `src/modules/rfq_intake/__tests__/start-rfq-analysis.test.ts`
- Create: `src/modules/rfq_intake/__tests__/quote-draft-prepare.test.ts`

**Event and command inputs:**

```ts
export type RfqCreatedEvent = {
  actionId: string
  proposalId: string
  dealId: string
  emailId: string
  userId: string
  tenantId: string
  organizationId: string
  pdfAttachmentId: string
  __files: { attachments: Array<{ attachmentId: string }> }
}

const workflowQuoteDraftInputSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  workflowInstanceId: z.string().uuid(),
  actionId: z.string().uuid(),
  dealId: z.string().uuid(),
  userId: z.string().uuid(),
}).strict()
```

`quoteConfiguration.ts` must re-read and validate:

- `InboxProposalAction`: same scope, `id === actionId`, active/executed, linked proposal, `createdEntityId === dealId`, and RFQ-compatible action type.
- `CustomerDeal`: same scope, not deleted.
- Customer: exactly one linked company; otherwise exactly one primary linked person. Missing/ambiguous is a bounded `review_required` result.
- Channel: action payload `channelId` when scoped and valid; otherwise `resolveFirstChannelId` from `@open-mercato/core/modules/inbox_ops/lib/executionHelpers`.
- Currency: active scoped action currency when valid; otherwise `resolveChannelCurrency` for the chosen channel. Missing/inactive/foreign is a bounded `review_required` result.

- [ ] Extend subscriber tests for zero PDFs, two PDFs, one non-PDF, missing `actionId`, missing `executedByUserId`, foreign proposal/e-mail/deal/action, and redelivery.
- [ ] Add prepare-command tests for action/deal/input-hash mismatch, scoped customer selection, explicit/fallback channel and currency, missing configuration, workflow binding, and replay.
- [ ] Run both focused tests. Expected: FAIL on the new event fields/commands.
- [ ] Change the subscriber to re-read the executed action, proposal, e-mail, and attachments in trusted scope. Select exactly one `application/pdf`; do not forward unrelated attachments.
- [ ] For zero/multiple PDFs, execute subscriber-only `rfq_intake.analysis.reject`, upsert the operation by scoped action with `sourcePdfCount`, set `review_required` and a bounded failure code, then return without emitting `rfq_intake.rfq.created`.
- [ ] For exactly one PDF, upsert the scoped operation as `analyzing` with `sourcePdfCount = 1` and the canonical input hash, then emit the event with `{ persistent: true, tenantId, organizationId }`, `actionId`, and authenticated `userId` from `executedByUserId`.
- [ ] Implement `rfq_intake.analysis.prepare` to lock/reload the operation, verify the hash, bind the workflow instance once, and persist resolved customer/channel/currency. A second workflow for the same action must return/reject deterministically without creating a row.
- [ ] Run the focused tests again. Expected: PASS and zero event emission on invalid cardinality.
- [ ] Commit: `feat(rfq_intake): gate and prepare quote analysis`

---

### Task 3: Add exact AgentRun recovery and all-page attachment fan-out

**Files:**
- Create: `src/modules/rfq_intake/lib/agentRunAdapter.ts`
- Create: `src/modules/rfq_intake/lib/pageAttachmentBridge.ts`
- Modify: `src/modules/rfq_intake/commands/analysis.ts`
- Create: `src/modules/rfq_intake/__tests__/agent-run-adapter.test.ts`
- Modify: `src/modules/rfq_intake/__tests__/analysis-commands.test.ts`

**Pinned adapter API:**

```ts
export type LogicalAgentInvocation = {
  agentId: string
  workflowInstanceId: string
  stepId: string
  invocationBase: string
}

export type AcceptedAgentRun = {
  runId: string
  output: unknown
}

export async function runOrRecoverAgent(input: {
  container: AwilixContainer
  em: EntityManager
  scope: QuoteDraftScope
  userId: string
  invocation: LogicalAgentInvocation
  agentInput: unknown
  maxAttempts: 2
  deadline: Date
}): Promise<AcceptedAgentRun>

export async function loadScopedToolCalls(input: {
  container: AwilixContainer
  em: EntityManager
  scope: QuoteDraftScope
  runId: string
  toolName: string
}): Promise<Array<{ request: unknown; response: unknown; status: string }>>
```

The implementation must contain this repo-required shortcut marker:

```ts
// HACK(hackathon): This adapter pins AgentRun, AgentRunSession, AgentRunArtifact,
// AgentToolCall, and trace artifact storage internals from Open Mercato 0.8.0.
// Re-verify fields, terminal statuses, and getArtifact semantics on framework upgrade.
```

Run identity is exactly `(tenantId, organizationId, workflowInstanceId, stepId, invocationId)`, with invocation IDs:

```ts
`page:${artifactId}:${attempt}`
`raw-brief:${briefArtifactId}:${attempt}`
`quote-composer:${attempt}`
```

- [ ] Write adapter tests for an existing terminal `ok`, existing terminal `error`, one replacement attempt, terminal `cancelled`, active `running`, expired `running`, a late result from an abandoned attempt, out-of-scope rows, and inline/offloaded tool request/response payloads through `getArtifact` + `ARTIFACT_REFS`.
- [ ] Extend plan-analysis tests to prove every validated page is materialized once, retry returns the existing mapping, `persistLink` stores `{artifactId, attachmentId, sourcePage}` atomically, room analysis runs once per page with concurrency at most 3, and one failed room run becomes a warning without dropping other pages.
- [ ] Run `yarn test src/modules/rfq_intake/__tests__/agent-run-adapter.test.ts src/modules/rfq_intake/__tests__/analysis-commands.test.ts --runInBand`. Expected: FAIL.
- [ ] Implement `runOrRecoverAgent` with `agentRuntime.run(agentId, input, { tenantId, organizationId, userId, workflowInstanceId, stepId, invocationId, onRunPersisted })`. Capture the first top-level run ID only.
- [ ] For an expired run, atomically mark only the logical attempt abandoned and expire only its orphanable `AgentRunSession` rows. Never call the installed unconditional run-failure command after an unlocked read.
- [ ] Implement tool payload loading from `AgentToolCall.requestSummary/responseSummary`, falling back to scoped `getArtifact(container, scope, ARTIFACT_REFS.toolRequest, requestArtifactKey)` and `getArtifact(container, scope, ARTIFACT_REFS.toolResponse, responseArtifactKey)` when artifact keys exist. Missing full evidence fails validation rather than trusting a capped summary.
- [ ] Implement `pageAttachmentBridge` with `attachmentService.createScoped({ entityId: 'rfq_intake:quote_draft_operation', recordId: operation.id, partitionCode: 'privateAttachments', declaredMimeType: 'image/png', buffer, persistLink })`. Lock the operation inside `persistLink` and deduplicate by source artifact ID.
- [ ] Replace the deferred `rfq_intake.plans.analyze` body. Load the exact validated PDF artifact set, create/recover every page Attachment, and invoke `property_documents.room_dimensions` once per page through a three-worker bounded loop. Do not use `Promise.all` over 48 pages.
- [ ] Run the focused tests again. Expected: PASS.
- [ ] Commit: `feat(rfq_intake): analyze every PDF page safely`

---

### Task 4: Amend matcher and add the quote composer agent

**Files:**
- Modify: `src/modules/property_documents/ai-agents.ts`
- Modify: `src/modules/property_documents/__tests__/catalog-matcher-agent.test.ts`
- Create: `src/modules/property_documents/__tests__/quote-draft-composer-agent.test.ts`

**Stable agent IDs and strict schemas:**

```ts
export const CATALOG_MATCHER_AGENT_ID = 'property_documents.catalog_matcher'
export const QUOTE_DRAFT_COMPOSER_AGENT_ID = 'property_documents.quote_draft_composer'

export const catalogMatcherInputSchema = z.object({
  text: z.string().min(1),
  maxNeeds: z.literal(40),
  limitPerNeed: z.literal(5),
}).strict()

export const quoteDraftComposerResultSchema = z.object({
  kind: z.literal('research'),
  data: z.object({
    lines: z.array(z.object({
      needIndex: z.number().int().min(0).max(39),
      productId: z.string().uuid(),
      quantity: z.number().positive().finite(),
      quantityUnit: z.string().trim().min(1).max(50).nullable(),
      derivation: quoteLineDerivationSchema,
      description: z.string().trim().min(1).max(1000),
    }).strict()).max(40),
    unresolvedNeeds: z.array(z.object({
      needIndex: z.number().int().min(0).max(39),
      reason: z.string().trim().min(1).max(1000),
    }).strict()).max(40),
    warnings: z.array(z.string().trim().min(1).max(500)).max(100),
  }).strict(),
}).strict()
```

Use the full matcher/composer shapes from the approved spec. In particular, matcher needs are unique and bounded, source excerpts are exact brief substrings, each need has 1–4 unique query terms, matches are unique/score-ordered, and the composer partitions every matcher need exactly once between `lines` and `unresolvedNeeds`.

- [ ] Update matcher tests for grouped output, 40-need/5-match bounds, unique need/product IDs, exact score ordering, exact source excerpts, and the new sample input `{ text, maxNeeds: 40, limitPerNeed: 5 }`.
- [ ] Add composer tests for all four derivation variants, strict collection/string bounds, candidate membership, duplicate/missing/overlapping need indexes, forbidden extra fields, and no registered tools/subagents/files.
- [ ] Run `yarn test src/modules/property_documents/__tests__/catalog-matcher-agent.test.ts src/modules/property_documents/__tests__/quote-draft-composer-agent.test.ts --runInBand`. Expected: FAIL.
- [ ] Amend the matcher prompt: discover at most 40 source-grounded needs from the complete brief, preserve an exact excerpt, and call `catalog.search_products` exactly once per need. Keep `catalog.get_product_bundle` unavailable so acceptance depends only on one auditable search result per need.
- [ ] Register the composer as a native, read-only, `research` agent with no tools. Its prompt must select only supplied candidate IDs and return typed evidence coordinates; it must not infer price or business scope.
- [ ] Run the focused tests again. Expected: PASS.
- [ ] Commit: `feat(property_documents): add grounded quote composer`

---

### Task 5: Match the full brief and compose a strict draft

**Files:**
- Create: `src/modules/rfq_intake/commands/catalog-match.ts`
- Modify: `src/modules/rfq_intake/commands/analysis.ts`
- Create: `src/modules/rfq_intake/lib/quoteEvidence.ts`
- Create: `src/modules/rfq_intake/__tests__/catalog-match-command.test.ts`
- Create: `src/modules/rfq_intake/__tests__/quote-compose-command.test.ts`
- Create: `src/modules/rfq_intake/__tests__/quote-evidence.test.ts`

**Evidence functions:**

```ts
export function assertRawBriefBounds(brief: string): void
export function validateMatcherEvidence(input: {
  brief: string
  result: unknown
  toolCalls: Array<{ request: unknown; response: unknown; status: string }>
}): CatalogMatcherResult
export function buildComposerInput(input: {
  matcherRunId: string
  matcher: CatalogMatcherResult
  pages: AcceptedRoomPage[]
}): QuoteDraftComposerInput
export function validateComposerPartition(input: {
  matcher: CatalogMatcherResult
  composer: unknown
}): QuoteDraftComposerResult
export function replayLineDerivation(input: {
  line: QuoteDraftComposerResult['data']['lines'][number]
  matcher: CatalogMatcherResult
  roomPages: AcceptedRoomPage[]
}): { quantity: string; quantityUnit: string | null }
```

- [ ] Add brief boundary tests using exact UTF-8 byte lengths: 65,536 accepted intact; empty, 65,537 bytes, and multibyte-over-limit rejected without truncation.
- [ ] Add matcher acceptance tests proving exactly one successful `catalog.search_products` call per need, request terms correspond to that need, every accepted `catalogProductId` occurred in that call's response, and missing/extra/duplicate searches or cross-need substitution fail.
- [ ] Add composer tests proving top-three candidate projection, all successful room results included, failed/non-plan pages represented only through bounded warnings, exact need partition, and correlated run replay.
- [ ] Add deterministic replay tests for `brief_explicit`, `room_measurement`, `rectangle_area`, and `rectangle_perimeter`; reject ambiguous brief quantities, cross-room dimensions, missing coordinates, non-positive values, and proposed values that differ after canonical conversion.
- [ ] Run the three focused tests. Expected: FAIL.
- [ ] Move registration of stable command `rfq_intake.requirements.match` to `catalog-match.ts`. Load `brief.json` through the existing strict artifact validator, enforce bytes with `Buffer.byteLength(brief, 'utf8')`, invoke the matcher once, validate its result and trace, and checkpoint one accepted matcher run.
- [ ] Implement `rfq_intake.quote.compose` in `quote-draft.ts`: reload the accepted matcher/room runs in full scope, project at most three candidates per need, invoke the composer once, strict-validate its partition, and persist `composerRunId` plus `status = 'composed'`.
- [ ] Keep warnings as bounded codes/counts in the operation. Keep human-readable source excerpts and room data in AgentRun evidence, not operation JSON.
- [ ] Run the focused tests again. Expected: PASS.
- [ ] Commit: `feat(rfq_intake): match and compose grounded quote lines`

---

### Task 6: Replay, price, create, and recover one Sales quote

**Files:**
- Create: `src/modules/rfq_intake/lib/quotePricing.ts`
- Create: `src/modules/rfq_intake/commands/quote-create.ts`
- Create: `src/modules/rfq_intake/__tests__/quote-pricing.test.ts`
- Create: `src/modules/rfq_intake/__tests__/quote-create-command.test.ts`

**Pricing API:**

```ts
export type PricedQuoteLine = {
  kind: 'product'
  productId: string
  productVariantId?: never
  name: string
  description: string
  quantity: string
  quantityUnit: string
  normalizedQuantity: string
  normalizedUnit: string
  currencyCode: string
  priceId: string
  priceMode: 'net' | 'gross'
  unitPriceNet?: string
  unitPriceGross?: string
  taxRateId?: string
  taxRate?: string
  catalogSnapshot: Record<string, unknown>
  metadata: {
    matcherRunId: string
    composerRunId: string
    needIndex: number
    derivationKind: 'brief_explicit' | 'room_measurement' | 'room_area' | 'room_perimeter'
  }
}
```

Per line:

1. Replay the derivation from scoped accepted AgentRuns.
2. Resolve product base/default sales unit or one active conversion through Catalog/Dictionaries.
3. Load current scoped product-level price candidates for the operation currency with `productVariantId = null`.
4. Call `catalogPricingService.resolvePrice(rows, { channelId, customerId, quantity, date })`.
5. Require the returned price ID, product ID, null variant, and currency to exist in the original candidate map.
6. Re-read the returned price ID in scope and accept resolver-adjusted amounts/tax only for that same identity.
7. Omit an invalid/unpriced line with a bounded warning; never substitute another product or variant.

Quote creation payload includes:

```ts
{
  tenantId,
  organizationId,
  quoteNumber: operation.reservedQuoteNumber,
  customerEntityId: operation.customerEntityId,
  channelId: operation.channelId,
  currencyCode: operation.currencyCode,
  comments: boundedWarningComment,
  metadata: {
    rfqDealId: operation.dealId,
    rfqActionId: operation.actionId,
    workflowInstanceId: operation.workflowInstanceId,
    operationId: operation.id,
  },
  lines: pricedLines,
}
```

- [ ] Write pricing tests for a valid current product-level price, same-identity resolver amount/tax adjustment, variant result, unknown price ID, substituted product, foreign currency/scope, inactive price, missing unit conversion, and partial valid/invalid lines.
- [ ] Write create-command tests for existing completed operation, input-hash mismatch, zero valid lines, missing customer/channel/currency, number reservation, Sales success, crash after Sales commit, recovery by scoped quote number + `metadata.operationId`, conflicting quote metadata, and concurrent retries.
- [ ] Run `yarn test src/modules/rfq_intake/__tests__/quote-pricing.test.ts src/modules/rfq_intake/__tests__/quote-create-command.test.ts --runInBand`. Expected: FAIL.
- [ ] Implement `rfq_intake.quote.create`. Lock the operation first. Return stored `quoteId` for `completed`; reject mismatched input; re-resolve customer/channel/currency; set `creating`; validate/price lines.
- [ ] When no lines survive, set `review_required`, persist bounded warning codes, return without a quote, and let the workflow continue to the review stage.
- [ ] Resolve `salesDocumentNumberGenerator`, generate once, persist `reservedQuoteNumber`, flush, then call `sales.quotes.create` through the command bus with the explicit number.
- [ ] On retry with a reserved number but no `quoteId`, query `SalesQuote` by full scope + number. Recover only when `metadata.operationId === operation.id`; any mismatch fails closed.
- [ ] Persist one `quoteId` and `status = 'completed'`. Do not send, approve, or convert the quote.
- [ ] Run the focused tests again. Expected: PASS.
- [ ] Commit: `feat(rfq_intake): create idempotent priced sales quote`

---

### Task 7: Extend the workflow and reconcile operational projections

**Files:**
- Modify: `src/modules/rfq_intake/workflows.ts`
- Modify: `src/modules/rfq_intake/lib/processDefinition.ts`
- Create: `src/modules/rfq_intake/lib/workflowCommandPolicy.ts`
- Modify: `src/modules/rfq_intake/cli.ts`
- Modify: `src/modules/rfq_intake/setup.ts`
- Modify: `src/modules/rfq_intake/index.ts`
- Modify: `src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts`
- Modify: `src/modules/rfq_intake/__tests__/process-definition.test.ts`
- Create: `src/modules/rfq_intake/__tests__/workflow-command-policy.test.ts`

**Workflow order:**

```text
start
→ prepare_analysis
→ mark_quoting
→ extract_pdf
→ measure_plans
→ match_catalog
→ compose_quote
→ create_quote
→ mark_review
→ end
```

All command activities receive trusted interpolated `tenantId`, `organizationId`, `workflowInstanceId`, `actionId`, `dealId`, and `userId`. The event trigger context mapping must add `actionId`, `userId`, and `pdfAttachmentId`; strict interpolation remains enabled.

Register exactly these six Workflow-safe commands with least-privilege feature lists:

```ts
export const RFQ_WORKFLOW_COMMAND_IDS = [
  'rfq_intake.deal.advance',
  'rfq_intake.analysis.prepare',
  'rfq_intake.plans.analyze',
  'rfq_intake.requirements.match',
  'rfq_intake.quote.compose',
  'rfq_intake.quote.create',
] as const
```

`rfq_intake.analysis.reject` remains subscriber-only. None of the six commands is `defaultEnabled`.

- [ ] Add wiring tests for the exact graph/order, stable `measure_plans`/`match_catalog` IDs, strict interpolation, all context keys, exactly six safe command declarations, no default enablement, and required feature subsets covering Customers, Inbox, Attachments, Agent Orchestrator, Catalog, Dictionaries, Currencies, and Sales.
- [ ] Add process tests proving normal seed preserves an existing row; force updates repo-owned name/description; force preserves milestones, UI metadata, schedule/event triggers, and manual-trigger restrictions; force appends one default manual trigger only when missing; 20 non-manual triggers throws `process_trigger_capacity_exhausted` without mutation/indexing.
- [ ] Add allowlist tests for `unionRfqWorkflowCommandIds(current, catalogue)`: all six present once, explicit unrelated IDs preserved, deterministic order, and an unset policy starts from every catalogue entry with `defaultEnabled === true` so grandfathered commands remain effectively enabled.
- [ ] Run the three focused tests. Expected: FAIL.
- [ ] Update the graph and descriptions. Keep `measure_plans` and `match_catalog`; never rename them during this cutover.
- [ ] Change ProcessDefinition force reconciliation to clone current triggers, retain every existing trigger byte-for-byte, and append the default manual trigger only if absent. Check the 20-trigger capacity before mutating the entity.
- [ ] Add operator-only CLI `enable-workflow-commands --tenant $TENANT_ID --org $ORGANIZATION_ID`. It resolves `workflowCommandConfigService`, reads the tenant value once and aborts on read errors, parses an explicit list or derives the unset baseline from `listWorkflowSafeCommands().filter((entry) => entry.defaultEnabled === true)`, unions the six IDs, and calls `writeEnabledWorkflowCommandIds`. It never removes unrelated/effectively-enabled IDs and never broadens command features.
- [ ] Keep setup seeding limited to pipeline/process creation. Do not auto-enable commands for every tenant during setup.
- [ ] Update module requirements to reflect the runtime dependency on Customers, Sales, Workflows, Agent Orchestrator, and Attachments using valid installed module IDs.
- [ ] Run the focused tests again. Expected: PASS.
- [ ] Commit: `feat(rfq_intake): extend quote workflow and rollout controls`

---

### Task 8: Expose the bounded Deal outcome without leaking quote identity

**Files:**
- Create: `src/modules/rfq_intake/api/quote-draft-outcome/route.ts`
- Create: `src/modules/rfq_intake/widgets/injection-table.ts`
- Create: `src/modules/rfq_intake/widgets/injection/quote-draft-outcome/widget.ts`
- Create: `src/modules/rfq_intake/widgets/injection/quote-draft-outcome/widget.client.tsx`
- Create: `src/modules/rfq_intake/__tests__/quote-draft-outcome-route.test.ts`
- Create: `src/modules/rfq_intake/__tests__/quote-draft-outcome-widget.test.tsx`
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/pl.json`
- Modify: `src/i18n/de.json`
- Modify: `src/i18n/es.json`
- Modify: `src/i18n/ko.json`

**Read API contract:**

```ts
const quoteDraftOutcomeSchema = z.object({
  status: quoteDraftStatusSchema,
  warningCodes: z.array(z.string()).max(100),
  failureCode: z.string().nullable(),
  updatedAt: z.string().datetime(),
  quoteId: z.string().uuid().optional(),
}).strict()

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['customers.deals.view'] },
}
```

The GET handler accepts only a UUID `dealId`, derives scope from authenticated cookies, loads the latest operation by full scope, and returns `204` when none exists. Before adding `quoteId`, call:

```ts
await rbacService.userHasAllFeatures(auth.sub, ['sales.quotes.view'], {
  tenantId: auth.tenantId,
  organizationId: auth.orgId,
})
```

Without that feature, omit the property entirely. Do not return `quoteId: null`, quote existence flags, reserved number, raw content, excerpts, model errors, or internal stack messages.

Widget registration:

```ts
export const injectionTable: ModuleInjectionTable = {
  'detail:customers.deal:footer': {
    widgetId: 'rfq_intake.injection.quote-draft-outcome',
    priority: 30,
  },
}
```

- [ ] Add route tests for unauthenticated/missing-org requests, invalid deal ID, foreign deal scope, empty outcome, bounded failure/warnings, `sales.quotes.view` present, and Deal-only permission. Assert the serialized Deal-only response contains no quote ID or link.
- [ ] Add widget tests for loading, empty, error, analyzing, review-required, completed-with-link, and completed-without-link. The link is exactly `/backend/sales/quotes/${quoteId}`.
- [ ] Run `yarn test src/modules/rfq_intake/__tests__/quote-draft-outcome-route.test.ts src/modules/rfq_intake/__tests__/quote-draft-outcome-widget.test.tsx --runInBand`. Expected: FAIL.
- [ ] Implement the scoped route with per-method `metadata` and `openApi`. Use one generic 500 response and server-side structured logging without raw document/model content.
- [ ] Implement the UMES widget with `metadata.features = ['customers.deals.view']` and required host modules. Fetch `` `/api/rfq_intake/quote-draft-outcome?dealId=${encodeURIComponent(dealId)}` ``; render shared design-system components/tokens and keyboard-accessible link semantics.
- [ ] Add localized command labels, statuses, warnings, errors, empty/loading states, and quote CTA to all five app locale files. Do not hard-code user-facing strings or status colors.
- [ ] Run the focused tests again. Expected: PASS.
- [ ] Commit: `feat(rfq_intake): show scoped quote outcome on deals`

---

### Task 9: Prove the complete flow and perform the safe cutover

**Files:**
- Create: `src/modules/rfq_intake/__integration__/meta.ts`
- Create: `src/modules/rfq_intake/__integration__/quote-draft.spec.ts`
- Modify as failures require: files changed in Tasks 1–8

**Integration metadata:**

```ts
export const requiredModules = [
  'rfq_intake',
  'property_documents',
  'customers',
  'inbox_ops',
  'attachments',
  'catalog',
  'currencies',
  'sales',
  'workflows',
  'agent_orchestrator',
]
```

- [ ] Add an integration fixture with one accepted RFQ action, one PDF, linked company/person, scoped channel/currency, Catalog products, product-level prices, and the six-command allowlist enabled by union.
- [ ] Exercise success: subscriber → workflow → every page room run → one grouped matcher → composer → deterministic pricing → exactly one unsent editable quote → Deal widget link → existing Sales Send quote action visible but not executed.
- [ ] Exercise partial and zero-line outcomes, one failed page, unmatched need, invalid quantity, missing price, empty/oversized brief, zero/multiple PDFs, foreign IDs, a Deal-only user, and retry checkpoints after AgentRun, Attachment, quote-number reservation, and Sales commit.
- [ ] Assert no duplicate operations, accepted runs, page mappings, reserved numbers, or quotes. Assert quote metadata contains only IDs/counts and each line's product/price evidence is replayable.
- [ ] Run the focused Jest suite:

```bash
yarn test \
  src/modules/property_documents/__tests__/catalog-matcher-agent.test.ts \
  src/modules/property_documents/__tests__/quote-draft-composer-agent.test.ts \
  src/modules/rfq_intake/__tests__ \
  --runInBand
```

Expected: PASS.

- [ ] Run `yarn generate`. Review only generated changes; never hand-edit them.
- [ ] Run `yarn typecheck`.
- [ ] Run `yarn lint`.
- [ ] Run `yarn ds:check`.
- [ ] Run `yarn i18n:check-hardcoded`.
- [ ] Run `yarn test`.
- [ ] Run `yarn build`.
- [ ] Run `yarn test:integration:ephemeral`.
- [ ] Start the real app and perform a browser smoke: accept Inbox RFQ, observe the Deal widget through loading to outcome, open the generated quote as a quote-authorized user, verify it is editable/unsent and shows the existing Send quote action, then repeat as a Deal-only user and verify no quote identity/link is visible. Capture screenshots for both permission states.
- [ ] Before rollout, query for a DB Workflow shadow of `rfq_intake.analysis`. Stop if one exists; reconcile it explicitly rather than silently running stale DB steps.
- [ ] Query active instances in `RUNNING`, `PAUSED`, `WAITING_FOR_ACTIVITIES`, `FORKED`, and `COMPENSATING`. Drain or explicitly cancel them and verify zero before deploying the structural graph change.
- [ ] Run `yarn mercato rfq_intake seed-process --tenant $TENANT_ID --org $ORGANIZATION_ID --force`. If it returns `process_trigger_capacity_exhausted`, free one trigger slot and rerun; never delete triggers automatically.
- [ ] Run `yarn mercato rfq_intake enable-workflow-commands --tenant $TENANT_ID --org $ORGANIZATION_ID`, then read back tenant settings and verify all six RFQ IDs plus every pre-existing unrelated ID.
- [ ] Confirm the generated migration remains unapplied. Request explicit approval before any target database migration.
- [ ] Remove any throwaway fixtures/scripts and inspect intended file changes for secrets, `.env`, raw model/document content, or generated-file hand edits.
- [ ] Commit: `test(rfq_intake): cover quote draft workflow end to end`

## Spec-to-Test Coverage Check

- TEST-001–TEST-005 / AC-001–AC-003: Tasks 2, 3, and 5.
- TEST-006–TEST-008 / AC-004–AC-005: Tasks 4–6.
- TEST-009–TEST-014 / AC-004–AC-009: Tasks 1, 2, 5, 6, and 9.
- TEST-015 / AC-008–AC-010: Tasks 8 and 9 browser smoke.
- TEST-016 / AC-011: Task 5 exact UTF-8 byte-boundary tests.
- TEST-017 / AC-012: Task 7 process reconciliation tests and Task 9 rollout checks.
- TEST-018 / AC-013: Task 7 allowlist union plus Task 9 tenant readback.

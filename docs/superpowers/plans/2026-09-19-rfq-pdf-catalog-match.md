# RFQ PDF Intake to Catalog Match Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `rfq_intake.analysis` with the scoped two-stage `pdf_intake → catalog_matcher → END` pipeline while preserving existing RFQ/manual entry points.

**Architecture:** Keep the stable code workflow and ProcessDefinition. The `match_catalog` workflow-safe command reads and verifies the exact scoped `brief.json` emitted by the `extract_pdf` run, then calls the existing matcher in explicit grouped-v2 mode. The matcher keeps its legacy flat input/output path for one minor release and exposes an explicit grouped discriminator instead of inferring mode from field presence.

**Tech Stack:** TypeScript, Zod, MikroORM, Open Mercato Workflows, Agent Orchestrator, Jest.

**Spec:** `.ai/specs/2026-09-19-property-document-sales-quote-drafts.md`

## Global Constraints

- Keep stable IDs `rfq_intake.analysis` and `property_documents.catalog_matcher`; no second workflow, process definition, route, event, entity, migration, UI surface, or future agent stage.
- Preserve accepted-RFQ and manual ProcessDefinition starts; do not add an embedded event trigger to the workflow.
- Use the built-in `INVOKE_AGENT` activity and `registerWorkflowSafeCommands`; do not add a custom activity or `EXECUTE_FUNCTION` bridge.
- Derive tenant and organization from trusted command context; compare, never trust, interpolated scope fields.
- Read `brief.json` only from a scoped, successful `AgentRunArtifact`; validate result metadata, MIME, size, SHA-256, JSON, and `Buffer.byteLength(brief, 'utf8') <= 65_536` before inference.
- Grouped matcher calls use `{ mode: 'grouped', text, maxNeeds: 40, limitPerNeed: 5 }`; never truncate or silently segment a brief.
- Legacy `{ text, limit? }` input and `{ matches, unmatchedTerms }` result stay valid for one minor version. Grouped result is explicitly `{ data: { contractVersion: 2, needs, warnings } }`.
- The matcher is read-only and uses only `catalog.search_products` and `catalog.get_product_bundle`; returned product IDs must come from the relevant scoped search result.
- A successful grouped matcher run is reused only when its output strict-parses as grouped v2 under the same scope, workflow instance, `match_catalog` step, and agent ID. A new attempt uses a new opaque `invocationId`.
- Regenerate discovery after `ai-agents.ts`/workflow changes. Do not edit `.mercato/generated/**` manually.
- Add `UPGRADE_NOTES.md` because a published agent contract changes. No migration is generated or applied.

## Review Focus

1. **Foreign or mismatched artifact records:** TEST-003 in Task 2 proves that a scope/run mismatch makes zero matcher calls.
2. **Corrupt `brief.json`:** TEST-003 in Task 2 covers wrong MIME/digest/JSON and asserts a terminal error rather than fabricated output.
3. **UTF-8 byte overflow:** TEST-003 in Task 2 passes 65,537 bytes and asserts no truncation and no matcher invocation.
4. **Legacy-result reuse:** TEST-004 in Task 2 puts a flat legacy result at the same workflow stage and proves it is not accepted as grouped v2.
5. **Workflow regression into deferred actions:** TEST-001 in Task 3 proves the registered graph contains only intake and matcher activities and ends immediately afterwards.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/modules/property_documents/ai-agents.ts` | Defines legacy and grouped-v2 matcher result schemas, explicit grouped instructions, and the one stable agent registration. |
| `src/modules/property_documents/__tests__/catalog-matcher-agent.test.ts` | Pins legacy compatibility and grouped-v2 result bounds/registration. |
| `src/modules/rfq_intake/commands/analysis.ts` | Validates the correlated intake brief, reuses only a valid grouped result, or creates one fresh matcher run. |
| `src/modules/rfq_intake/__tests__/analysis-commands.test.ts` | Tests trusted artifact handoff, no-call failures, grouped reuse, and fresh retry identity. |
| `src/modules/rfq_intake/workflows.ts` | Defines the two-stage graph and limits workflow-safe registration to `requirements.match`. |
| `src/modules/rfq_intake/lib/processDefinition.ts` | Keeps the same process but updates its owned description to match the two-stage graph. |
| `src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts` | Pins exact graph/activity order, strict interpolation, and no embedded trigger. |
| `src/modules/rfq_intake/__tests__/process-definition.test.ts` | Pins the updated ProcessDefinition description while preserving its manual trigger. |
| `UPGRADE_NOTES.md` | Documents the legacy matcher deprecation and grouped-v2 migration. |
| `.ai/specs/2026-09-19-property-document-sales-quote-drafts.md` | Approved source spec; update only its implementation-progress evidence if execution discovers a contract correction. |

## Task 1: Add explicit grouped-v2 matcher contract with legacy bridge

**Files:**
- Modify: `src/modules/property_documents/ai-agents.ts:21-97`
- Modify: `src/modules/property_documents/__tests__/catalog-matcher-agent.test.ts:16-93`

**Interfaces:**
- Consumes: existing stable `CATALOG_MATCHER_AGENT_ID`, `catalog.search_products`, and `catalog.get_product_bundle` contracts.
- Produces:

```ts
export const catalogMatcherLegacyResultSchema: z.ZodType<LegacyMatcherResult>
export const catalogMatcherGroupedResultSchema: z.ZodType<GroupedMatcherResult>
export const catalogMatcherResultSchema: z.ZodUnion<[
  typeof catalogMatcherLegacyResultSchema,
  typeof catalogMatcherGroupedResultSchema,
]>

type GroupedMatcherInput = {
  mode: 'grouped'
  text: string
  maxNeeds: number
  limitPerNeed: number
}
```

- `rfq_intake/commands/analysis.ts` imports `catalogMatcherGroupedResultSchema` to validate reusable outputs.

- [ ] **Step 1: Write grouped/legacy contract tests before changing the agent**

Extend `catalog-matcher-agent.test.ts` with a valid grouped result and failures that each violate one observable contract: missing `contractVersion: 2`, duplicate `needIndex`, a source excerpt not constrained to 500 characters, five query terms, duplicate product IDs within one group, ascending scores, and more than 40 needs. Keep the existing legacy fixture and assert it still parses through the union.

```ts
const groupedEnvelope = {
  kind: 'research',
  data: {
    contractVersion: 2,
    needs: [{
      needIndex: 0,
      sourceExcerpt: 'Montaż instalacji elektrycznej.',
      queryTerms: ['montaż', 'instalacja', 'elektryczna'],
      matches: [match],
      unmatchedTerms: [],
    }],
    warnings: [],
  },
}

expect(catalogMatcherGroupedResultSchema.safeParse(groupedEnvelope).success).toBe(true)
expect(catalogMatcherResultSchema.safeParse(envelope).success).toBe(true)
expect(catalogMatcherResultSchema.safeParse(groupedEnvelope).success).toBe(true)
```

- [ ] **Step 2: Run the focused matcher test and confirm failure**

Run:

```bash
yarn test src/modules/property_documents/__tests__/catalog-matcher-agent.test.ts
```

Expected: FAIL because the grouped schema/export does not exist and the current matcher accepts only the flat legacy envelope.

- [ ] **Step 3: Implement strict legacy and grouped schemas**

In `ai-agents.ts`:

1. Rename the existing flat schema to exported `catalogMatcherLegacyResultSchema` without narrowing it.
2. Add `catalogMatcherGroupedResultSchema` with a strict outer research envelope and strict `data` containing literal `contractVersion: 2`, `needs`, and `warnings`.
3. Reuse the existing `catalogMatcherMatchSchema` in each need; add `needIndex` uniqueness, 1–4 unique query terms, exact bounds, per-need unique catalog IDs, and descending scores.
4. Export `catalogMatcherResultSchema = z.union([catalogMatcherLegacyResultSchema, catalogMatcherGroupedResultSchema])` so the stable agent registration accepts both envelopes.
5. Replace prompt instructions with an explicit branch:
   - no `mode` means legacy behavior and the existing flat envelope;
   - `mode: 'grouped'` requires `maxNeeds`/`limitPerNeed`, rejects empty or >65,536-byte text, identifies no more than `maxNeeds` verbatim excerpts, searches once per need, and returns only grouped v2;
   - tool/ACL/provider failures remain terminal;
   - no writes, files, network, skills, or subagents are introduced.
6. Leave ID, module, allowed tools, agent type, read-only policy, and loop limits unchanged. Set `sampleInput` to explicit grouped mode so generated agent pages demonstrate the RFQ contract.

- [ ] **Step 4: Run the focused matcher test and confirm pass**

Run:

```bash
yarn test src/modules/property_documents/__tests__/catalog-matcher-agent.test.ts
```

Expected: PASS. The current legacy fixture and new grouped fixture parse; malformed grouped fixtures reject.

- [ ] **Step 5: Commit the isolated matcher contract**

```bash
git add src/modules/property_documents/ai-agents.ts src/modules/property_documents/__tests__/catalog-matcher-agent.test.ts
git commit -m "feat(property-documents): add grouped catalog matcher mode"
```

## Task 2: Implement verified brief-to-matcher handoff and safe reuse

**Files:**
- Modify: `src/modules/rfq_intake/commands/analysis.ts:1-259`
- Modify: `src/modules/rfq_intake/__tests__/analysis-commands.test.ts:1-289`

**Interfaces:**
- Consumes: `catalogMatcherGroupedResultSchema`, `CATALOG_MATCHER_AGENT_ID`, `PDF_AGENT_ID`, `AgentRun`, `AgentRunArtifact`, `getArtifactBytes`, and trusted workflow command context.
- Produces:

```ts
export type PdfIntakeBrief = { runId: string; brief: string }
export async function loadPdfIntakeBrief(
  em: EntityManager,
  ctx: CommandCtx,
  input: AnalysisInput,
): Promise<PdfIntakeBrief>

const matchRequirementsCommand: CommandHandler<AnalysisInput, GroupedMatcherResult>
```

- `AnalysisInput.stepId` is narrowed to `z.literal('match_catalog')`; intake lookup uses fixed `extract_pdf` and matcher lookup uses fixed `match_catalog`.

- [ ] **Step 1: Replace deferred-command assertions with failing handoff tests**

Update the mock container to resolve `agentRuntime` and record `run(agentId, input, ctx)`. Add a successful matcher fixture whose `output` is a valid grouped v2 envelope. Replace the old deferred-consumer test with these assertions:

```ts
await matchRequirementsCommand.execute(
  { ...INPUT, stepId: 'match_catalog' },
  ctx,
)

expect(agentRuntime.run).toHaveBeenCalledWith(
  'property_documents.catalog_matcher',
  {
    mode: 'grouped',
    text: 'Exact raw text\f',
    maxNeeds: 40,
    limitPerNeed: 5,
  },
  expect.objectContaining({
    tenantId: INPUT.tenantId,
    organizationId: INPUT.organizationId,
    workflowInstanceId: INPUT.workflowInstanceId,
    stepId: 'match_catalog',
    invocationId: expect.any(String),
  }),
)
```

Add separate tests for: foreign artifact scope, wrong brief MIME, SHA mismatch, malformed brief JSON, empty brief, 65,537-byte brief, a prior legacy result at `match_catalog`, a prior grouped-v2 success, and a prior matcher error.

- [ ] **Step 2: Run the handoff test and confirm failure**

Run:

```bash
yarn test src/modules/rfq_intake/__tests__/analysis-commands.test.ts
```

Expected: FAIL because the command currently validates all pages and throws `PDF_INTAKE_DOWNSTREAM_DEFERRED` without resolving `agentRuntime`.

- [ ] **Step 3: Replace page-oriented deferred code with a brief-only adapter**

In `analysis.ts`:

1. Delete `MAX_PDF_PAGES`, PNG signature/page inventory parsing, `PdfIntakePageArtifact`, `PdfIntakeArtifactSet`, `loadPdfIntakeArtifactSet`, `analyzePlansCommand`, and all plan command registration/export.
2. Keep `trustedScope`, artifact-byte SHA verification, intake result tuple validation, and `briefSchema`; add `MAX_BRIEF_BYTES = 65_536`.
3. Implement `loadPdfIntakeBrief` that finds only the `extract_pdf` intake run under full trusted scope, validates `status: 'ok'`, `resultKind: 'artifact'`, exact output descriptor control files, then validates/reads only `brief.json`. Do not fetch page PNGs or materialize Attachments.
4. Add `findSuccessfulGroupedMatcherRun` that queries `AgentRun` using trusted scope, workflow instance, fixed `stepId: 'match_catalog'`, matcher ID, `status: 'ok'`, and `deletedAt: null`; it returns only an output accepted by `catalogMatcherGroupedResultSchema.safeParse`.
5. In `matchRequirementsCommand.execute`, return that parsed result before calling the runtime. Otherwise call `agentRuntime.run` once with grouped input and `invocationId: randomUUID()`, check the returned result with `catalogMatcherGroupedResultSchema.parse`, and return it.
6. Preserve `registerCommand(matchRequirementsCommand)`. Reject an empty or byte-oversized brief before runtime invocation. Never catch a terminal artifact/agent error and convert it to an empty result.

- [ ] **Step 4: Run the handoff test and confirm pass**

Run:

```bash
yarn test src/modules/rfq_intake/__tests__/analysis-commands.test.ts
```

Expected: PASS. The command sends exact raw text once, rejects every invalid fixture without a runtime call, reuses only grouped-v2 success, and gives a failed/legacy run a fresh invocation ID.

- [ ] **Step 5: Commit the safe handoff**

```bash
git add src/modules/rfq_intake/commands/analysis.ts src/modules/rfq_intake/__tests__/analysis-commands.test.ts
git commit -m "feat(rfq): hand PDF briefs to catalog matcher"
```

## Task 3: Narrow the registered RFQ workflow and process projection

**Files:**
- Modify: `src/modules/rfq_intake/workflows.ts:1-211`
- Modify: `src/modules/rfq_intake/lib/processDefinition.ts:41-48`
- Modify: `src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts:29-82`
- Modify: `src/modules/rfq_intake/__tests__/process-definition.test.ts`

**Interfaces:**
- Consumes: `PDF_AGENT_ID`, `rfq_intake.requirements.match`, strict workflow interpolation, and existing `RFQ_ANALYSIS_WORKFLOW_ID`.
- Produces this graph:

```ts
['START', 'AUTOMATED', 'AUTOMATED', 'END']
// activities: ['INVOKE_AGENT', 'UPDATE_ENTITY']
// transitions: start → extract_pdf → match_catalog → end
```

- The ProcessDefinition keeps `workflowId: RFQ_ANALYSIS_WORKFLOW_ID` and `triggers: [{ kind: 'manual', requireFeatures: [] }]`.

- [ ] **Step 1: Rewrite workflow/config tests first**

Change `rfq-intake-wiring.test.ts` to assert exactly two activities and no `rfq_intake.deal.advance` or `rfq_intake.plans.analyze` reference. Assert intake remains first and matcher receives strict interpolated `{ tenantId, organizationId, workflowInstanceId, stepId: 'match_catalog' }`.

Update `process-definition.test.ts` to assert the same manual trigger and the new description: `Reads the RFQ PDF and matches its brief against the catalog.`

- [ ] **Step 2: Run workflow/process tests and confirm failure**

Run:

```bash
yarn test src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts src/modules/rfq_intake/__tests__/process-definition.test.ts
```

Expected: FAIL because the current graph includes quoting, plan analysis, and review actions, and the process description still mentions floor-plan measurement.

- [ ] **Step 3: Implement the two-stage graph**

In `workflows.ts`:

1. Keep `RFQ_ANALYSIS_WORKFLOW_ID`, `PDF_AGENT_ID`, strict interpolation, `extract_pdf`, and `match_catalog` IDs.
2. Remove `deal.advance` and `plans.analyze` from `registerWorkflowSafeCommands`; retain only `rfq_intake.requirements.match` with its current feature gate/label key.
3. Remove `mark_quoting`, `measure_plans`, and `mark_review` steps and their transitions.
4. Make `match_catalog` the only post-intake automated step. Pass no `dealId`; pass fixed `stepId: 'match_catalog'` with workflow tenant, organization, and instance ID.
5. Keep `definition.triggers` empty. The subscriber/process starter remains the only automatic entry point.

In `processDefinition.ts`, update only `codeOwnedFields().description` to the new two-stage wording. Do not modify trigger ownership, seeding, indexing, or manual-start behavior.

- [ ] **Step 4: Run workflow/process tests and confirm pass**

Run:

```bash
yarn test src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts src/modules/rfq_intake/__tests__/process-definition.test.ts
```

Expected: PASS. The registry accepts strict two-stage workflow data and process reconciliation preserves the manual trigger.

- [ ] **Step 5: Commit the narrowed graph**

```bash
git add src/modules/rfq_intake/workflows.ts src/modules/rfq_intake/lib/processDefinition.ts src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts src/modules/rfq_intake/__tests__/process-definition.test.ts
git commit -m "feat(rfq): reduce analysis workflow to catalog matching"
```

## Task 4: Publish migration guidance and regenerate discovery

**Files:**
- Create: `UPGRADE_NOTES.md`
- Modify: `.ai/specs/2026-09-19-property-document-sales-quote-drafts.md:214-225`
- Generated by command: `.mercato/generated/ai-agents.generated.ts`
- Generated by command: `.mercato/generated/ai-agents.generated.bundled.mjs`
- Generated by command: `.mercato/generated/app-modules/src-modules-property-documents-ai-agents-*.mjs`

**Interfaces:**
- Consumes: stable matcher ID and the legacy/grouped schemas from Task 1.
- Produces a public migration statement:

```md
## property_documents.catalog_matcher

Deprecated legacy call: `{ text, limit? }` → `{ matches, unmatchedTerms }`.
New grouped call: `{ mode: 'grouped', text, maxNeeds, limitPerNeed }` →
`{ data: { contractVersion: 2, needs, warnings } }`.
The legacy form remains supported through the next minor release.
```

- [ ] **Step 1: Create public migration guidance**

Create `UPGRADE_NOTES.md` with the exact legacy-to-grouped migration, stable ID guarantee, one-minor support window, and no database migration. Retain the approved spec compatibility section unchanged unless implementation proves one factual contract statement false; in that case, stop and amend the spec before continuing.

- [ ] **Step 2: Regenerate and inspect discovery**

Run:

```bash
yarn generate
```

Inspect the generated agent-registration source/bundle for `property_documents.catalog_matcher`. Confirm it preserves the stable ID and resolves the changed result schema and grouped sample input. Do not hand-edit generated files.

- [ ] **Step 3: Run contract and generation verification**

Run:

```bash
yarn test src/modules/property_documents/__tests__/catalog-matcher-agent.test.ts
yarn typecheck
yarn lint
```

Expected: PASS. The generated registry contains the same stable matcher ID; source and generated discovery compile without a new discovery shape.

- [ ] **Step 4: Commit migration guidance and generated discovery**

```bash
git add UPGRADE_NOTES.md .ai/specs/2026-09-19-property-document-sales-quote-drafts.md .mercato/generated/ src/modules/property_documents/__tests__/catalog-matcher-agent.test.ts
git commit -m "docs: document catalog matcher grouped migration"
```

## Final Verification

- [ ] Run focused suites together:

```bash
yarn test src/modules/property_documents/__tests__/catalog-matcher-agent.test.ts src/modules/rfq_intake/__tests__/analysis-commands.test.ts src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts src/modules/rfq_intake/__tests__/process-definition.test.ts
```

Expected: all focused tests pass, including no-runtime-call invalid cases and grouped-only reuse.

- [ ] Run the Hackathon Mode gate:

```bash
yarn generate && yarn typecheck && yarn lint
```

Expected: all commands exit 0.

- [ ] Perform one real scoped smoke run in the existing Process/Workflow surface with an RFQ PDF and seeded catalog. Verify: one `pdf_intake` run, one grouped-v2 matcher run, matching tenant/organization/workflow IDs, and terminal `END`; no room, Sales, CRM-stage, or future-agent action appears.

- [ ] Review the diff for only planned source, tests, generated registrations, spec, and `UPGRADE_NOTES.md`; leave user work and `.worktrees/` untouched.

## Plan Self-Review

- **Spec coverage:** REQ-001/REQ-002 map to Task 3 and TEST-001; REQ-003 maps to Task 2 and TEST-002/003; REQ-004 maps to Task 2 and TEST-004; REQ-005 maps to Task 1 and TEST-005. No requirement lacks an implementation task or test oracle.
- **Placeholder scan:** every task names exact files, inputs, tests, commands, and expected outcomes; no unresolved marker or generic implementation instruction remains.
- **Type consistency:** Task 1 exports `catalogMatcherGroupedResultSchema`; Task 2 imports it. Task 2 emits the exact grouped input that Task 1 branches on. Task 3 sends the step ID Task 2 enforces.
- **Review focus:** all five high-risk inputs/conditions have a named focused test in Tasks 2–3.

# RFQ Sales Quote Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `rfq_intake.analysis` replace the lines of its existing scoped Sales quote target after the quote drafter proposal is approved.

**Architecture:** Keep the legacy workflow input field `dealId`, but treat its value exclusively as a Sales quote UUID. Replace the app-owned creation path with a scoped `rfq_intake.quote.replace` command that delegates all line mutations and total calculation to installed Sales commands. Add a workflow-safe proposal application command after the Agent Orchestrator disposition, because the disposition persists approval but does not execute an action.

**Tech Stack:** TypeScript, Zod, Jest, Open Mercato workflows, Agent Orchestrator, installed Sales commands, MikroORM query resolver.

**Spec:** `.ai/specs/2026-09-19-rfq-quote-create-command.md`

## Global Constraints

- `dealId` remains the public workflow field name; its value must be a scoped, non-deleted `SalesQuote` UUID. It must never fall back to a CRM deal or create a quote.
- The workflow graph is exactly `START → extract_pdf → measure_rooms → match_catalog → draft_quote → apply_quote → END`; remove every CRM deal stage update and customer-deal attachment write.
- Reuse installed `sales.quotes.lines.delete`, `sales.quotes.lines.upsert`, and `sales.quotes.update` commands. Do not add direct ORM writes, entities, routes, migrations, UI, retries, compensation, or a custom transaction primitive.
- Validate the quote and all candidate lines before the first delete. If no valid line survives, return without a Sales mutation.
- Preserve an unsent quote status; use installed `sales.quotes.update` so a sent quote follows its existing reset-to-`draft` behavior.
- Scope derives from the workflow principal and fails closed. Agent output must not choose tenant, organization, or arbitrary command IDs.
- Keep unrelated quote metadata and add only the source marker, workflow instance ID, and measurement run ID. Do not include PDF text or model transcripts.
- Record the accepted sequential mutation risk inline: `// HACK(hackathon): Sales exposes individual line delete/upsert commands but no atomic replacement primitive. The demo starts the replacement once; a failure between operations can leave a partial line set and requires operator inspection/re-run. No retry, compensation, or concurrent-edit protection ships in this slice.`
- Never edit `node_modules/**` or `.mercato/generated/**` by hand. Run `yarn generate` after workflow/agent discovery changes.
- This run explicitly waives `yarn lint`; run focused Jest suites, `yarn generate`, and `yarn typecheck` instead.

## Review Focus

- A foreign, deleted, or CRM-deal UUID in `dealId` must fail before a line delete, line upsert, quote update, or quote create command; Task 1 pins this in its scoped-target tests.
- A proposal whose resolved measurements/catalog validation leaves zero lines must retain all existing lines and totals; Task 1 pins this with an empty-survivor test.
- A sent quote must use the installed update path and return to `draft` rather than retain a stale acceptance token; Task 1 observes the `sales.quotes.update` invocation and the installed-command outcome fixture.
- A disposition with no selected proposal, an unsupported action, or an action for another workflow step must fail instead of executing an arbitrary command; Task 2 tests all three rejected inputs.
- A line-command failure after deletion can leave a partial line set by the approved hackathon tradeoff; Task 1 tests that the error reaches the workflow caller without a false `quoteUpdate` success output.

---

### Task 1: Replace a scoped Sales quote’s deterministic line set

**Files:**
- Rename: `src/modules/rfq_intake/commands/quote-create.ts` → `src/modules/rfq_intake/commands/quote-replace.ts`
- Rename: `src/modules/rfq_intake/__tests__/quote-create-command.test.ts` → `src/modules/rfq_intake/__tests__/quote-replace-command.test.ts`
- Modify: `src/modules/rfq_intake/__tests__/quote-lines.test.ts`
- Modify: the RFQ command discovery file that imports `quote-create.ts` (locate its symbol references before renaming)

**Interfaces:**
- Consumes: `{ dealId: string; roomMeasurementsRunId: string; items: QuoteItemInput[] }`, trusted `tenantId`, trusted `organizationId`, and the existing deterministic measurement/catalog pricing helpers.
- Produces: command ID `rfq_intake.quote.replace`, input schema `quoteReplaceInputSchema`, and result `{ quoteId: string; lineCount: number; warnings: string[] }`.
- Calls only after validation: installed `sales.quotes.lines.delete`, `sales.quotes.lines.upsert`, and `sales.quotes.update` under the caller principal.

- [ ] **Step 1: Locate the exact installed and app registration contracts**

Use LSP references on the current command export/import before any rename. Read the exported `executeProposal` signature at `.ai/framework-context/open-mercato-enterprise@0.8.0/source/agent_orchestrator/lib/runtime/executeProposal.ts`, the installed Sales line command input schemas, and the exact `SalesQuote` entity import used by the app. Record the actual `{ body: ... }` envelopes and optimistic-lock/version requirements in the implementation diff; do not infer them from command IDs.

- [ ] **Step 2: Write the failing replacement-command tests**

Rename the current command test with LSP file rename support, then replace creation expectations with these observable cases:

```ts
it('replaces existing lines on the scoped target quote', async () => {
  await replaceQuote({ dealId: QUOTE_ID, roomMeasurementsRunId: RUN_ID, items: [VALID_ITEM] })
  expect(commandBus).toHaveBeenCalledWith('sales.quotes.lines.delete', expect.objectContaining({ body: expect.objectContaining({ quoteId: QUOTE_ID }) }))
  expect(commandBus).toHaveBeenCalledWith('sales.quotes.lines.upsert', expect.objectContaining({ body: expect.objectContaining({ quoteId: QUOTE_ID }) }))
  expect(commandBus).toHaveBeenCalledWith('sales.quotes.update', expect.objectContaining({ body: expect.objectContaining({ id: QUOTE_ID }) }))
  expect(commandBus).not.toHaveBeenCalledWith('sales.quotes.create', expect.anything())
})

it.each([undefined, FOREIGN_QUOTE_ID, CRM_DEAL_ID])(
  'does not mutate when dealId is not a scoped quote: %s',
  async (dealId) => {
    await expect(replaceQuote({ dealId, roomMeasurementsRunId: RUN_ID, items: [VALID_ITEM] })).rejects.toThrow()
    expect(commandBus).not.toHaveBeenCalled()
  },
)

it('retains existing lines when no candidate survives validation', async () => {
  await expect(replaceQuote({ dealId: QUOTE_ID, roomMeasurementsRunId: RUN_ID, items: [INVALID_ITEM] })).resolves.toMatchObject({ lineCount: 0 })
  expect(commandBus).not.toHaveBeenCalled()
})
```

In `quote-lines.test.ts`, retain the existing deterministic quantity/product/price coverage and change only the final persistence assertions to line replacement. Add a sent-quote fixture asserting that the installed update path is used and its returned quote status is `draft`.

- [ ] **Step 3: Run the focused tests to prove red**

Run:

```bash
yarn test src/modules/rfq_intake/__tests__/quote-replace-command.test.ts src/modules/rfq_intake/__tests__/quote-lines.test.ts
```

Expected: FAIL because `rfq_intake.quote.replace` and its test imports do not exist, and the old creation command still queries `CustomerDeal` / calls `sales.quotes.create`.

- [ ] **Step 4: Implement the clean command cutover**

Rename the source using LSP so every app import changes. In `quote-replace.ts`:

1. Rename exported schema/types/functions from `Create` to `Replace` and register only `rfq_intake.quote.replace`.
2. Retain existing deterministic room-measurement, catalog, quantity, unit, and price derivation; remove `CustomerDeal` lookup, Customer relation resolution, customer-deal link construction, and every `sales.quotes.create` call.
3. Query `SalesQuote` by `dealId`, trusted tenant, trusted organization, and non-deleted predicate before computing mutation commands. Reject a missing or foreign record.
4. Fully validate and assemble the replacement line list before any mutation. Return `{ quoteId, lineCount: 0, warnings }` with no command bus call when none survives.
5. Add the exact approved `HACK(hackathon)` sequential-mutation comment immediately above the delete/upsert loop.
6. Fetch/delete each existing target line through the installed command contract, upsert each validated replacement line through the installed command contract, then call `sales.quotes.update` with the existing version/metadata and no status override. Preserve unrelated metadata while adding the RFQ source marker, workflow instance ID, and measurement run ID.
7. Let an installed command failure propagate. Do not synthesize success, retry, compensate, or issue a CRM mutation.

- [ ] **Step 5: Run the focused tests to prove green**

Run:

```bash
yarn test src/modules/rfq_intake/__tests__/quote-replace-command.test.ts src/modules/rfq_intake/__tests__/quote-lines.test.ts
```

Expected: PASS. The mock command history contains only scoped Sales line delete/upsert/update calls; all invalid targets and empty derived output issue no Sales mutation.

- [ ] **Step 6: Update operator migration guidance**

Add a `## RFQ analysis target change` section to `UPGRADE_NOTES.md`:

```md
`rfq_intake.analysis` keeps the `dealId` input name, but its value is now a Sales quote UUID. Existing callers that supply a CRM deal UUID fail closed and create no quote. Start the workflow from the target Sales quote detail and pass that quote ID. No migration or data conversion is required; rollback restores the prior workflow contract.
```

- [ ] **Step 7: Commit the independently testable command slice**

```bash
git add UPGRADE_NOTES.md src/modules/rfq_intake/commands src/modules/rfq_intake/__tests__
git commit -m "fix(rfq_intake): replace existing sales quote lines"
```

---

### Task 2: Apply the approved quote proposal from the workflow

**Files:**
- Create: `src/modules/rfq_intake/commands/quote-apply-proposal.ts`
- Modify: RFQ command discovery file identified in Task 1
- Modify: `src/modules/rfq_intake/ai-agents.ts`
- Modify: `src/modules/rfq_intake/workflows.ts`
- Modify: `src/modules/rfq_intake/commands/analysis.ts`
- Modify: `src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts`
- Modify: `src/modules/rfq_intake/__tests__/workflow-safe-commands.test.ts`
- Create: `src/modules/rfq_intake/__tests__/quote-apply-proposal.test.ts`

**Interfaces:**
- Consumes: `{ workflowInstanceId: string; stepId: 'draft_quote' }` and the exact installed Agent Orchestrator proposal/disposition API located in Task 1.
- Produces: command ID `rfq_intake.quote.apply_proposal`, which accepts only selected `rfq_intake.quote.replace` actions for the named workflow step and returns the replacement result.
- Workflow produces: `context.quoteUpdate = { quoteId: string; lineCount: number; warnings: string[]; updatedAt: string }`.

- [ ] **Step 1: Write failing proposal-application tests**

Create `quote-apply-proposal.test.ts` with a controlled selected proposal fixture. Test these cases:

```ts
it('executes the selected rfq_intake.quote.replace action for draft_quote', async () => {
  await expect(applyProposal({ workflowInstanceId: INSTANCE_ID, stepId: 'draft_quote' })).resolves.toEqual(REPLACEMENT_RESULT)
  expect(executeProposal).toHaveBeenCalledWith(
    [{ type: 'rfq_intake.quote.replace', payload: REPLACE_INPUT }],
    expect.objectContaining({
      commandBus,
      actionCommandMap: { 'rfq_intake.quote.replace': 'rfq_intake.quote.replace' },
      allowedActions: ['rfq_intake.quote.replace'],
    }),
  )
})

it.each([
  ['no selected proposal', NO_SELECTION],
  ['wrong workflow step', SELECTED_FOR_OTHER_STEP],
  ['unsupported action', SELECTED_FOR_ARBITRARY_COMMAND],
])('rejects %s without command execution', async (_label, fixture) => {
  mockProposal(fixture)
  await expect(applyProposal({ workflowInstanceId: INSTANCE_ID, stepId: 'draft_quote' })).rejects.toThrow()
  expect(executeProposal).not.toHaveBeenCalled()
})
```

Update workflow wiring tests to require the exact step order `start, extract_pdf, measure_rooms, match_catalog, draft_quote, apply_quote, end`, no `rfq_intake.deal.advance`, no `customers:customer_deal` attachment target, and a reachable post-drafter `UPDATE_ENTITY` activity invoking `rfq_intake.quote.apply_proposal`.

Update workflow safe-command tests to allow `rfq_intake.quote.replace` and `rfq_intake.quote.apply_proposal`, and to reject obsolete `rfq_intake.quote.create` and deal-stage mutation paths.

- [ ] **Step 2: Run the workflow tests to prove red**

Run:

```bash
yarn test src/modules/rfq_intake/__tests__/quote-apply-proposal.test.ts src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts src/modules/rfq_intake/__tests__/workflow-safe-commands.test.ts
```

Expected: FAIL because there is no proposal-application command and the current graph still has `mark_quoting` / `mark_review` rather than `apply_quote`.

- [ ] **Step 3: Implement the bounded proposal effector**

Create and register `quote-apply-proposal.ts`. It must derive scope from the workflow principal, load only the selected proposal for the requested instance and `draft_quote` step, and reject absent/wrong/unsupported selected actions. It must call the installed `executeProposal` function with the exact runtime signature found in Task 1; it must never dispatch a command ID taken unvalidated from an agent payload.

In `ai-agents.ts`, replace action vocabulary and copy from `rfq_intake.quote.create` to `rfq_intake.quote.replace`; retain only that allowed quote action. In `workflows.ts`, remove both deal-stage activities, retain the three analysis agent activities, and append `apply_quote` immediately after `draft_quote`. Make `apply_quote` invoke the new safe command using the workflow instance and `draft_quote`, then write only the stable `quoteUpdate` context output.

In `commands/analysis.ts`, stop creating an artifact association labeled `customers:customer_deal`. Use the quote/workflow correlation shape confirmed from the installed attachment contract in Task 1; no CustomerDeal identifier may remain in the RFQ analysis path.

- [ ] **Step 4: Run workflow tests to prove green**

Run:

```bash
yarn test src/modules/rfq_intake/__tests__/quote-apply-proposal.test.ts src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts src/modules/rfq_intake/__tests__/workflow-safe-commands.test.ts
```

Expected: PASS. A selected supported quote replacement is executed exactly once; an invalid disposition never reaches the replacement command; wiring exposes no CRM deal stage or customer-deal attachment write.

- [ ] **Step 5: Commit the workflow cutover**

```bash
git add src/modules/rfq_intake/ai-agents.ts \
        src/modules/rfq_intake/workflows.ts \
        src/modules/rfq_intake/commands \
        src/modules/rfq_intake/__tests__
git commit -m "fix(rfq_intake): apply approved quote replacements"
```

---

### Task 3: Regenerate, type-check, and smoke the real quote flow

**Files:**
- Modify only generated discovery output produced by `yarn generate`, if the generator changes it.
- Modify no application source unless a verification failure identifies a concrete contract defect; then add a focused regression test before fixing it.

**Interfaces:**
- Consumes: the registered replacement and proposal-application commands, the cut-over `rfq_intake.analysis` graph, local authenticated staff browser session, and a Sales quote with a valid PDF.
- Produces: generated discovery artifacts, type-correct source, and observed non-zero target quote lines/totals after one local workflow run.

- [ ] **Step 1: Regenerate discovery output**

Run:

```bash
yarn generate
```

Expected: exit 0. Review every generated-file change; retain only the command/agent/workflow registration corresponding to this slice.

- [ ] **Step 2: Run the required focused unit suites**

Run:

```bash
yarn test src/modules/rfq_intake/__tests__/quote-replace-command.test.ts \
          src/modules/rfq_intake/__tests__/quote-lines.test.ts \
          src/modules/rfq_intake/__tests__/quote-apply-proposal.test.ts \
          src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts \
          src/modules/rfq_intake/__tests__/workflow-safe-commands.test.ts
```

Expected: PASS. If a test fails, identify the exact command or graph contract mismatch, add/revise the smallest behavior test if it is unpinned, fix it, and rerun this command.

- [ ] **Step 3: Run the required type gate**

Run:

```bash
yarn typecheck
```

Expected: exit 0. Do not run `yarn lint`: the user explicitly waived it for this slice.

- [ ] **Step 4: Exercise the actual browser surface once**

Open a local Sales quote detail in a browser, start `rfq_intake.analysis` with that quote UUID in `dealId` and a valid PDF, wait for the completed workflow, then reload the same quote detail. Confirm visually that the quote ID is unchanged, generated lines are present, and totals are non-zero. Inspect the workflow context and confirm `quoteUpdate.quoteId` matches the page record and `quoteUpdate.lineCount` matches visible generated lines.

If the UI lacks a process-start control, invoke the repository-native workflow start command with the same authenticated/local principal, then use the browser only to observe the quote detail and workflow instance. Do not mutate the user’s already-failed historical instance in place.

- [ ] **Step 5: Commit verification artifacts only when changed**

```bash
git status --short
git add .mercato/generated
# Stage only generated discovery files changed by this feature; never stage .env or unrelated files.
git commit -m "chore(rfq_intake): regenerate quote workflow discovery"
```

Skip this commit when `yarn generate` produced no intended tracked changes.

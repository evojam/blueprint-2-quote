# RFQ Quote Creation Command

**Date**: 2026-09-19
**Status**: Draft — ready for review

## 📝 TLDR

An app-owned command, `rfq_intake.quote.create`, turns an agent's mapping of renovation work onto Catalog service types into a scoped, editable, unsent `SalesQuote`. The agent supplies only what it is qualified to supply — which service a piece of work is, and the raw geometry it read from the brief. Every multiplication, unit check, price lookup, and scope derivation happens in deterministic code. The Catalog product's `defaultUnit` acts as the type system for the agent's output: a measurement whose computed unit does not match the mapped service is rejected rather than coerced.

This is the repository's **first use of the Agent Orchestrator's proposal-execution mechanism**, so this document specifies that path in full rather than assuming it.

## 📝 Problem Statement

The RFQ analysis chain ends with catalog matches and no priced document. Composing a quote requires arithmetic over measurements — wall areas minus openings, summed runs, counted fixtures — and a price lookup per line. Both are things a language model does unreliably and code does exactly.

The seeded renovation catalog (`src/modules/catalog_seed/data/renovation-catalog.ts`, 46 services) shows why the split matters. Services bill in four units: `szt` (27 services), `m2` (11), `mb` (5), `kpl` (2). A model asked for a finished quantity has to silently pick a unit convention, a multiplication, and a deduction rule per service, with no place to record which it chose. A model asked only *"which service is this, and what did the brief say the dimensions were"* produces a checkable artifact: the command recomputes the number and can prove the unit is the one the service actually bills in.

Multi-variant services make the stakes concrete. Wall painting (`REN-FIN-01`) carries three paint variants at 40, 55 and 65 PLN/m²; floor panels (`REN-FIN-07`) three at 70, 90 and 130. A wrong variant is a 60%+ error on the line, and nothing downstream catches it: **every price field on a Sales quote line is optional**, so `sales.quotes.create` will happily persist a quote whose lines carry no price at all.

## 📝 Proposed Solution

One command, invoked with a per-item mapping and a per-item measurement. The command owns scope derivation, deal verification, customer resolution, quantity computation, the unit gate, variant and price resolution, and the call to Sales. The agent owns nothing but the mapping and the numbers it read.

**Alternative considered — agent returns finished quantities.** Rejected: it moves arithmetic into the model and leaves no artifact to re-verify. The unit gate becomes impossible, because a bare number carries no claim about how it was derived.

**Alternative considered — a `quote_draft_composer` agent emitting typed `derivation` coordinates** (the design in `.ai/specs/2026-09-19-property-document-sales-quote-drafts.md`). Deferred: it presupposes a composer agent and durable, replayable `AgentRun` evidence, neither of which exists yet. The measurement contract here is the same idea with the indirection removed — the agent states the geometry directly instead of pointing at evidence rows the command must reload.

## 📝 Architecture

### Relationship to the existing RFQ documents

Two neighbouring documents exist on `main`, and they do not currently agree with each other.

`.ai/specs/2026-09-19-property-document-sales-quote-drafts.md` ("RFQ PDF Intake to Catalog Match", approved 2026-09-19) puts this capability **explicitly out of its own scope**: its TLDR states that *"room analysis, quote composition, Sales quote creation, CRM stage changes, UI, migrations, and later agents are deliberately outside this slice."* There is therefore no competing spec for quote creation, and `.ai/guides/spec-delivery.md` rule 4 is satisfied: **this document owns `rfq_intake.quote.create`**, filling a gap the neighbouring spec deliberately left open.

`docs/superpowers/plans/2026-09-19-rfq-sales-quote-drafts.md`, also on `main`, is the exception. It plans `rfq_intake.quote.create` and `rfq_intake.quote.compose` in detail while citing that same spec as its source — so on `main` the plan is ahead of the spec it names. **This spec supersedes that plan's quote-creation design**, for one concrete reason.

The plan requires product-level price candidates with `productVariantId = null` and requires the resolved row to carry a null variant (`:365`, `:393`). `catalog_seed` creates prices exclusively through `catalog.prices.create` with a `variantId` (`src/modules/catalog_seed/cli.ts:268-277`); the table is `catalog_product_variant_prices`. `CatalogProductPrice` does carry both a nullable `product` and a nullable `variant` relation, so product-level rows are *schematically* possible — but **not one exists in the seeded catalog**. Against demo data that lookup returns zero prices, every line is dropped, and the run ends in `review_required` with no quote. This spec resolves prices on the variant.

**Reviewer note.** A longer, unmerged revision of the neighbouring spec exists on branch `feat/deal-document-links`; it does declare `rfq_intake.quote.create` in a Commands table and carries the same product-level pricing assumption. Whoever merges that branch must reconcile it with this document rather than land a second owner for the command.

### How the agent invokes the command

This is the first use of the mechanism in this repository, so every hop is named.

```text
proposal agent
  └─ AgentResult payload: { options: [ { id, label, confidence, actions: [ { type, payload, risk? } ] } ] }
        │
        ▼  INVOKE_AGENT executor calls DispositionService.dispose() INLINE, right after agentRuntime.run
        ├─ confidence ≥ onResult.autoApproveThreshold and not alwaysAsk
        │     → audited command agent_orchestrator.proposals.dispose, verdict auto_approved
        │       (dispositionBy 'rule:threshold', skipResume) → emits proposal.disposed, no parking
        └─ otherwise
              → workflows USER_TASK; the instance parks at WAIT_FOR_SIGNAL
              → the operator's dispose endpoint emits proposal.ready, which resumes the instance
        │
        ▼  NEITHER BRANCH EXECUTES THE ACTIONS — disposition decides, it does not effect
  next workflow step: rfq_intake.quote.apply_proposal (UPDATE_ENTITY)
        ├─ loads the scoped AgentProposal by workflowInstanceId + agentId, reads selectedOptionId
        └─ executeProposal(actions, { commandBus, commandCtx, actionCommandMap, allowedActions })
              ├─ re-reads the action vocabulary immediately before the effect
              ├─ isEffectWithinVocabulary(...) — fail-closed
              └─ commandBus.execute('rfq_intake.quote.create', { input: action.payload, ctx })
```

Sources: `executeProposal.ts`, `actionVocabulary.ts`, `disposition/dispositionService.ts:75-99`, and `data/entities.ts:1137` (`selected_option_id`), all under `node_modules/@open-mercato/enterprise/src/modules/agent_orchestrator/`.

`executeProposal` is an **optional helper with no caller anywhere in this repository** — its own doc comment says *"this helper is not mandatory in the MVP"*, and `actionCommandMap` is supplied by the caller. Providing that caller is this spec's work. A post-agent workflow step is the correct seam: disposition is settled by the time the next step runs on both branches (auto-approve proceeds without parking; the human branch resumes only after disposal), and the effect therefore stays post-commit.

### The five gates, all of which must hold

A failure in any one of these produces a silent `skipped`, not an error. They are listed together because four of them are invisible at the call site.

| # | Gate | Where it is satisfied | Symptom when missing |
|---|---|---|---|
| 1 | `rfq_intake.quote.create` is a registered workflow-safe command | `registerWorkflowSafeCommands` in `src/modules/rfq_intake/workflows.ts` | `vocabulary.commandIds` lacks it → action `skipped` as outside vocabulary |
| 2 | The tenant has enabled that command | workflow-commands settings, once per tenant | Same as 1 — the entry is deliberately not `defaultEnabled` |
| 3 | The agent's `allowedActions` admits the effect | agent definition | `isEffectWithinVocabulary` returns false; `allowedActions: []` denies everything |
| 4 | `actionCommandMap` maps the action type to the command ID | the app's `apply_proposal` command | `skipped: no command mapped for action type "…"` |
| 5 | The action vocabulary is loadable at all | the `workflows` peer module being present | `available: false` blocks **every** effect, by design |

Gate 3 accepts either name: `isEffectWithinVocabulary` passes when `allowedActions` contains the action type **or** the command ID.

Gates 1 and 2 are the demo-killers. The other three RFQ workflow commands already carry the same constraint, and the module's own comment records why: upstream discourages grandfathering new commands, so nothing runs until a tenant enables it once.

### Scope derivation

`tenantId` and `organizationId` come **only** from the command runtime context (`ctx.auth.tenantId`, `ctx.selectedOrganizationId ?? ctx.auth.orgId`) and fail closed when absent. `action.payload` originates from a language model and is treated as hostile: the input schema is non-strict so unknown keys are **stripped** rather than rejected, following `src/modules/deal_links/commands/document-links.ts:8-17`. A payload carrying `tenantId` cannot reach the write path.

`dealId` is accepted but never trusted: the deal is re-read within the derived scope, and a miss is a 404 with no write. This mirrors `src/modules/rfq_intake/inbox-actions.ts:102`, which calls `customers.deals.create` rather than touching `customer_deals` directly.

## 📝 Data Model

No new entities and no migration. This slice persists nothing of its own: the quote is a Sales record, and correlation travels in the quote's free-form `metadata`.

The consequence is stated plainly: **there is no idempotency record, so two invocations create two quotes.** This is an accepted hackathon shortcut, recorded in code as `// HACK(hackathon):`, not an oversight. The approved RFQ spec's `RfqQuoteDraftOperation` remains the durable answer when one is needed.

## 📝 API Contracts

### Input — the agent-facing shape

```ts
{
  dealId: uuid,                 // untrusted; re-read in derived scope
  items: [{
    catalogProductId: uuid,     // the agent's semantic mapping: work -> service
    variantId?: uuid,           // chosen from the list supplied in the agent's prompt
    note?: string,              // becomes the line description
    measurement: Measurement
  }]
}
```

No `currencyCode`, no price field, no `customerEntityId`, no `channelId`, no scope keys. Those are derived, never accepted.

`variantId` is optional: omitted, the command falls back to the product's `isDefault` variant, which the seed sets for all 46 services. A `variantId` belonging to a **different** product is always a rejection of that item, never a substitution.

### `Measurement`

```ts
const metres = z.number().positive().max(100)          // upper bound catches cm/m confusion

const surface = z.union([
  z.object({ width: metres, height: metres, label: z.string().max(120).optional() }),
  z.object({ area: z.number().positive().max(10_000), label: z.string().max(120).optional() }),
])

const deduction = z.union([
  z.object({ width: metres, height: metres, count: z.number().int().positive().max(200).default(1),
             label: z.string().max(120).optional() }),
  z.object({ area: z.number().positive().max(10_000), count: z.number().int().positive().max(200).default(1),
             label: z.string().max(120).optional() }),
])

const measurement = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('area'),
    surfaces: z.array(surface).min(1).max(100),
    deductions: z.array(deduction).max(100).default([]),
  }),
  z.object({
    kind: z.literal('length'),
    segments: z.array(z.object({ length: metres, label: z.string().max(120).optional() })).min(1).max(100),
  }),
  z.object({
    kind: z.literal('count'),
    count: z.number().int().positive().max(10_000),
  }),
])
```

### Quantity derivation and the unit gate

| `kind` | Quantity | Accepted `defaultUnit` |
|---|---|---|
| `area` | `Σ surfaces − Σ (deduction × count)`, rounded to 2 decimals, clamped at zero | `m2` |
| `length` | `Σ length` | `mb` |
| `count` | `count` | `szt`, `kpl` |

Three kinds cover all 46 seeded services. Two design calls carry the weight:

**One `area` kind, not `wall_area` + `floor_area`.** `REN-FIN-01` is *"Malowanie ścian i sufitów"* — one product, therefore one quote line, therefore one quantity that must sum walls **and** ceiling. Split kinds leave the agent nowhere to put that, and force it to decide whether a ceiling is a wall or a floor: a question with no correct answer, which would produce random misclassification. A single `area` kind with `label` carrying "ściana północna" or "sufit" removes the decision.

**`{ area }` beside `{ width, height }`.** Briefs state "mieszkanie 68 m²" far more often than they enumerate wall dimensions. Without the direct form, an agent that already knows the number must invent dimensions to express it — precisely the fabrication this design exists to prevent.

**`count` maps to two units.** `szt` and `kpl` differ in billing vocabulary, not in how they are counted, so the gate is set membership, not equality.

### Output

```ts
{ quoteId: string | null, lineCount: number, warnings: string[] }
```

`quoteId` is `null` when no item survives validation; nothing is created in that case.

### Downstream call

`sales.quotes.create` (`node_modules/@open-mercato/core/src/modules/sales/commands/documents.ts:4713`, schema `sales/data/validators.ts:741`) returns `{ quoteId }`. It requires `tenantId`, `organizationId` and `currencyCode`; `quoteNumber` is optional and self-generates through `salesDocumentNumberGenerator`, so this slice does not reserve one. Payload scope is verified against the runtime context by `ensureQuoteScope` (`documents.ts:4740`) — checked, never trusted.

Lines are emitted as `kind: 'service'` with `quantity`, `quantityUnit`, `unitPriceGross`, `taxRateId`, `priceMode: 'gross'`, `name` from the product title, `description` from the item `note`, and a `catalogSnapshot`. Gross pricing is not a choice: the seed writes `unitPriceGross` with a VAT 8% `taxRateId`. Quote `metadata` carries `{ rfqDealId, source: 'rfq_intake' }`.

## 📝 UI/UX

No new page and no new component. A successful run produces an ordinary unsent Sales quote; operators edit lines, dates, customer, channel and prices in the existing Sales quote detail, and the existing **Send quote** action remains the only approval boundary. Warnings from dropped items are returned by the command and surfaced by the caller.

## 📝 Edge Cases & Failure Scenarios

Every per-item failure drops that item with a bounded warning and lets the rest proceed. Only scope and deal failures abort the command.

| Situation | Behavior |
|---|---|
| Missing tenant or organization in context | Command fails closed; nothing written |
| `dealId` absent from derived scope | 404; no write |
| Payload carries scope keys | Stripped by the schema before validation |
| Product not found in scope | Item dropped with warning |
| `variantId` omitted | Falls back to the product's `isDefault` variant |
| `variantId` belongs to another product | Item dropped; never substituted |
| Computed unit ≠ product `defaultUnit` | Item dropped with warning — the core semantic check |
| Deductions exceed surfaces | Quantity clamped at zero, therefore dropped as non-positive |
| Dimension given in centimetres | Rejected by `metres.max(100)` before it can reach pricing |
| No price row for the variant in the resolved currency | Item dropped with warning |
| Resolved price row points at a different variant | Item dropped; never substituted |
| Lines resolve to mixed currencies | Outliers dropped; the majority currency is used |
| Zero items survive | `quoteId: null`, no quote created, warnings returned |
| Deal has no linked customer | Quote created without `customerEntityId` (optional in Sales) |
| Command invoked twice | Two quotes — see Data Model; accepted shortcut |

## 📝 Risks & Impact Review

**Blast radius.** Additive only: one new command ID, one new workflow-safe registration, one new workflow step. No installed module is modified, no cross-module ORM relation is added, no shipped migration is touched. Cross-module access is by scalar ID and owner-command call throughout.

**Contract surface.** `rfq_intake.quote.create` is a new command ID rather than a change to an existing one, so nothing existing breaks. Registering it as workflow-safe widens the agent action vocabulary by exactly one entry, and only for tenants that then enable it.

**Rollback.** Remove the workflow step and the workflow-safe registration; the command becomes unreachable and no data migration is needed. Quotes already produced are ordinary Sales quotes and are deleted or voided through Sales.

**Principal risk — the two enablement gates.** Gates 1 and 2 above fail silently as `skipped`. The mitigation is that `apply_proposal` surfaces every non-`ok` result from `executeProposal` as a visible warning rather than discarding it.

**Deliberate non-goal.** Linking the created quote to the deal through `deal_links.document_links.create` is out of scope here and belongs to the slice that wires the workflow.

## 📋 Phasing

One independently shippable phase. The command and its pure arithmetic are useful and testable before any agent exists, and the invocation path is specified so the next slice can wire it without re-deriving the mechanism.

## 📋 Implementation Plan

**Phase 1 — the command and its arithmetic**

1. `src/modules/rfq_intake/lib/measurements.ts` — pure quantity functions and the `kind → accepted units` map. No I/O. Unit tests cover surfaces minus deductions, the `{ area }` form, clamping at zero, rounding, summed segments, counts, and the centimetre guard.
2. `src/modules/rfq_intake/commands/quote-create.ts` — the input schema and handler, following `deal_links/commands/document-links.ts`. Tests cover a foreign deal, stripped scope keys, a variant from another product, the `isDefault` fallback, a unit mismatch, a missing price, mixed currencies, zero surviving items, and the happy path.
3. Register `rfq_intake.quote.create` through `registerWorkflowSafeCommands` alongside the three existing entries, with `requiredFeatures: ['customers.deals.manage', 'sales.quotes.manage']`.
4. Run `yarn generate && yarn typecheck && yarn lint`, then the focused tests.

Each step leaves the application working: after step 2 the command exists and is callable from tests; step 3 only makes it reachable.

**Out of scope, named so the next slice can pick them up:** the `apply_proposal` bridge command, the proposal agent itself, the workflow step, the `deal_links` call, and any durable idempotency record.

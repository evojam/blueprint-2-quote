# RFQ Quote Creation Command

**Date**: 2026-09-19
**Status**: Draft — ready for review

## 📝 TLDR

An app-owned command, `rfq_intake.quote.create`, turns an agent's mapping of renovation work onto Catalog service types into a scoped, editable, unsent `SalesQuote`. The agent emits **identifiers and one enum per item — no arithmetic at all**: which Catalog service the work is, which rooms it applies to, and on what basis the quantity is measured. Every geometric computation, unit normalization, price lookup, and scope derivation happens in deterministic code over the `property_documents.room_measurements` result.

Two things make this possible and are specified here in full: the **Agent Orchestrator's proposal-execution mechanism**, whose first use in this repository this would be, and the **deterministic geometry reduction** that makes the model's arithmetic unnecessary.

A **temporary probe agent** ships with it, whose only purpose is to exercise that mechanism end to end before the real mapping agent exists.

## 📝 Problem Statement

The RFQ analysis chain ends with catalog matches and no priced document. Composing a quote requires arithmetic over measurements — wall areas minus openings, floor polygons minus voids, summed runs, counted fixtures — and a price lookup per line. Both are things a language model does unreliably and code does exactly.

The seeded renovation catalog (`src/modules/catalog_seed/data/renovation-catalog.ts`, 45 services) shows why the split matters. Services bill in four units: `szt` (27 services), `m2` (11), `mb` (5), `kpl` (2). A model asked for a finished quantity has to silently pick a unit convention, a multiplication, and a deduction rule per service, with no place to record which it chose.

Multi-variant services make the stakes concrete. Wall painting (`REN-FIN-01`) carries three paint variants at 40, 55 and 65 PLN/m²; floor panels (`REN-FIN-07`) three at 70, 90 and 130. A wrong variant is a 60%+ error on the line, and nothing downstream catches it: **every price field on a Sales quote line is optional**, so `sales.quotes.create` will happily persist a quote whose lines carry no price at all.

## 📝 Proposed Solution

One command. The agent names the service and the basis; the command resolves the geometry, the unit, the variant, the price, the customer and the scope.

**Alternative considered — agent returns finished quantities.** Rejected: it moves arithmetic into the model and leaves no artifact to re-verify.

**Alternative considered — agent returns raw geometry** (an earlier revision of this spec proposed a `Measurement` union of rectangles, segments and counts). Dropped once `property_documents.room_measurements` was examined: the agent would be re-typing geometry that already exists in a validated, evidence-bearing form, and a rectangle union cannot express an L-shaped room at all. Every quantity this command needs is computable from the V2 result by closed-form arithmetic, so the agent should reference it rather than restate it.

**Alternative considered — a `quote_draft_composer` agent emitting typed `derivation` coordinates** (the design in `docs/superpowers/plans/2026-09-19-rfq-sales-quote-drafts.md`). Superseded: the basis enum below carries the same information in one field, and the command derives the rest.

## 📝 Architecture

### Relationship to the existing RFQ documents

`.ai/specs/2026-09-19-property-document-sales-quote-drafts.md` ("RFQ PDF Intake to Catalog Match", approved 2026-09-19) puts this capability **explicitly out of its own scope**: its TLDR states that *"room analysis, quote composition, Sales quote creation, CRM stage changes, UI, migrations, and later agents are deliberately outside this slice."* There is therefore no competing spec, and `.ai/guides/spec-delivery.md` rule 4 is satisfied: **this document owns `rfq_intake.quote.create`**.

`docs/superpowers/plans/2026-09-19-rfq-sales-quote-drafts.md`, also on `main`, plans `rfq_intake.quote.create` and `rfq_intake.quote.compose` while citing that same spec, so on `main` the plan is ahead of the spec it names. **This spec supersedes that plan's quote-creation design.** The plan requires product-level price candidates with `productVariantId = null` (`:365`, `:393`); `catalog_seed` creates prices exclusively with a `variantId` (`src/modules/catalog_seed/cli.ts:268-277`) into `catalog_product_variant_prices`. `CatalogProductPrice` carries both a nullable `product` and a nullable `variant` relation, so product-level rows are *schematically* possible — but **not one exists in the seeded catalog**, so that lookup returns zero prices and every line is dropped. This spec resolves prices on the variant.

**Resolved.** A longer revision of the neighbouring spec appeared to live on branch `feat/deal-document-links`, declaring `rfq_intake.quote.create` with the same product-level pricing assumption. It was not a change that branch made: the branch was cut before `main` narrowed that spec and simply carried the older snapshot, so rebasing it onto `main` dropped the stale copy without a conflict. There is no second owner.

### Dependency on the room-measurements agent (PR #35)

This command consumes the **V2** contract added by `feat/property-pdf-agents`: `property_documents.room_measurements`, whose result is `{ schemaVersion, analysisStatus, drawing, rooms[], warnings }`. That PR states RFQ integration is deferred and keeps the legacy V1 `Room[]` available; this spec is the RFQ side of that cutover and targets V2 only.

The command reads the agent result in trusted scope. It never receives geometry through the agent payload.

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

`executeProposal` is an **optional helper with no caller anywhere in this repository** — its own doc comment says *"this helper is not mandatory in the MVP"*, and `actionCommandMap` is supplied by the caller. Providing that caller is this spec's work. A post-agent step is the correct seam: disposition is settled by the time it runs on both branches, so the effect stays post-commit.

### The five gates, all of which must hold

A failure in any one produces a silent `skipped`, not an error. Four are invisible at the call site.

| # | Gate | Where it is satisfied | Symptom when missing |
|---|---|---|---|
| 1 | `rfq_intake.quote.create` is a registered workflow-safe command | `registerWorkflowSafeCommands` in `src/modules/rfq_intake/workflows.ts` | `vocabulary.commandIds` lacks it → action `skipped` as outside vocabulary |
| 2 | The tenant has enabled that command | workflow-commands settings, once per tenant | Same as 1 — the entry is deliberately not `defaultEnabled` |
| 3 | The agent's `allowedActions` admits the effect | agent definition | `isEffectWithinVocabulary` returns false; `allowedActions: []` denies everything |
| 4 | `actionCommandMap` maps the action type to the command ID | the app's `apply_proposal` command | `skipped: no command mapped for action type "…"` |
| 5 | The action vocabulary is loadable at all | the `workflows` peer module being present | `available: false` blocks **every** effect, by design |

Gate 3 accepts either name: `isEffectWithinVocabulary` passes when `allowedActions` contains the action type **or** the command ID. Gates 1 and 2 are the demo-killers.

For scale: on `main`, `src/modules/rfq_intake/workflows.ts` declares exactly **one** workflow-safe command (`rfq_intake.requirements.match`), and `rfq_intake.deal.advance` exists as a command without being declared. This command is therefore the second declaration, not the fourth — the implementation plan records the full verified baseline.

### Scope derivation

`tenantId` and `organizationId` come **only** from the command runtime context (`ctx.auth.tenantId`, `ctx.selectedOrganizationId ?? ctx.auth.orgId`) and fail closed when absent. `action.payload` originates from a language model and is treated as hostile: the input schema is non-strict so unknown keys are **stripped**, following `src/modules/deal_links/commands/document-links.ts:8-17`. A payload carrying `tenantId` cannot reach the write path.

`dealId` is accepted but never trusted: the deal is re-read within the derived scope, and a miss is a 404 with no write. This mirrors `src/modules/rfq_intake/inbox-actions.ts:102`.

## 📝 Geometry Resolution

All of it is closed-form. The agent contributes nothing to this section.

### The pixel bridge

V2 coordinates are normalized to `[0,1]` against the image, so pixels are recovered by multiplication, and `drawing.calibrations[]` supplies the only usable scale — each entry carries `start{x,y}`, `end{x,y}` and `realLength { value, unit }`:

```text
d_px     = hypot( (end.x − start.x)·imageWidthPx , (end.y − start.y)·imageHeightPx )
m_per_px = realLength_in_metres / d_px
```

`drawing.declaredScale` is **not** usable arithmetic: it carries only `sourceText`, `evidence` and `confidence`, with no numeric field. A printed "1:50" would additionally require the physical print size, which a rendered page PNG does not carry. With `calibrations[]` empty there is no bridge at all, and only `printed` values remain usable.

### Quantity per basis

| Basis | Resolution order |
|---|---|
| `floor_area` | `floor.printedArea` when non-null, `eligible`, and `basis ∈ {gross, net}` → otherwise shoelace over `floor.outerBoundary` minus each `floor.holes[].boundary`, scaled by `m_per_px²` |
| `gross_wall_area` | `Σ walls[] ( length × height )` |
| `net_wall_area` | `gross_wall_area − Σ openings[] ( width × height )`, openings matched to walls by `wallId` |
| `count` | supplied by the agent, except doors and windows — see below |

Shoelace over a normalized boundary, converted:

```text
A_norm = ½ · | Σ (xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ) |
A_m²   = A_norm · imageWidthPx · imageHeightPx · m_per_px²
```

Ceiling area equals floor area geometrically, so a service covering walls **and** ceilings — `REN-FIN-01` is literally *"Malowanie ścian i sufitów"* — is quoted as one line whose quantity is `net_wall_area + floor_area` over the same rooms.

Wall length comes from `walls[].length` when present and is otherwise derived from `start`/`end` through the same bridge. Opening widths follow the same rule.

### What geometry cannot supply

A plan view has no vertical axis. Wall heights (`startHeight`, `endHeight`), `drawing.globalCeilingHeight`, `openings[].height` and `sillHeight` are **not derivable by any formula** and must come from a printed label or the global value. V2 names these failures directly as `ceiling_height_missing` and `opening_height_missing`. Consequently wall widths are always computable while wall *areas* are not: without a height, the item goes to review rather than into a quote.

### Re-deriving the model's own arithmetic

Every V2 measurement carries `method: 'printed' | 'scale_derived'`. A `scale_derived` value was computed by the model, and `realLength.calibrationId` records which calibration it used. The command recomputes every `scale_derived` value from `start`/`end` and compares; a disagreement beyond tolerance drops the item with a warning. Two or more calibrations are cross-checked against each other the same way. This costs nothing beyond the function the bases above already require, and it is the cheapest available guard against a model that multiplied wrong.

### Eligibility is a gate, not advice

`analysisStatus ∈ {not_floor_plan, unreadable}` yields no items. Any `calculationEligibility: 'review_required'` on a value the item depends on, or a relevant `readiness` flag that is not `eligible`, drops that item. Warnings quote V2's own `missingInputs.code` values (`scale_missing`, `floor_boundary_incomplete`, `ceiling_height_missing`, `height_scope_ambiguous`, `wall_length_missing`, `opening_width_missing`, `opening_height_missing`, `opening_wall_ambiguous`) rather than inventing strings.

## 📝 Data Model

No new entities and no migration. The quote is a Sales record and correlation travels in its free-form `metadata`.

**There is no idempotency record, so two invocations create two quotes.** An accepted hackathon shortcut, recorded in code as `// HACK(hackathon):`, not an oversight.

## 📝 API Contracts

### Input — optimised for the agent

One enum, and no number the model has to compute except a bare count:

```ts
{
  dealId: uuid,                    // untrusted; re-read in derived scope
  roomMeasurementsRunId: uuid,     // the V2 AgentRun this references; re-read in scope
  items: QuoteItem[]               // 1..100
}

type QuoteItem = {
  catalogProductId: uuid
  variantId?: uuid                 // from the list supplied in the agent's prompt
  note?: string                    // becomes the line description
} & (
  | { basis: 'floor_area';      roomIds: string[] }   // V2 rooms[].id
  | { basis: 'gross_wall_area'; roomIds: string[] }
  | { basis: 'net_wall_area';   roomIds: string[] }
  | { basis: 'count';           count: number }
  | { basis: 'given';           given: { value: number; unit: 'm2' | 'mb' | 'szt' | 'kpl' } }
)
```

**`basis` is the discriminant, and that costs the model nothing.** An earlier revision of this spec rejected a union — but that union was over *geometry*, and it forced the agent to choose a shape before it had chosen a meaning. This one is over *intent*: the discriminant is the single word the agent was already picking, so the decision surface is unchanged while validation becomes exact. `roomIds` is required where it is meaningful instead of being an optional that silently does nothing.

The shape is also the extension point. A future work type arrives as one more union member carrying its own fields, rather than as another `field?` bolted onto a flat object that most bases would ignore.

`roomIds` are V2 `rooms[].id` values. The agent's prompt lists each room as `id`, `printedName` and `location` so it can choose exactly, without name matching.

`basis: 'given'` is the escape hatch for a brief that states a quantity in prose with no floor plan behind it. It is the only place a number reaches the command from the model, and it carries its unit explicitly.

The schema is non-strict: unknown keys are stripped. There is no `currencyCode`, no price field, no `customerEntityId`, no `channelId` and no scope key — those are derived, never accepted.

`variantId` is optional; omitted, the command falls back to the product's `isDefault` variant, which the seed sets for all 45 services. A `variantId` belonging to a **different** product is always a rejection of that item, never a substitution.

### The unit gate

Each basis produces a unit, which must match the Catalog product's `defaultUnit`:

| Basis | Produces |
|---|---|
| `floor_area`, `gross_wall_area`, `net_wall_area` | `m2` |
| `count` | `szt` or `kpl` |
| `given` | whatever `given.unit` declares |

A mismatch drops the item. This is the core semantic check: `REN-CAR-01` (montaż drzwi, `szt`) mapped with `basis: 'floor_area'` cannot reach a quote.

### Door and window counts are derived, not supplied

`openings[].kind` is `door | window | opening | unknown`. Counts for door and window services — `REN-CAR-01`, `REN-CAR-02`, `REN-CAR-03` — are therefore computed from the V2 result over the referenced rooms, and a supplied `count` for those products is compared against the derived value rather than trusted. Sockets and lighting points do not appear on a plan view and remain agent-supplied.

Which products derive their count is the command's knowledge, not the agent's: the union carries a plain `count`, and the command decides whether to override it. Teaching the agent about opening kinds would hand it back a judgment it does not need to make.

### Reserved bases — named, not implemented

The five bases above leave a gap that is **present today, not hypothetical**: there is no linear basis, so the `mb` services in the seeded catalog — `REN-FIN-11` obróbki blacharskie, `REN-FIN-12` rynny, `REN-FIN-13` kątowniki na oknach i drzwiach, `REN-CAR-05` zabudowa meblowa — are reachable only through `given`, which is the one place a model-authored number enters the command. `REN-FIN-13` in particular is directly derivable as the perimeter of the referenced openings.

These names are reserved now so that the work adding them does not invent a parallel vocabulary. **None is implemented by this spec.**

| Reserved basis | Quantity | Extra field it would carry |
|---|---|---|
| `floor_perimeter` | perimeter of `floor.outerBoundary` | `excludeDoorways: boolean` — baseboard does not cross a doorway |
| `opening_perimeter` | `Σ openings ( 2·width + 2·height )` | `openingKind: 'door' \| 'window'` |
| `wall_run_length` | `Σ walls[].length` | none |
| `same_as` | the quantity already resolved for another item | `refItemIndex: number` |

`same_as` is the member that pays for the union on its own. Paired services — demontaż starej podłogi with `REN-FIN-07` panele, skucie płytek with `REN-FIN-05` układanie płytek — must quote **identical** quantities, and a reference makes that structural instead of hoping the model repeats itself. It is also the only member that relates two items rather than describing one, which no flat optional field expresses cleanly.

The resolver is therefore table-driven — `BASIS_SPECS: Record<Basis, { acceptedUnits, resolve }>` — so a reserved basis lands as one row plus one branch rather than as surgery on a growing switch.

A second axis (`subject` × `metric`) was considered and rejected for now: more elegant, but it doubles the agent's decision surface for no present benefit. Revisit only if the basis count passes roughly eight.

### Output

```ts
{ quoteId: string | null, lineCount: number, warnings: string[] }
```

`quoteId` is `null` when no item survives; nothing is created in that case.

### Downstream call

`sales.quotes.create` (`node_modules/@open-mercato/core/src/modules/sales/commands/documents.ts:4713`, schema `sales/data/validators.ts:741`) returns `{ quoteId }`. It requires `tenantId`, `organizationId` and `currencyCode`; `quoteNumber` is optional and self-generates through `salesDocumentNumberGenerator`, so this slice does not reserve one. Payload scope is verified against the runtime context by `ensureQuoteScope` (`documents.ts:4740`) — checked, never trusted.

Lines are emitted as `kind: 'service'` with `quantity`, `quantityUnit`, `unitPriceGross`, `taxRate`, `priceMode: 'gross'`, `name` from the product title, `description` from the item `note`, and a `catalogSnapshot`. Quote `metadata` carries `{ rfqDealId, roomMeasurementsRunId, source: 'rfq_intake' }`.

Gross pricing is not a choice: `catalog_seed` creates every row through `catalog.prices.create` with a gross amount. **The tax figure, however, is a rate and not an identity.** `catalog_product_variant_prices` has a numeric `tax_rate` column and **no `tax_rate_id`** — `catalog.prices.create` feeds its input `taxRateId` to `taxCalculationService.calculateUnitAmounts` and persists only the derived `taxRate` and `taxAmount`. A line therefore carries `taxRate`, which is the rate that actually produced `unitPriceGross`. A tax *identity* exists only on `catalog_product_variants.tax_rate_id` and `catalog_products.tax_rate_id`; it is resolved alongside the product and may be attached as `taxRateId` when Sales needs one, but it is a weaker claim than the rate and must never contradict it.

## 📝 Temporary Probe Agent

`rfq_intake.quote_probe` exists to exercise the five gates and the `executeProposal` path end to end **before the real mapping agent exists**. It is disposable and this spec says so in the agent's own description, so nobody mistakes it for product.

- It emits exactly one proposal option carrying one action of type `rfq.quote.create`, whose payload is the input contract above.
- It performs **no mapping and no measurement**: it forwards a payload it is handed. Keeping the model out of the loop is the point — a probe that also guesses would not tell you whether a failure came from the plumbing or from the guess.
- `allowedActions: ['rfq_intake.quote.create']` — the narrowest declaration that satisfies gate 3.
- `onResult.autoApproveThreshold` is set so runs auto-approve without a human. **This is a test-only setting**, stated here because the same field on a real agent is a safety boundary.
- It ships behind the same enterprise agent flags as the rest of `rfq_intake`, which default to off.

**Removal condition, recorded so it does not become permanent:** the probe is deleted in the slice that introduces the real mapping agent. Until then it carries `// HACK(hackathon):` naming that condition.

What the probe proves, in order: the command is in the vocabulary (gates 1–2), the agent's narrowing admits it (gate 3), the map resolves (gate 4), the vocabulary loads (gate 5), and the resulting quote appears in Sales with the expected lines.

## 📝 UI/UX

No new page and no new component. A successful run produces an ordinary **unsent** Sales quote, and unsent is the readiness signal: `sentAt` is null and no `acceptanceToken` exists until a human acts.

Operators edit lines, dates, customer and prices in the existing Sales quote detail. **Nothing guards that editing** — `sales.quotes.update`, `quotes.lines.upsert` and `quotes.lines.delete` carry no sent-state check, and the module has no editability helper at all, so a quote can be corrected freely before it goes out.

Approval is the existing **Send quote** action. Two things about it are worth stating precisely, because both constrain later work:

- It is an **HTTP route** (`sales/api/quotes/send`), **not a command**. There is no `sales.quotes.send` on the command bus, so nothing in a workflow or an agent proposal can invoke it. Approval stays a human action in the UI by construction, not by policy.
- It does more than approve: it generates an `acceptanceToken`, sets `sentAt`, flips `status` to `sent`, and **e-mails the customer**. There is no separate internal sign-off step.

Sales already owns the reverse transition. `sales.quotes.update` (`commands/documents.ts:5262`) detects a quote whose status is `sent`, and on any successful update clears `acceptanceToken` and `sentAt` and sets `status = 'draft'` — so correcting a price after sending revokes the customer's acceptance link rather than leaving it live against a stale amount.

**This spec does not set a status at creation.** It could: passing `statusEntryId` would render a visible `draft` label matching the value Sales itself writes. But the value resolves through the `sales.order_status` dictionary, nothing in this application creates that dictionary, and `sales.setup.seedDefaults` seeds only shipping and payment methods — it is created lazily, and only when an operator opens a settings page. Until a seed step exists, `statusEntryId` would resolve to null and the label would not appear. Unsent is therefore the readiness signal for now, and a visible status is a follow-up once the flow has been exercised end to end.

## 📝 Edge Cases & Failure Scenarios

Per-item failures drop the item with a bounded warning and let the rest proceed. Only scope, deal and run failures abort the command.

| Situation | Behavior |
|---|---|
| Missing tenant or organization in context | Fails closed; nothing written |
| `dealId` absent from derived scope | 404; no write |
| `roomMeasurementsRunId` absent from scope or not accepted | Command aborts; no quote |
| `analysisStatus` is `not_floor_plan` or `unreadable` | No items; no quote |
| Payload carries scope keys | Stripped before validation |
| `roomIds` names a room absent from the run | Item dropped with warning |
| `calibrations[]` empty and the value needed is not `printed` | Item dropped, warning `scale_missing` |
| Wall height unavailable | Item dropped, warning `ceiling_height_missing` |
| `printedArea.basis` is `unknown` | Falls back to the polygon; if that fails, item dropped |
| `scale_derived` value disagrees with our recomputation | Item dropped with warning |
| Two calibrations disagree beyond tolerance | Item dropped with warning |
| Any dependent value is `review_required` | Item dropped with its `missingInputs` code |
| Supplied `count` disagrees with derived door/window count | Derived value wins; warning records the difference |
| Product not found in scope | Item dropped with warning |
| `variantId` omitted | Falls back to the product's `isDefault` variant |
| `variantId` belongs to another product | Item dropped; never substituted |
| Basis unit ≠ product `defaultUnit` | Item dropped with warning |
| No price row for the variant in the resolved currency | Item dropped with warning |
| Resolved price row points at a different variant | Item dropped; never substituted |
| A line prices in a currency other than PLN | Item dropped with `currency_unsupported` |
| Zero items survive | `quoteId: null`, no quote created |
| Deal has no linked customer | Quote created without `customerEntityId` (optional in Sales) |
| Command invoked twice | Two quotes — see Data Model; accepted shortcut |

## 📝 Risks & Impact Review

**Blast radius.** Additive: one command ID, one workflow-safe registration, one bridge command, one temporary agent. No installed module is modified, no cross-module ORM relation is added, no shipped migration is touched.

**Dependency risk.** The command is unusable until PR #35 lands, since it reads the V2 result. The geometry reducer is a pure function over that contract and can be written and tested against fixtures before the merge.

**Contract surface.** A new command ID rather than a change to an existing one. Registering it as workflow-safe widens the agent action vocabulary by exactly one entry, and only for tenants that enable it.

**Rollback.** Remove the bridge step, the registration and the probe agent; the command becomes unreachable and no data migration is needed. Quotes already produced are ordinary Sales quotes.

**Principal risk — the two enablement gates.** Gates 1 and 2 fail silently as `skipped`. Mitigation: the bridge surfaces every non-`ok` result from `executeProposal` as a visible warning.

**Second risk — the probe outliving its purpose.** Mitigated by the stated removal condition and the auto-approve setting being labelled test-only.

**Deal link.** After the quote is created, the command calls `deal_links.document_links.create` with `{ dealId, documentId, documentKind: 'quote' }`, which is what makes the quote visible on the deal's detail page.

The call is deliberately **post-commit**. That command writes through its own EntityManager and flushes immediately, so it does not join a caller's transaction: invoking it before the Sales write would leave a link row behind if the quote then failed, and the module exposes no delete path. A failure to link is reported as `deal_link_failed` rather than thrown — losing the tab is recoverable, losing the quote is not.

## 📋 Phasing

**Phase 1** is the arithmetic and the command, testable against fixtures with no agent and no merge dependency. **Phase 2** is the invocation path and the probe, which needs PR #35.

## 📋 Implementation Plan

**Phase 1 — geometry and the command**

1. `src/modules/rfq_intake/lib/geometry.ts` — the pixel bridge, shoelace with holes, wall and opening sums, unit normalization, calibration cross-check, and `scale_derived` re-derivation. No I/O. Tests use V2-shaped fixtures: a printed area, a rectangular polygon, an L-shaped polygon with a hole, a room with no calibration, disagreeing calibrations, a `scale_derived` value that does not reproduce, and a missing ceiling height.
2. `src/modules/rfq_intake/lib/basisResolver.ts` — basis → quantity and unit over a set of rooms, including derived door and window counts.
3. `src/modules/rfq_intake/commands/quote-create.ts` — the input schema and handler, following `deal_links/commands/document-links.ts`. Tests cover a foreign deal, a foreign run, stripped scope keys, every row of the edge-case table that the command owns, and the happy path.
4. Register `rfq_intake.quote.create` through `registerWorkflowSafeCommands` with `requiredFeatures: ['customers.deals.manage', 'sales.quotes.manage']`.
5. `yarn generate && yarn typecheck && yarn lint`, then the focused tests.

**Phase 2 — the invocation path and the probe** *(needs PR #35)*

6. `src/modules/rfq_intake/commands/apply-proposal.ts` — loads the scoped disposed `AgentProposal`, reads `selectedOptionId`, calls `executeProposal` with `actionCommandMap`, and surfaces every non-`ok` result as a warning.
7. `rfq_intake.quote_probe` — the temporary agent, its `allowedActions`, its test-only auto-approve setting, and the `HACK(hackathon)` note naming its removal condition.
8. The workflow step that runs the bridge after the agent step.
9. End-to-end run proving all five gates, with the tenant enablement performed explicitly and recorded.

Each step leaves the application working: after step 3 the command exists and is callable from tests; step 4 only makes it reachable; the probe is additive and flag-gated.

**Out of scope, named so the next slice can pick them up:** the real mapping agent, the `deal_links` call, and any durable idempotency record.

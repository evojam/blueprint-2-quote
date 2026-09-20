# Room measurements agent for raster floor plans

**Date**: 2026-09-20
**Status**: Future ideas — not scheduled, and nobody implements it yet
**Design decisions**: Q1 to Q5 closed. Q6 and Q7 stay open with Marek. Q8 to Q11 stay open
on the trait extension.

> This document records a direction, and it does not start work. The hackathon shipped the
> current pipeline under time pressure, so this specification states what a considered
> version looks like. Read it before anyone extends the floor-plan reading path.

## TLDR

The quote pipeline reads a floor plan with one vision call on one full page image. A sheet
of A1 size arrives at the model as a thumbnail, so the model loses thin dimension lines and
small text. This specification defines `property_documents.room_measurements`. The agent
will find the plans, find the rooms, and then measure each room in a separate high
resolution crop. The agent will also compute an honest quality status from arithmetic.

## Problem Statement

### What happens today

The chain works like this. `property_documents.pdf_intake` renders every page to a PNG file
at a fixed 150 DPI (`ai-tools.ts:556-572`). `property_documents.room_dimensions` then sends
exactly one staged image to the model (`ai-tools.ts:316`). The model receives the complete
sheet in one call.

Three defects follow from this design.

**The model receives a fixed pixel budget for any sheet size.** The gateway scales a large
image down before the model sees it. A room that covers one sixth of an A1 sheet reaches the
model at about 128 pixels across. The scan quality does not change this number,
because the budget belongs to the gateway.

**The pipeline has no consumer.** `quote-create.ts:23` loads a run of the agent
`property_documents.room_measurements`. No such agent exists in this repository. The
directory `src/modules/property_documents/agents/` holds only `pdf_intake` and
`room_dimensions`. The result of `room_dimensions` carries only a `rooms` array, so it does
not satisfy the `RoomMeasurementsResult` contract.

**The quality status carries no meaning.** The field `analysisStatus` appears seven times in
`src/`. Two occurrences declare the type, four belong to tests, and one reads the value
(`basisResolver.ts:212`). That single read rejects `not_floor_plan` and `unreadable` only.
So a `partial` result produces a quote that looks identical to a `complete` one.

### Why this matters now

The operator sends a quote to a customer. A soft measurement looks exactly like a good one,
so nobody knows to ask the customer for a better file.

## Overview and Success Measures

- **Primary outcome:** each room reaches the model at the highest resolution that the source
  file and the model budget allow. The result also declares its own reliability.
- **Leading indicators:** the recorded pixel budget per room, and the count of dimension
  detections that no crop covers.
- **Baseline:** unknown. Phase 0 measures it. See the spike below.
- **Market reference:** commercial plan takeoff tools calibrate against a known length and
  then measure per room. This specification adopts the calibration model, which the
  `DrawingCalibration` type already carries. It rejects manual calibration by the operator
  for the first release.

## Proposed Solution

The agent replaces one coarse vision call with a funnel of five stages. Each stage narrows
the image area, so each later call spends its pixel budget on less of the drawing.

### Stage A — Page triage

1. Read the page count and the native image resolution of every page.
2. Classify every page with one low cost vision call on the existing 150 DPI render.
3. Record, for each page, whether it holds a floor plan, and where each plan sits.

A page that holds no plan leaves the funnel here. It costs one cheap call.

### Stage B — Plan region and budget

4. Compute the pixel budget for every plan region:
   `available_px = region_size_in_inches * native_ppi`, and `useful_px = min(available_px,
   model_limit)`.
5. Record `headroom = available_px / model_limit` for the region. This number drives the
   crop depth and the quality status later.

### Stage C — Scale

6. Read the printed scale token, for example `1:50`, into `drawing.declaredScale`. The
   contract states that this value is context only, so no arithmetic uses it.
7. Build `drawing.calibrations[]` from a scale bar or from a dimension anchor. A dimension
   anchor is a printed dimension whose two endpoints the model marks on the image.
8. `basisResolver.ts:98` already converts a calibration into metres per pixel, and it
   already rejects a disagreement between two calibrations.

### Stage D — Room location

9. Render each plan region to fill the model budget. Make one vision call per region.
10. Receive room boundaries in coordinates that the model normalises against the region.
11. Convert every coordinate back to the page image, because the contract stores
    `NormalisedPoint` against `drawing.imageWidthPx` and `drawing.imageHeightPx`.

### Stage E — Per room measurement

12. Compute a crop rectangle around each room. Add padding, because a dimension line sits
    outside the room it labels.
13. Compute the render resolution: `dpi = clamp(target_px / region_inches, 150,
    native_ppi)`. The native resolution is a hard ceiling for a raster source, because a
    higher value interpolates and adds no detail.
14. Re-render that rectangle with `pdftoppm -x -y -W -H -r <dpi>`. Poppler 24.02 supports
    these options. This step renders the region again from the page; it does not cut the
    150 DPI image.
15. Make one vision call per room. Receive the walls, the openings, the printed dimensions,
    and the printed area.
16. Map every returned coordinate back to page normalised space.

### Stage F — Coverage and the quality status

17. Detect text that looks like a dimension across the whole plan region. Detection is
    enough here. The check does not need a correct reading of the characters, because it
    only needs the position.
18. Check that every detection falls inside at least one crop rectangle. Report each
    uncovered detection as a warning.
19. Compute `analysisStatus` from arithmetic, never from a statement by the model:
    - `unreadable` — no page holds a plan, or no stage returns a usable region.
    - `not_floor_plan` — the triage classifies every page as something else.
    - `partial` — the agent measured the rooms, but at least one room fell below the
      headroom threshold, or at least one dimension detection stayed uncovered.
    - `complete` — every room met the threshold, and every detection landed in a crop.

### Why this approach

| Decision | Rationale | Alternative | Why rejected |
|---|---|---|---|
| Re-render a crop from the page | The render keeps the full source detail | Cut the 150 DPI PNG file | A cut of a raster adds no pixel; it only reframes |
| Compute the status from arithmetic | The number exists before the model answers | Ask the model for its confidence | A self report is the weakest available signal |
| Detect the dimension text, do not read it | Detection is much more reliable than recognition | Run full OCR on the sheet | OCR on a complete A1 sheet is poor |
| Keep `pdf_intake` unchanged | The agent is hardened and it works | Fold the rendering into the new agent | The change would widen a reviewed security surface |

## Architecture

```text
attachment (PDF)
  -> property_documents.pdf_intake            (exists, unchanged)
       -> pdf-page-####.png, brief.json
  -> property_documents.room_measurements     (NEW)
       -> Stage A..F, several bounded app tools
       -> research outcome = RoomMeasurementsResult
  -> rfq_intake.quote.create                  (exists, reads the run)
       -> basisResolver.resolveQuantity       (exists, unchanged)
```

The new agent owns no entity and writes no business record. Its result lives on the agent
run, and `loadRoomMeasurements` (`quote-create.ts:107`) reads it under trusted scope.

**The consumer contract does not change.** `RoomMeasurementsResult` already reserves every
field that the funnel produces: `drawing.imageWidthPx`, `drawing.calibrations`,
`rooms[].readiness`, `rooms[].missingInputs`, and `analysisStatus`. This specification
supplies a producer for a contract that the consumer already reads.

## The agentic workflow, and the patterns it uses

```text
  attachment (PDF)
        |
        v
  +-------------------------------+
  | pdf_intake          (exists)  |  ---------------- CHAIN, step 1
  | pdftoppm, 150 DPI, every page |
  +-------------------------------+
        |  pdf-page-####.png  +  brief.json
        v
 ===============================================================
 | room_measurements                        [ORCHESTRATOR]     |
 | one agent, bounded tools, no host path in any model output  |
 |=============================================================|
 |                                                             |
 |  STAGE A   classify every page            [ROUTER+FAN-OUT]  |
 |     page 1 --> plan?  yes --+                               |
 |     page 2 --> plan?  no  --+--> drop, one cheap call       |
 |     page N --> plan?  yes --+                               |
 |                             |                               |
 |  STAGE B   budget per region|             [DETERMINISTIC]   |
 |     headroom = available_px / model_limit   no model call   |
 |                             |                               |
 |  STAGE C   scale            |             [DETERMINISTIC    |
 |     declaredScale, calibrations[]          + one call]      |
 |                             |                               |
 |  STAGE D   locate the rooms |             [FAN-OUT: region] |
 |     one call for each plan region                           |
 |                             |                               |
 |                             v                               |
 |  STAGE E   measure one room               [FAN-OUT: room]   |
 |     +----------+----------+----------+    independent,      |
 |     |  room 1  |  room 2  |  room K  |    parallel          |
 |     +----+-----+-----+----+-----+----+    <-- the cost      |
 |          |           |          |             multiplies    |
 |          v           v          v              here         |
 |     +-------------------------------+                       |
 |     | G1..G8  arithmetic gates      |     [GUARDRAIL]       |
 |     +---------------+---------------+      no model, free   |
 |                     | only a marked room continues          |
 |                     v                                       |
 |     +-------------------------------+                       |
 |     | G9..G12 judge, separate call  |     [LLM-AS-JUDGE]    |
 |     +---------------+---------------+                       |
 |                     | fail AND headroom > 1                 |
 |                     v                                       |
 |     +-------------------------------+     [EVALUATOR-       |
 |     | recovery: re-crop / re-render |      OPTIMIZER LOOP]  |
 |     |           / split / escalate  |      bound: 2 tries   |
 |     +---------------+---------------+                       |
 |                     | back to STAGE E                       |
 |                     +-----------------+                     |
 |                                       v                     |
 |  STAGE F   aggregate and score            [FAN-IN / REDUCE] |
 |     rooms[] + warnings[] + analysisStatus                   |
 ===============================================================
        |  research outcome = RoomMeasurementsResult
        v
  +-------------------------------+
  | rfq_intake.quote.create       |  ---------------- CHAIN, last step
  +---------------+---------------+
                  | analysisStatus = partial
                  v
  +-------------------------------+
  | operator decides              |     [HUMAN IN THE LOOP]
  | request / skip / given        |
  +-------------------------------+
```

### The patterns, and why each one sits where it does

| Pattern | Where | Why here | Cost |
|---|---|---|---|
| Chain | `pdf_intake` to `room_measurements` to `quote.create` | Each step needs the output of the one before it | One pass |
| Orchestrator with tools | The agent against four bounded tools | The tool owns every path, command, and byte. The model owns no host path | None |
| Router | Stage A | A page that holds no plan must leave early | One cheap call for each page |
| Fan-out | Stage D for each region, Stage E for each room | Every room is independent, so the calls run in parallel | **The multiplier. Watch it here** |
| Guardrail | G1 to G8 | A formula beats a model, and it costs nothing | Free |
| LLM as judge | G9 to G12 | Sharpness, truncation, and prose need a view or a reader | Doubles the call count for a marked room |
| Evaluator and optimizer | The recovery loop | A failed gate names the action that can fix it | Up to two more tries for each room |
| Fan-in | Stage F | One result, one status, one list of warnings | Free |
| Human in the loop | The `partial` decision | Relevance belongs to the operator | One operator action |

### Patterns this design rejects, and the reason

| Pattern | Why not |
|---|---|
| Swarm, or a hand off between peer agents | No agent would own the whole sheet. The coverage gate needs one owner that sees every detection and every crop, so a swarm removes the strongest guard in the design |
| Self reflection | The judge runs as a separate call for this reason. A model that grades its own answer agrees with itself |
| Debate between several models | The cost multiplies for each room, and the arithmetic gates already give a stronger signal than a second opinion |
| A long conversation with memory | Every stage is stateless, and its input is a file plus a rectangle. Memory would add a failure mode and no accuracy |
| An agent that writes files | The tools write. The agent names a page and a rectangle. This keeps the reviewed security surface of `pdf_intake` |

**Read the fan-out row as the cost model of the whole design.** A sheet with ten rooms
costs ten measurement calls. A judge on a marked room adds one. A recovery try adds
another. The arithmetic gates are more reliable than the judge. They also keep the judge off every
room that does not need it.

## Phase 0 — the evaluation set, not a spike

An earlier draft of this specification made Phase 0 a three number spike. That was wrong.
A threshold that one sheet produces is a number that looked good once. The gate decides
whether a quote goes to a customer, so a corpus must set every threshold in it.

### The three measurements that stay

| Unknown | Command or test | Why the design depends on it |
|---|---|---|
| Native resolution of a real customer file | `pdfimages -list plan.pdf` | A 150 DPI scan of an A1 sheet gives a crop no headroom |
| The image limit of the configured gateway | Send one test sheet at two sizes and compare | Every budget in Stage B uses this number |
| The `detail` setting in the request | Read what `@ai-sdk/openai` sends | A low detail request sends one coarse pass |

The current default model is `gpt-5-mini` (`.env.example:529`). Compare it against a full
size model during this phase.

### The corpus

Build a labelled set of real customer files before any threshold enters the code.

**Stratify the set against the real distribution.** The customer sends what the customer
has. So the corpus must hold the same spread. Cover the scan resolution, the sheet size,
the number of plans on one page, and the page count. A threshold that a set of clean scans
produces will fail on the rest.

**Take the labels from the history.** The operator already measured these plans by hand for
past quotes. Those numbers are the ground truth, and they cost nothing to collect.

### The gate is a classifier, so measure it as one

`partial` against `complete` predicts one thing: will this measurement be wrong? Score that
prediction against the true error per room.

| Outcome | Meaning | What it costs |
|---|---|---|
| True positive | The agent marked `partial`, and the measurement was wrong | Correct behaviour |
| False negative | The agent marked `complete`, and the measurement was wrong | A bad quote reaches the customer |
| False positive | The agent marked `partial`, and the measurement was good | One unnecessary request to the customer |

**The two errors do not cost the same.** A false negative costs money and credibility. A
false positive costs one email. So tune every threshold for a high recall of real errors,
and accept a low precision.

### Rules that keep the numbers honest

1. **Fit the threshold on a training split. Report it on a held out split.** A threshold
   that the full corpus produces only memorises the corpus.
2. **Define the error tolerance first.** State the percentage error that makes a quote
   wrong. This number is a business rule, and it belongs to the owner. See Q6.
3. **Report the corpus size beside every threshold.** A threshold without its sample size
   is an opinion.
4. **Separate the two gate types.** The headroom threshold needs the corpus. The coverage
   check does not, because a detection either falls inside a rectangle or it does not. Only
   the sensitivity of the detector needs data.

### How large the corpus must be

The estimate below is reasoning, not a measurement. A binary gate needs enough real errors
to estimate its recall. Thirty documents at about eight rooms each give roughly 240 rooms.
An error rate near 20 percent then gives about 48 errors, which supports a rough recall with
a wide confidence interval. Treat thirty documents as the floor, not the target.

## Quality gates

### The rule: arithmetic first, the judge second

A judge model earns its place only where no formula exists. Where a formula exists, the
formula is faster, it costs nothing, and nobody can persuade it. So run every arithmetic
gate first. Run the judge only on a room that an arithmetic gate already marked.

This ordering also controls the cost. Each room already costs one vision call. A judge on
every room doubles that count, and a recovery loop triples it.

### Gates that need no model

Each gate states what it computes, what it catches, and how it raises a false alarm. A gate
without a known false alarm is a gate that nobody tested.

**G1 — Coverage.** Detect text that looks like a dimension across the plan region. Check
that every detection falls inside at least one crop rectangle.

- **Catches:** a printed dimension that the funnel never looked at.

- **Cost:** one detector pass for each region.

- **False alarm:** a room number or a door tag looks like a dimension, so it stays uncovered
and raises a warning for nothing.

- **Ceiling:** the recall of the detector is the ceiling of this gate. A dimension that the
detector misses makes the gate report a clean result. Measure that recall on the corpus.

**G2 — Headroom.** Compute `available_px / model_limit` for each room.

- **Catches:** a room that the source file cannot show in detail.

- **Cost:** none. The gate does one division.

- **False alarm:** none, but the gate inherits one risk. Every headroom depends on
`model_limit`, so a wrong limit makes every headroom wrong at the same time. Phase 0
measures it for this reason. The native resolution also varies between two images on one
page, so read it for each image.

**G3 — Area cross-check.** Multiply the polygon area by the square of the scale. Compare
the product against the printed area of the room.

- **Catches:** **a scale error of one order of magnitude**, a wrong calibration, and a polygon
that followed the wrong boundary.

- **Cost:** one multiplication.

- **False alarm:** **this gate needs one condition, or it fires constantly.** The contract
carries `AreaMeasurement.basis` with the values `gross`, `net`, and `unknown`. A gross
polygon against a net printed area differs by the wall thickness alone, which is a few
percent. So run this gate only when the contract states the basis, and only when the two
bases match. Skip it when the contract states `unknown`.

**G4 — Room sum.** Add the room areas. Compare the sum against a total area in the brief.

- **Catches:** a room that the funnel missed, and a room that it counted twice.

- **Cost:** none.

- **False alarm:** high. A brief states a usable area, a total area, or an area that includes a
balcony or a cellar that this plan does not show. So this gate raises a warning only, and
it never moves `analysisStatus` on its own.

**G5 — Polygon sanity.** Test each room boundary for self intersection. Test each pair of
rooms for overlap. Test every boundary against the region rectangle.

- **Catches:** a model that returned a rough box in place of a boundary.

- **Cost:** none.

- **False alarm:** two rooms share a wall, so two boundaries drawn on the wall centre line
touch each other legitimately. Give the overlap test a tolerance of the wall thickness.

**G6 — Range check.** Reject a room below 1 metre or above 30 metres. Reject a door above
3 metres.

- **Catches:** a digit that the model dropped or added. It also catches the common unit error,
where the model reads 2750 millimetres as 2750 centimetres and returns a room of 27 metres.

- **Cost:** none.

- **False alarm:** an open plan space or a warehouse trips the upper bound legitimately. So the
gate raises a warning, and it never blocks.

**G7 — Unit consistency.** An earlier draft of this specification called this gate "unit
mixing", and that version was wrong. A plan mixes units normally: it prints the room
dimensions in centimetres and the ceiling height in metres. That gate would fire on almost
every good plan.

The correct check is narrower. Take one quantity that the funnel read twice, for example a
wall that two rooms share, or a dimension that the brief also states. Convert both readings
to metres. Raise a warning when they disagree by a factor near ten, near one hundred, or
near one thousand.

- **Catches:** a unit that the model guessed.

- **False alarm:** low, because the gate looks for a power of ten and not for a small
difference.

**G8 — Shared wall. Deferred, and here is the reason.** The first draft proposed that a
wall between two rooms must carry one length in both rooms. The check is weaker than it
sounds. Two rooms rarely touch along a complete wall, so the pipeline must first decide how
much of the wall they share. That adjacency test is a second source of error, and it can
raise more false alarms than the gate removes. Hold this gate until the corpus shows that
an inconsistent shared wall is a real and frequent defect.

### Gates that need the judge

**G9 — Room count against the brief.** Ask the judge whether the room count matches the
list in the brief text. `pdf_intake` already produces that text in `brief.json`.

- **Why a model:** the brief is prose.

- **Action on a fail:** a warning only. **This gate never blocks.** A brief describes the work,
and a plan describes the building, so the two legitimately differ.

**G10 — Crop legibility.** Ask the judge whether the crop is sharp, and whether any text
touches an edge.

- **Why a model:** sharpness and truncation are visual.

- **Action on a fail:** re-crop with more padding when text touches an edge. Re-render at a
higher resolution when the crop looks blurred, but only while `headroom > 1`.

**G11 — Crop content.** Ask the judge whether the crop holds one room, two rooms, or a
legend.

- **Why a model:** the answer needs a view of the image.

- **Action on a fail:** split the crop, and measure each part. This gate has the clearest
recovery of the four, so run it first among the judge gates.

**G12 — Region type.** Ask the judge whether the region is a plan, a section, an elevation,
or a detail. Stage A already makes this call, so this gate confirms it at a higher
resolution.

- **Action on a fail:** drop the region, and record the reason.

### Three rules for the judge

1. **The judge runs in a separate call.** A model that grades its own answer is weak.
2. **The judge never edits a number.** It writes to `warnings`, and it moves
   `analysisStatus`. A measurement changes only when the pipeline measures again.
3. **State the known bias.** A judge model tends to agree, so treat a pass as weak evidence
   and a fail as strong evidence.

### The recovery loop

**The headroom number says, before any retry, whether a retry can help.** This is the whole
control. A room at `headroom <= 1` already holds every pixel the source has, so a second
render returns the same image. Do not spend the call.

| Trigger | Recovery action | Condition |
|---|---|---|
| A detection sits just outside the crop | Re-crop with more padding | Always. It costs one render |
| The judge reports a crop that looks blurred | Re-render at a higher resolution | Only while `headroom > 1` |
| The judge reports two rooms in one crop | Split the crop, and measure each part | Always |
| An arithmetic gate fails, and the crop is good | Repeat the call on a larger model | Once per room |
| Any trigger above, after the limit on tries | Stop. Mark the room, and continue | Always |

Bound the loop at two tries for each room. Record the count of tries and the final
trigger on the room, because a silent retry hides a weak source.

When the loop stops without a pass, and `headroom <= 1`, the source file is the cause. The
agent then marks `partial`, and it proposes the request below.

## The request for a better file

A `partial` status must produce an action, not a field that nobody reads. The request asks
the customer for a better PDF file.

### Reuse the inbox action, do not build a surface

`src/modules/rfq_intake/inbox-actions.ts` already holds the human in the loop primitive. An
`InboxActionDefinition` carries a `label`, a `payloadSchema`, and an `execute` function. The
operator reads the proposal, edits it, and confirms it. The action `create_quote` uses this
same path today.

Add one action of type `request_better_plan`. Do not add a page.

### The draft comes from a template, not from a model

The body of the message is a list of facts: the page numbers, the measured resolution, and
the room names. A template with slots cannot invent a resolution number. A model can. So
the agent supplies the slots, and the template builds the text.

### The payload must be specific

| Slot | Source | Why |
|---|---|---|
| Page numbers | Stage A triage | The customer must know which sheet to scan again |
| Measured resolution | `pdfimages -list` | A number makes the request actionable |
| Target resolution | The headroom formula | Tell the customer what is enough |
| Room names | Stage D | The customer sees which part of the plan failed |

A general request returns the same file. A request that names page 3 and its 150 DPI
returns a better page 3.

### Threading

The RFQ arrives by e-mail, and `lib/inboundAttachments.ts` stores `messageId`, `replyTo`,
and `inReplyTo`. The execute step replies inside the original thread, so the customer sees
one conversation.

### The agent never sends

The agent proposes. The operator confirms. No automatic message reaches a customer.

## Resolved decisions

Artur answered Q1 to Q4 on 2026-09-20. Marek owns Q6 and Q7, and both stay open.

| Id | Decision | Who |
|---|---|---|
| Q1 | A `partial` result gives the operator a decision. It never decides alone. | Artur |
| Q2 | The new agent supersedes `room_dimensions`. Its vision tool stays. | Artur |
| Q3 | Phase 1 derives a scale. | Artur |
| Q4 | Coverage ships in Phase 1, and it moves `analysisStatus`. | Artur |
| Q5 | The agent drafts the request. The operator sends it. | Artur |
| Q6 | What percentage error makes a quote wrong? | Marek, open |
| Q7 | Who collects the corpus, and from which quotes? | Marek, open |

### Q1 changed the design, so record why

The three options in the question were: drop the affected lines, mark the whole quote, or
block the quote. Artur rejected all three and named a fourth.

**Relevance belongs to the operator, not to the pipeline.** A room that the funnel cannot
measure frequently does not matter. Take the example from the decision. The job paints the
walls. The plan prints no dimension for a broom cupboard, and that cupboard sits outside
the scope of the work. The pipeline cannot know this. The operator knows it at a glance.

So a `partial` result states the facts, and it asks.

### Q3 and Q4 move work into Phase 1

Q3 puts the calibration in Phase 1, so **G3, the area cross-check, becomes mandatory in
Phase 1**. A scale multiplies every number in the quote, so the phase that introduces a
scale must also introduce the guard against a scale error.

Q4 lets an uncovered detection move `analysisStatus`. So Phase 1 must measure the recall of
the detector before it closes. This couples Phase 1 to the corpus.

**The Q1 answer is what makes the Q4 answer safe.** A false alarm from the coverage gate
produces a `partial`. A `partial` now costs one operator decision. The original
recommendation made the same false alarm drop a quote line.

## The partial decision point

A `partial` result opens a decision for the operator. The agent states three facts and
offers three actions.

### What the agent states

1. Which rooms fall below the threshold, by name and by location.
2. Why each one failed: a low headroom, an uncovered detection, or a failed gate.
3. Which pages hold those rooms, and the measured resolution of each page.

### What the operator may do

| Action | When the operator picks it | Mechanism |
|---|---|---|
| Request a better file | The plan matters, and the source is too weak | The `request_better_plan` inbox action |
| Continue without the room | The room sits outside the scope of the work | Exclude the room id from the quote items |
| Enter the dimension | The operator knows the number | The `given` basis, which already exists |

**The third action needs no new code.** `basisResolver.resolveQuantity` already handles
`basis: 'given'`, and its comment states the rule: "the operator measured it, we do not
second-guess it". A manual number is a first class input in this contract today.

## Extension — declarative traits and product driven extraction

**Status: proposed, and open. Q8 to Q11 below stay open.** This section records a direction
that reaches past the measurement funnel.

### The inversion

A quote does not always need an area. It needs whatever the priced work consumes. That can
be a count of windows, a count of sockets, a count of light points, a length of pipe, or an
area of wall. A fixed measurement schema cannot know which one the job needs.

**So the matched products must declare what the funnel extracts.**

```text
TODAY
  brief  -->  match_catalog  -->  products
  plan   -->  measure (fixed schema: floor, walls, openings)
                       |
                       +--> quote: basisResolver picks one of five bases

PROPOSED
  brief  -->  match_catalog  -->  products
                                     |
                                     v
                            required traits (union)
                                     |
                                     v
  plan   -->  measure ONLY those traits, one extractor for each
                                     |
                                     v
                            quote: each product applies its own rule
```

### What already exists, and what is missing

The repository is closer to this than it looks.

| Piece | State today | Evidence |
|---|---|---|
| Matching runs before measurement | **It already does.** `match_catalog` reads `brief.json` | `commands/analysis.ts` |
| A rule for turning geometry into a quantity | Exists, but as a closed list of five | `Basis` in `quoteContracts.ts:99` |
| A counted trait | Exists for two kinds only | `derivedFrom: 'door' | 'window'`, `RoomOpening.kind` |
| A unit guard | Exists | The `unit_mismatch` warning code |
| A product that states what it needs | **Missing.** `QuotableProduct` carries no parameter | `quoteContracts.ts:46` |
| An extractor for a trait other than geometry | **Missing** | Nothing counts a socket or a light point |

So `Basis` is the closed ancestor of this idea. The extension opens it.

### The three declarations

**1. A trait registry, and one owner for each trait.** One module declares every trait. A
trait states its id, its unit, how it appears on a plan, and the extractor that reads it.
Nothing else restates any of this.

| Field | Example |
|---|---|
| `id` | `window`, `door`, `socket`, `light_point`, `radiator`, `wet_riser` |
| `unit` | `szt`, `m`, `m2` |
| `appearance` | printed dimension, drawn symbol, hatched region, text label |
| `extractor` | the prompt, the schema, and the gates that read this trait |

**2. A product states the traits it needs.** The catalog product gains
`requiredTraits: TraitId[]`.

**3. A product states the rule that turns a trait into a quantity.** A count of sockets
needs one multiplication. A wall area uses the existing formula. The rule names its trait and its
unit, and the existing `unit_mismatch` code still guards the result.

### The extraction plan becomes computed, not fixed

Take the union of the required traits across every matched product. That union is the
extraction plan. A job that paints walls never counts a socket.

**This buys accuracy, not only cost.** A narrow question on a high resolution crop beats a
broad one. "Count the sockets in this room" is a better prompt than "read this room". So
the trait design and the crop design push in the same direction.

### Read the legend first

A dimension shows text, and text means the same thing on every drawing. **A symbol
does not.** The legend of that one drawing defines the socket symbol, the light point
symbol, and the radiator symbol. Two offices draw them differently.

So a symbol extractor runs in two steps. It reads the legend for the drawing, and then it
counts the shapes that match. An extractor that skips the legend is guessing.

### The coverage gate generalises, but it gets weaker

G1 today checks that every dimension detection falls inside a crop. The same idea extends
to a trait: every detected symbol must fall inside a crop.

**State the limit honestly. Detecting printed text is reliable. Detecting a drawn symbol is
not.** So the coverage guarantee is strong for a dimension and weak for a socket. Report the
two separately, and never present the second as the first.

### Compatibility

`Basis` is a public contract, and `basisResolver` reads it. Extend it, and do not replace
it. Keep the five existing values as built in rules, so no quote changes behaviour on the
day the registry arrives. A contract change here must read
`.ai/guides/upstream/BACKWARD_COMPATIBILITY.md` first.

### The guard against unbounded scope

An open registry invites a list of traits that nobody implemented. So apply the rule that the rest of this
document uses. **A trait ships with its extractor, its gates, and its corpus labels.**
A trait without those three is a promise, and not a capability.

### Open questions for this extension

**Q8 — Where does the trait registry live?** An app module in `property_documents`, or a
field on the catalog product in the installed `catalog` module? The second couples the
extraction to a module that this application does not own.

**Q9 — Who authors a trait: an engineer or an operator?** An engineer writes a prompt and a
schema. An operator knows the trades. A trait that an operator can add needs a safe
authoring surface, which is a much larger slice.

**Q10 — Does a rule need arithmetic beyond a count and an area?**
Take a pipe length that follows a route. Take a socket count for each square metre from a
standard. Each one adds a different extractor class.

**Q11 — What happens when a product needs a trait that the plan does not show?** The current
answer for geometry is `missingInputs` plus the operator decision. Confirm that the same
path serves a trait, or name a different one.

## Goals

- **REQ-001** — The agent returns a valid `RoomMeasurementsResult` for a raster PDF file.
- **REQ-002** — Each room reaches the model at the best resolution that the source file and
  the model limit allow.
- **REQ-003** — The agent computes `analysisStatus` from arithmetic, never from a statement
  by a model.
- **REQ-004** — The result names every room and page below the threshold, with the reason.
- **REQ-005** — A `partial` result gives the operator a decision with three actions.
- **REQ-006** — The agent derives a scale, and it cross-checks the scale against a printed
  area.
- **REQ-007** — The agent reports every dimension detection that no crop covers, and an
  uncovered detection moves `analysisStatus`.
- **REQ-008** — The agent reads only the staged file, under trusted tenant and organization
  scope, and it writes no business record.

## Non-goals

- Vector sources. A DXF or an IFC file removes most of this pipeline, and it needs its own
  specification.
- OCR that reads characters. This pipeline detects the position of text, and the vision
  model reads the value.
- Manual calibration by the operator inside a drawing viewer.
- Any automatic message to a customer.

## Tool contracts

The agent calls bounded application tools. The tools own every path, every command, and
every byte, exactly as `process_pdf` does today.

| Tool | Input | Output | Notes |
|---|---|---|---|
| `property_documents.inspect_pages` | none | page count, and the native resolution of each image | Wraps `pdfinfo` and `pdfimages -list` |
| `property_documents.render_region` | page, crop rectangle, resolution | one PNG file in the run workspace | Wraps `pdftoppm -f -l -x -y -W -H -r`. The tool clamps the resolution to the native ceiling |
| `property_documents.detect_dimension_text` | page or region | a list of positions | Feeds G1 only. It returns positions, not characters |
| `property_documents.analyze_region` | region reference, prompt role | a strict object per role | One tool, three roles: classify, locate rooms, measure one room |

**The agent never names a host path.** It names a page and a rectangle. The tool resolves
the workspace under the active run, the same stance that `requireActiveWorkspace` takes
today.

## Security and scope

- **Authorization:** the run needs `agent_orchestrator.agents.run`, which both current
  agents already require.
- **Tenant isolation:** the tools resolve the workspace from the active session token, and
  they never read a path from the model.
- **Prompt injection:** every word inside a plan is data. The profile denies write, edit,
  bash, task, and network tools. The current agents already state this rule, so copy it.
- **No business write:** the result lives on the agent run. `loadRoomMeasurements` reads it
  under trusted scope.

## Integration Coverage

| Test ID | Level | Setup | Actions | Assertions | Requirements |
|---|---|---|---|---|---|
| TEST-001 | contract | the generated descriptor | load the agent and the tools | stable ids, a research result, a strict schema, bash off | REQ-001, REQ-008 |
| TEST-002 | unit | a synthetic page of known size | compute the budget and the crop | the resolution clamps at the native ceiling | REQ-002 |
| TEST-003 | unit | a room with a printed area and a polygon | run G3 with matched and mismatched bases | the gate skips an `unknown` basis and fires on a factor of ten | REQ-006 |
| TEST-004 | unit | detections inside and outside the crops | run G1 | an uncovered detection moves the status to `partial` | REQ-007 |
| TEST-005 | unit | rooms above and below the threshold | compute the status | `complete` only when every room passes | REQ-003, REQ-004 |
| TEST-006 | security | a second tenant | run against a file of another tenant | the run fails closed, and it leaks no byte | REQ-008 |
| TEST-007 | integration | a real corpus file | run the agent | `quote-create` accepts the result | REQ-001 |
| TEST-008 | UI | a `partial` result | open the operator surface | the three actions appear, and each one works | REQ-005 |

## Implementation Plan

### Phase 0 — measurement and corpus

- **Depends on:** Q6 and Q7 for the labels. The three measurements do not wait.
- **Steps:**
  1. Run `pdfimages -list` across the available customer files. Record the spread.
  2. Measure the image limit of the configured gateway with one sheet at two sizes.
  3. Read what `@ai-sdk/openai` sends for `detail`. Fix it when it is not `high`.
  4. Compare `gpt-5-mini` against a full size model on one sheet.
  5. Collect the corpus, and label it once Marek answers Q6.
- **Exit gate:** the three numbers exist, and the corpus holds at least thirty files.

### Phase 1 — the funnel, end to end

- **Depends on:** Phase 0 steps 1 to 3.
- **Steps:**
  1. Add the four tools, and harden the generated profile.
  2. Add the agent, and register it as `property_documents.room_measurements`.
  3. Build Stage A and Stage B. Record the headroom for each region.
  4. Build Stage C, the calibration, and write `drawing.calibrations`.
  5. Build Stage D and Stage E, with the crop and the per room call.
  6. Build Stage F: G1 coverage, G2 headroom, G3 area cross-check, and the status.
  7. Retire the `room_dimensions` agent. Keep its vision tool.
- **Requirements closed:** REQ-001, REQ-002, REQ-003, REQ-004, REQ-006, REQ-007, REQ-008
- **Tests:** TEST-001 to TEST-007
- **Exit gate:** `quote-create` builds a quote from a real corpus file, and the status is
  correct on a file that the corpus labels as weak.

### Phase 2 — the operator decision

- **Depends on:** Phase 1 exit gate.
- **Steps:**
  1. Add the `request_better_plan` inbox action and its template.
  2. Show the weak rooms, and the reason, on the quote surface.
  3. Wire the three actions, including the `given` override.
- **Requirements closed:** REQ-005
- **Tests:** TEST-008
- **Exit gate:** an operator moves a `partial` result to a sent quote in three clicks.

### Phase 3 — the remaining gates and the recovery loop

- **Depends on:** Phase 2, and the corpus.
- **Steps:**
  1. Add G4 to G7.
  2. Add the judge, with G9 to G12.
  3. Add the recovery loop, bounded at two tries for each room.
  4. Fit every threshold on the training split. Report on the held out split.
- **Exit gate:** the recall of the gate against a real error meets the target that Q6 sets.

## Requirement Traceability

| Requirement | Contract | Phase | Tests |
|---|---|---|---|
| REQ-001 | `RoomMeasurementsResult` | Phase 1 | TEST-001, TEST-007 |
| REQ-002 | `render_region` clamp | Phase 1 | TEST-002 |
| REQ-003 | `analysisStatus` | Phase 1 | TEST-005 |
| REQ-004 | `rooms[].missingInputs` | Phase 1 | TEST-005 |
| REQ-005 | inbox action, `given` basis | Phase 2 | TEST-008 |
| REQ-006 | `drawing.calibrations`, G3 | Phase 1 | TEST-003 |
| REQ-007 | G1 | Phase 1 | TEST-004 |
| REQ-008 | run scope | Phase 1 | TEST-001, TEST-006 |

## Risks and Tradeoffs

| Risk | Impact | Mitigation | Residual |
|---|---|---|---|
| The gateway limit is smaller than the design assumes | Every budget is wrong | Phase 0 measures it before any code | The limit can change without notice |
| A scale error passes every gate | Every number in the quote is wrong by a factor | G3, plus the existing wall re-check in `basisResolver` | A plan with no printed area has no cross-check |
| The detector has a low recall | G1 reports clean, and a dimension is missing | Measure the recall on the corpus in Phase 0 | The gate can never be better than its detector |
| The judge agrees with a bad reading | A weak room passes | Treat a pass as weak evidence, and never let the judge edit a number | Cost rises with every judge call |
| The corpus does not match the real spread | Every threshold is fitted to the wrong distribution | Stratify the corpus, and report the sample size | The customer can change what they send |

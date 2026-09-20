---
title: "An agent cannot honour a server-side gate it cannot see"
modules: ["rfq_intake", "property_documents"]
areas: ["ai-workflow", "debugging"]
topics: ["agents", "tool-context", "validation-gates", "silent-empty-results"]
---

# An agent cannot honour a server-side gate it cannot see

**Context**: `rfq_intake.quote.create` refuses a line whose basis produced a unit other
than the product's Catalog `defaultUnit`, pushing `unit_mismatch:<index>`. The quote
drafter's only context was the catalog matcher's result, which carries id, title, score,
evidence and reason — never the unit. On demo instance
`09d1480a-e9b3-4f13-88b8-c2236d2fa53b` the drafter paired two products billed in m2 with
`basis: 'count'`, every line was dropped, and the run still reported
`executed: true` with `quoteId: null` and `lineCount: 0`. The upstream cause was the same
shape one step earlier: a readable floor plan finalized with `rooms: []`, so no area
basis was available at all, and that empty result was also accepted as `status: ok`.

**Problem**: A validation gate and the agent that must satisfy it are written in
different files, so the fact the gate reads — here a catalog column — is easy to leave
out of the agent's tool context. The agent then produces a proposal that parses, passes
guardrails, auto-approves, and yields nothing. Nothing in the run is red: the refusal is
one warning string inside an activity result nobody reads unless the quote is missing.

**Rule**: When a command refuses input on a fact the model does not author, hand that
fact to the agent from the server in the same tool result it draws its input from, and
say in the instructions which combinations the command will refuse. Never let the model
restate such a fact — read it in scope. Separately, a step whose result is structurally
empty (no rooms, no lines) must fail or be flagged, never be recorded as a success.

**Applies to**: `src/modules/rfq_intake/ai-tools.ts` (`catalogUnits`),
`src/modules/rfq_intake/lib/catalogUnits.ts`,
`src/modules/rfq_intake/commands/quote-create.ts` (the unit gate),
`src/modules/property_documents/room-measurements-contract.ts`
(`empty_floor_plan_rooms`).

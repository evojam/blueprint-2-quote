---
title: "A native agent's result schema is a provider contract, not just a validator"
modules: ["property_documents", "rfq_intake", "agent_orchestrator"]
areas: ["ai-workflow", "debugging"]
topics: ["structured-output", "agents", "zod", "litellm", "json-schema"]
---

# A native agent's result schema is a provider contract, not just a validator

**Context**: `rfq_intake.analysis` failed at `match_catalog` on 2026-09-20 with
`Invalid schema for response_format 'response': schema must be a JSON Schema of
'type: "object"', got 'type: "None"'`. `property_documents.catalog_matcher` declared
`result.schema` as `z.union([legacy, groupedV2])`, which compiles to a root `anyOf`
with no `type`. The same agent had failed ~2h earlier on the Anthropic route with
`input_schema does not support oneOf, allOf, or anyOf at the top level`. Nothing in
the app was wrong at the Zod level — the request was rejected before the model ran,
and the workflow instance showed only `1 activity(ies) failed`.

**Problem**: For a `runtime: 'native'` agent, `entry.schema` is compiled to JSON
Schema and sent as the structured-output contract (`response_format.json_schema` on
OpenAI, a tool `input_schema` on Anthropic). Schemas that parse perfectly well are
still rejected by the provider, and the rejection is invisible from the Zod side:

- a union at the ROOT (`anyOf` with no `type`) — refused by both providers;
- `.optional()` anywhere, or an object without `.strict()` — `@ai-sdk/openai` sends
  `strict: true`, which requires `additionalProperties: false` and every property in
  `required`.

The second rule is OpenAI-specific and applies to native agents only. OpenCode file
agents build their own tool schema and validate app-side, which is why
`property_documents.pdf_intake` runs green on the same models with optional outcome
fields — do not "fix" those.

**Rule**: A schema you hand a model is a generation contract; a schema you parse a
stored result with is a reader. Keep them separate. A native agent generates one
object schema — `.strict()`, nullable instead of optional — and a union stays on the
reader side only. Where a nullable field maps onto a command's discriminated union,
strip the nulls at the command boundary rather than loosening the union.

**Applies to**: `src/modules/*/ai-agents.ts` `result.schema`,
`src/modules/rfq_intake/commands/quote-create.ts`, and the guard that fails the build
on both rules: `src/lib/__tests__/agent-result-schema-provider-compat.test.ts`.

---
title: "Overriding an inbox action buys the execution schema, not the edit schema"
modules: ["inbox_ops", "rfq_intake", "sales"]
areas: ["umes", "module-data", "framework-context"]
topics: ["inbox-actions", "validation", "action-overrides", "two-sources-of-truth"]
---

# Overriding an inbox action buys the execution schema, not the edit schema

**Context**: `rfq_intake` registers a `create_quote` inbox action after `sales`, so the
registry keeps ours, and its `payloadSchema` relaxes `currencyCode`, `lineItems` and
`customerName` — an RFQ e-mail is a PDF and one sentence, with no prices to state.
Executing the action works. Editing it in the AI inbox fails, on
`@open-mercato/core@0.8.0`, with:

```
Invalid payload for create_quote: currencyCode: Invalid input: expected string,
received undefined; lineItems: Invalid input: expected array, received undefined
```

**Problem**: one action type has two validation sources, and overriding the action
replaces only one of them.

| Path | Schema | Site |
|---|---|---|
| Execute | `definition.payloadSchema` — the registered override | `lib/executionEngine.ts:397` |
| Edit (`PATCH .../actions/[actionId]`) | installed `orderPayloadSchema` | `data/validators.ts:285`, via `validateActionPayloadForType` |

`ACTION_PAYLOAD_SCHEMAS` is a module-private `const`, not exported, so no app module can
extend or replace it. Three seams that look like they would help do not:

- **API interceptor** — the route is hand-written, not `makeCrudRoute`, and runs no
  interceptor bridge.
- **Mutation guard** — runs *after* `validateActionPayloadForType`, and only permits or
  refuses; it cannot rewrite the payload.
- **Normalizer** — `definition.normalizePayload` runs in the execution engine only.

What is left is a route override via `src/modules.ts` `entry.overrides`, which means
forking ~120 lines of installed route logic (optimistic lock, mutation guards, events,
cache invalidation) and owning the drift.

**Rule**: when overriding an installed inbox action with a schema that differs from the
one it replaces, expect the edit route to keep validating with the installed schema, and
decide up front whether hand-editing that action is part of the flow. If it is, the
override is not enough. Do not reach for interceptors or guards to close the gap, and do
not stamp placeholder data into the payload to satisfy a schema the action does not
need — that writes fiction into the record. Report the divergence upstream: the edit
route should consult the registered definition's schema (it already lazy-imports the
registry in `executeByType`) and fall back to the map.

**Applies to**: `src/modules/rfq_intake/inbox-actions.ts`;
`@open-mercato/core/modules/inbox_ops/{lib/executionEngine.ts,data/validators.ts,api/proposals/[id]/actions/[actionId]/route.ts}`;
any app module registering an `InboxActionDefinition` for a type `sales` or `customers`
already owns.

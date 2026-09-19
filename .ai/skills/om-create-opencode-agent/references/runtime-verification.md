# Runtime Verification for Orchestrator Agents

An authored agent crosses several independently failing layers. Verify each layer after generation.

## Evidence Chain

1. **Authored source** — `AGENT.md`, `OUTCOME.md`, sample, skills, subagents, tools.
2. **Generated descriptor** — complete source metadata, result kind/schema, token usage, tools, skills, subagents, and file options.
3. **Runtime registry** — `getAgentEntry(id)` exposes the expected complete descriptor after `ensureAgentsLoaded()`.
4. **Generated OpenCode profile** — expected system prompt, outcome contract, tool allowlist, permission order, and exact readable paths.
5. **MCP registry** — `tools/list` contains the full orchestrator tool set and the agent's declared package tools with object-shaped input schemas.
6. **Live run** — stored run/result/artifacts and trace match the contract.

A pass at one layer does not imply the next layer works.

## Known Version-Skew Failure Modes

Treat these as checks, not permanent assumptions:

- A generator may parse `files`/`filesBash` but omit them from the generated descriptor. The runner then receives no staging/capture policy despite valid source frontmatter.
- Registering a minimal fallback entry before the generated loader can make it skip the complete descriptor, dropping source files, token usage, skills, and outcome schema.
- Importing a server-only registration bridge from `src/modules.ts` or client-reachable metadata can pull Node-only orchestration code into the browser build.
- OpenCode may flatten legacy tool and granular permission rules in order. A broad rule can override or precede the intended deny/allow sequence.
- Broad workspace read access may let the model bypass a server-side file-cardinality check.
- The HTTP MCP adapter may omit a tool whose top-level schema compiles to `oneOf` instead of `type: object`.
- The MCP process and OpenCode cache loaded bundles/profiles. Regeneration and a Next.js restart alone can leave an old prompt or tool active.

When the installed generator loses fields, prefer upgrading. If an app-owned compatibility bridge is unavoidable, register it only from a server-only `di.ts` hook, merge the complete generated descriptor before adding missing fields, and prove both server and client builds stay clean. Never patch generated files by hand.

## Focused Automated Checks

Keep tests only for contracts likely to regress:

- registry entry retains file staging/capture/bash options and source metadata;
- generated profile denies native writes/shell/undeclared skills and allows only the intended read roots;
- tool input JSON Schema is top-level `object`;
- invalid session tokens and realpath/symlink escapes fail closed;
- attachment cardinality/type/size limits run before extraction;
- semantic finalization aggregates every actionable invariant;
- only one corrected finalization retry is permitted;
- successful finalization publishes a complete artifact set atomically;
- failure publishes only the canonical error artifact;
- output capture contains server-authored deliverables, not temporary analysis files.

Do not test source text when behavior can be asserted through the generated profile, registry, tool handler, or filesystem result.

## Runtime Checks

Run commands supported by the installed package, typically:

```text
yarn generate
yarn mercado agent_orchestrator token-usage --dir <agents/folder> --json
yarn mercato ai_assistant mcp:list-tools
```

Then restart the MCP service and OpenCode. Run the sample and inspect:

- terminal run status and exact result kind;
- tool-call count/order and bounded retry behavior;
- schema validation and semantic validation;
- stored artifact names, MIME types, hashes, authorization, and byte contents;
- absence of partial/temp outputs;
- effective principal, tenant, organization, and feature gate;
- trace evidence that forbidden native tools were not invoked.

For durable use, invoke the agent through a workflow/process and verify retry/resume/idempotency there. Do not infer durable behavior from the synchronous Playground endpoint.

## Completion Gate

The agent is ready only if all six evidence layers agree after a cold process restart. If live execution cannot be performed, report it as unverified; generated files and unit tests are not a substitute for a real trace.

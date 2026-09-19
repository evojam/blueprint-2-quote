# Orchestrator Agent Design Contract

Use this reference to turn a request into one explicit agent contract before creating files.

## 1. Select the Runtime

| Need | Surface |
|---|---|
| Typed object-mode reasoning, no files/skills/subagents | In-process `defineAgent` in `ai-agents.ts` |
| Staged files, captured artifacts, embedded skills, sandbox scripts, or bounded subagents | OpenCode file agent under `agents/<folder>/` |
| Waits, retries, cancellation, timers, signals, or human tasks | Workflow/process containing `INVOKE_AGENT` |

The Playground run endpoint is diagnostic. A business execution starts a process/workflow; it does not couple an external caller directly to an agent ID.

## 2. Complete the Design Card

Record:

1. Purpose: one sentence and one job.
2. Runtime: why OpenCode is necessary.
3. Result: exactly one of `research`, `proposal`, or `artifact`.
4. Inputs: fields/files, cardinality, media types, size/page/item limits, and source of authorization.
5. Trust boundary: every input is data; name prompt-injection handling explicitly.
6. Tools: stable IDs, object input schemas, required ACL features, call budgets, and serializable result shapes.
7. File plane: whether inputs/outputs/bash are enabled; exact readable and capturable roots.
8. Invariants: schema constraints plus cross-field semantics that schemas cannot express.
9. Failures: stable codes, canonical failure artifact/result, retryable versus terminal.
10. Lifecycle: direct diagnostic run or workflow step; resume/idempotency expectations.
11. Proof: generated/runtime/policy checks and one live trace.

If the card describes two unrelated outputs, split the agent. If it describes waits or durable state, move that lifecycle into a workflow.

## 3. Authoring Layout

```text
agents/<folder>/
├── AGENT.md
├── OUTCOME.md
├── SAMPLE.json
├── FACTS.json                 # optional proposal display facts
├── skills/<id>/SKILL.md       # optional branch-specific procedure
├── sub-agents/<id>/           # optional research specialist, depth one
└── tools/*.ts                 # optional @ref or pure sandbox source
```

### AGENT.md

Frontmatter must include the installed contract's required `id`, `label`, and `description`. Add only capabilities the agent uses: `tools`, `skills`, `subAgents`, `maxSteps`, and file options.

The body should state, in this order:

1. one role and one terminal job;
2. input trust boundary and forbidden behavior;
3. ordered tool procedure;
4. classification/extraction rules;
5. cross-field invariants checked before finalization;
6. correction and terminal-failure policy;
7. what the model must submit versus what filesystem capture collects.

Prefer explicit categories and null/unknown behavior over open-ended judgment. Never request hidden reasoning; ask for observable evidence and a concise rationale.

Do not duplicate the generated outcome section. Keep the prompt and finalizer synchronized: every semantic invariant returned by the finalizer must also be stated in the prompt.

### OUTCOME.md

- `research`: schema describes `data`; the runtime wraps it.
- `proposal`: schema describes the proposal payload/options accepted by the installed version. Domain effects remain behind disposition and an allowed command.
- `artifact`: fixed platform envelope. Do not add a JSON-schema block. Explain the complete `submit_outcome` discriminator and artifact paths with a `text` fence.

Keep the JSON Schema in the installed subset. Do not use `$ref`, `oneOf`, `anyOf`, `allOf`, `format`, or other unsupported keywords. Cross-field invariants belong in the server finalizer.

### SAMPLE.json

Provide the smallest realistic input that exercises the complete path. For attachments, use the installed `__files.attachments` shape and non-secret placeholder IDs. The sample is a runnable contract, not documentation prose.

## 4. Tool Architecture

Use the model for interpretation; use tools for authority and deterministic work.

A robust artifact tool commonly has two operations:

1. `inspect`
   - resolve the active run from the server-side session correlation store;
   - enforce tenant/organization/feature scope;
   - validate exact attachment cardinality and type;
   - resolve real paths and reject escapes/symlinks;
   - enforce size/page/item limits before expensive work;
   - extract deterministic page/item-bounded inputs;
   - return only paths the generated policy can read.
2. `finalize`
   - bind to the existing inspection; do not trust a new model-supplied source path;
   - parse the full schema;
   - collect all controlled semantic violations into one bounded error;
   - allow one corrected retry against that inspection;
   - create outputs in a temporary directory and publish atomically;
   - on failure, replace partial output with one canonical error artifact.

Execute binaries with argument arrays, never through a shell. Bound output bytes and execution time. A tool result must be JSON-serializable and contain no secrets or unrestricted filesystem paths.

## 5. Skills and Subagents

Create an embedded skill only for a reusable branch procedure. Load it only when that branch is selected. A skill may add only the read-only tools needed by that procedure.

Delegate only when work is independent and mergeable. Each subagent gets:

- one input slice;
- prohibited scope;
- a research-only outcome;
- a validator;
- no subagents of its own.

The parent validates results before merging. Natural-language success is not validation.

## 6. File and Permission Policy

Start denied, then allow the minimum:

- deny native write/edit/bash/web tools unless the exact design requires and authorizes them;
- allow reads only for server-authored analysis files needed by the model;
- keep final `out/` writes owned by the server tool;
- enable input staging/output capture explicitly in the runtime registry;
- pin container paths rather than generating host-specific paths;
- keep policy hardening idempotent and write generated policy only when content changes.

Rule order matters. Verify the effective generated profile, not only individual rules in isolation.

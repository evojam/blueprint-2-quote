# Room Dimensions Image Agent

**Date**: 2026-09-18
**Status**: Ready for implementation

## TLDR

Add `property_documents.room_dimensions`, a read-only OpenCode file agent that accepts one authorized floor-plan image and returns a strict top-level array. Every array element represents one enclosed room and groups only the visible dimensions assigned to that room.

## Problem Statement

The existing property-document agents extract PDF text and floor-plan images, but no agent turns one plan image into room-grouped measurements. Downstream consumers currently have to inspect dimension chains manually and cannot distinguish measurements belonging to separate rooms.

## Overview and Success Measures

- **Primary outcome:** one authorized plan image yields a schema-valid array with one object per detected room and the visible dimensions grouped inside that object.
- **Leading indicators:** the agent is generated, its runtime descriptor enables the input workspace with bash disabled, and its OpenCode profile can read only the staged input workspace while denying every file write.
- **Baseline:** the branch has PDF intake and text-reader agents only.
- **Market / product reference:** OpenAI vision supports image analysis and visible-text reading; this slice adopts direct vision input plus a strict structured outcome and explicitly avoids inferred measurements: https://developers.openai.com/api/docs/guides/images-vision

## Goals

- **REQ-001** — Extract visible room dimensions from exactly one authorized image.
- **REQ-002** — Return a top-level array with one object per enclosed room and a nested dimension array for that room.
- **REQ-003** — Preserve visible labels, units, orientation, measurement kind, and confidence without calculating or inventing missing values.
- **REQ-004** — Keep attachment authorization, tenant/organization isolation, workspace containment, and cleanup on the existing Agent Orchestrator file plane.

## Non-goals

- Calculating area, perimeter, scale-derived measurements, or missing dimensions.
- Naming a room from fixtures when no room name is printed.
- Persisting measurements to a business entity or producing output files.
- Supporting PDFs, multiple images, image editing, or unrestricted OCR/shell/network tools.

## Proposed Solution

Create a file-defined research agent under `src/modules/property_documents/agents/room_dimensions/`. It receives one attachment through `input.__files.attachments` and calls one bounded, read-only app tool. The tool resolves the active scoped workspace server-side, accepts exactly one PNG/JPEG/WebP image, sends the image bytes to the configured vision gateway under a strict schema, and returns `{ rooms: [...] }`; the agent submits that array as `research.data`. The runtime registration uses `files.inputs: true`, `files.outputs: true`, and `bash: false` because Enterprise 0.8.0 creates an input workspace only when `outputs` is true; generated policy still denies writes, so no files are captured. The post-generation hardener also invalidates stale app-owned AI-tool and DI bundles.

### Design Decisions and Alternatives

| Decision | Rationale | Alternative considered | Why rejected / deferred |
|---|---|---|---|
| Top-level room array | Matches the requested consumer contract exactly | `{ rooms: [...] }` wrapper | Adds an unrequested envelope inside the existing `research.data` envelope |
| Bounded server-side vision tool | The OpenCode `read` tool acknowledges an image but does not expose its pixels to the configured model; the app tool keeps path, scope, bytes, schema, and model call server-owned | Direct staged-image read by OpenCode | Real artifact smoke returned an empty array because the model received no image content |
| Raw visible dimensions only | Prevents false precision and keeps provenance in `sourceText` | Derive length/width/area from scale | Inference was not requested and is unreliable on irregular rooms |
| Location plus nullable printed name | Separates unlabeled rooms without inventing semantic room types | Infer names from fixtures | Fixtures are ambiguous and would create fabricated domain data |

## Domain Vocabulary and Business Rules

| Term / invariant | Precise meaning or rule | Source of truth | Failure behavior |
|---|---|---|---|
| Room | One enclosed interior space visible on the plan; stairs/circulation count when enclosed | Image boundaries | Omit shapes that cannot be separated with reasonable confidence |
| Dimension | One visible numeric measurement label assigned to that room | Image annotation | Never calculate a missing value; preserve the raw label in `sourceText` |
| Room ID | `room-001`, `room-002`, … in top-left-to-bottom-right reading order | Agent output | IDs are run-local, not durable entity IDs |
| Name | Printed room name only | Image text | `null` when absent; never infer from fixtures |
| Unit | Unit printed on the label or unambiguously declared by the drawing | Image annotation/legend | `null` when not established |
| Orientation | `horizontal`, `vertical`, `height`, or `unknown` | Visible dimension line/label | Use `unknown` instead of guessing |
| Confidence | Number from 0 through 1 for room grouping or label reading | Model evidence | Low confidence remains explicit; unsupported data is omitted |

## Users, Permissions, and Scope

| Actor | Allowed outcomes | Scope rule | Required feature IDs |
|---|---|---|---|
| Authorized staff user or workflow principal | Run the agent and consume its research result | Selected tenant and exactly one organization | `agent_orchestrator.agents.run` |

Trusted scope comes from the authenticated run context. Input carries only the attachment UUID; the installed stager re-resolves it with both trusted scope keys and fails closed.

## Reuse and Ownership Map

| Capability | Reuse / extend / app-own | Existing module or new module | Integration seam | Why |
|---|---|---|---|---|
| Scoped image bytes | reuse | `attachments` | attachment object ID + storage driver | Canonical authorization and encrypted storage |
| Agent run and schema validation | reuse | `agent_orchestrator` | file-agent discovery and `research` outcome | Canonical trace, guardrails, lifecycle, and cleanup |
| Extraction prompt/schema and vision tool | app-own | `property_documents` | `agents/room_dimensions/*`, `ai-tools.ts`, `room-dimensions-vision.ts` | Application-specific grouping contract and bounded image analysis |
| Runtime file options/policy/bundle hardening | extend app-owned workaround | `property_documents` | `ai-agents.ts` + generation helper | Installed CLI 0.8.0 omits file options, Enterprise 0.8.0 gates input workspace creation on `outputs`, and generated app bundles otherwise retain stale transitive sources |

## Architecture and Data Flow

```text
Playground / INVOKE_AGENT
  -> scoped attachment UUID in input.__files.attachments
  -> Agent Orchestrator stages one image in the isolated run workspace/in
  -> bounded MCP tool reads exactly one staged image and invokes configured vision
  -> OpenCode submits tool.rooms; submit_outcome validates research.data as Room[]
  -> run persistence and workspace wipe
```

- **Module boundaries:** `attachments` owns bytes and authorization; Agent Orchestrator owns execution and cleanup; `property_documents` owns only the additive agent contract.
- **Extension points:** existing `agents/<id>/` discovery, module-root `ai-agents.ts`, and the branch's app-owned generated-profile hardener.
- **Alternatives considered:** a new API or persistent entity is unnecessary because this is advisory extraction only.
- **Compatibility:** new stable agent ID and outcome schema are additive; existing PDF agent IDs and policies remain unchanged.

## User Journeys

### Journey J-001 — Extract room dimensions

1. An authorized user selects `property_documents.room_dimensions` in the existing Playground.
2. The user supplies exactly one same-scope image attachment.
3. The bounded vision tool extracts visible room boundaries and dimension annotations into strict room records.
4. The run returns `kind: "research"` with `data` equal to the room array; inaccessible or missing attachments fail before model execution.

## UI and Interaction Contracts

N/A — no new or changed UI. The generated agent appears in the existing Agent Orchestrator Playground and agent-detail surfaces.

### UI architecture

N/A — existing installed surfaces are reused unchanged.

## Data Models

N/A — no entity, migration, or durable business write. The source remains an encrypted attachment; the output is advisory run data.

## API, Command, and Error Contracts

| Method / command | Path / ID | Auth and feature gate | Input | Success response / event | Errors and concurrency | Requirement IDs |
|---|---|---|---|---|---|---|
| Existing run route | `property_documents.room_dimensions` | auth + `agent_orchestrator.agents.run` + selected organization | business task plus exactly one `__files.attachments[].attachmentId` | `{ kind: "research", data: Room[] }` | installed 400/401/403/404/422/429/500/503; missing/wrong-scope attachment fails closed | REQ-001–REQ-004 |

`Room` is a strict object with required `id`, nullable printed `name`, `location`, `dimensions`, `confidence`, and `warnings`. Each strict dimension object requires numeric `value`, nullable `unit`, `orientation`, `kind`, raw `sourceText`, and `confidence`.

## Events, Jobs, Notifications, and Cross-Module Flows

N/A — no new event, job, notification, workflow definition, or mutation. Existing synchronous Playground and `INVOKE_AGENT` paths apply.

## Security, Privacy, and Compliance

- **Authorization / artifact-authorization:** only attachment object IDs are accepted; installed staging re-resolves the record under trusted tenant and organization scope. Cross-scope IDs fail closed.
- **Tenant isolation:** the model receives only a data URL built from the one image in the active scoped workspace; it receives no tenant, organization, storage, or host path from business input.
- **Sensitive data / encrypted-storage:** source bytes remain in the configured attachment storage contract and are sent only to the configured LiteLLM vision gateway. No output file or copied image is created.
- **Cleanup:** the installed run lease wipes the staged workspace after completion or failure. Source attachment retention remains owned by `attachments`.
- **Draft-only AI output:** measurements are advisory run data and do not mutate a property or other business record.
- **Prompt injection:** image text is evidence, never instructions. The generated profile denies write, edit, bash, task, skills, and network tools; only the bounded vision tool may call the configured provider.

## Integration Coverage

| Test ID | Level | Setup / fixture | Actions | Assertions | Requirement IDs |
|---|---|---|---|---|---|
| TEST-001 | contract | generated descriptor plus runtime registration | load the agent and tool | stable IDs, research result, input workspace enabled through the documented `outputs: true` workaround, bash off, one read-only vision tool, strict room-array schema | REQ-001–REQ-004 |
| TEST-002 | generation policy | temporary generated profiles and app sources | run the hardener | new image agent gets input-only read; existing PDF agents retain analysis-only read; write/edit/bash/task stay denied; stale AI-tool/DI bundles are invalidated | REQ-004 |
| TEST-003 | end-to-end smoke | attachment `83049dfa-020b-4097-8192-367027b4a317` | invoke the real agent | run `6948651e-ea18-4ad7-997a-bf4ab955ab0a` returns nine rooms with separate dimension arrays; `H = 275 cm` is preserved with `name: null` | REQ-001–REQ-003 |

## Implementation Phases

### Phase 1 — Complete read-only room extraction agent

- **Depends on:** none
- **Outcome:** the application discovers and can execute the new image agent end to end.
- **Why this order / value delivered:** definition, runtime registration, policy, and smoke evidence are one coupled executable contract.
- **Deliverables:** agent files, registration, focused tests, generated profile/manifest, artifact-backed smoke result.
- **Independent slices / estimated commits:** one cohesive slice; no parallel ownership needed.
- **Requirements closed:** REQ-001–REQ-004
- **Tests:** TEST-001–TEST-003
- **Validation:** focused Jest test, `yarn generate`, `yarn typecheck`, `yarn lint`, real run with the named attachment.
- **Exit gate:** the named attachment returns a schema-valid non-empty top-level room array and the generated profile has input-only read permissions.

## Requirement Traceability

| Requirement | Journey / surface | Data/API/event contracts | Phase | Tests | Acceptance criterion |
|---|---|---|---|---|---|
| REQ-001 | J-001, existing Playground | additive agent ID + scoped attachment envelope | Phase 1 | TEST-001, TEST-003 | AC-001 |
| REQ-002 | J-001 | strict `Room[]` research data | Phase 1 | TEST-001, TEST-003 | AC-001 |
| REQ-003 | J-001 | strict dimension object | Phase 1 | TEST-001, TEST-003 | AC-001, AC-002 |
| REQ-004 | J-001 | installed stager + generated read-only policy | Phase 1 | TEST-001, TEST-002 | AC-003 |

## Rollout, Migration, and Rollback

No migration. Roll out by generation and runtime restart. Roll back by removing the additive agent definition, its registration entry, its generated profile target, and its tests before the ID is consumed externally; existing PDF agents remain unaffected.

## Risks and Tradeoffs

| Risk / tradeoff | Impact | Mitigation / detection | Residual risk |
|---|---|---|---|
| Dense dimension chains can be assigned to the wrong room | Incorrect grouping | raw `sourceText`, location, and confidence; no calculated values | Manual review remains necessary |
| Unlabeled rooms | Consumers cannot use semantic names | run-local ordered ID and location; `name: null` | Location text is model-authored |
| Static workspace glob is broader than one session | Potential cross-run read if parallel leases are enabled | preserve current pool-size-one topology and workspace wipe | Must be redesigned before increasing pool size |
| Duplicate attachment names sanitize to one staged path in Enterprise 0.8 | Multiple submitted images can collapse before the app tool counts files | Playground/sample sends one attachment; app tool rejects every observable count other than one | Upstream stager needs `maxInputAttachments` or a staged manifest |
| Vision provider unavailable or local sidecar lacks inherited env | Run fails closed | configured LiteLLM adapter; development-only local `.env` fallback; explicit runtime error | No fallback OCR in this slice |

## Acceptance Criteria

- [x] **AC-001** — Running `property_documents.room_dimensions` with attachment `83049dfa-020b-4097-8192-367027b4a317` returns a non-empty top-level room array with a separate dimension array for every returned room.
- [x] **AC-002** — Output preserves visible numeric labels and units where established, uses `null` for absent names/units, and does not calculate missing measurements.
- [x] **AC-003** — Wrong-scope attachment access remains denied and the generated agent grants only workspace input read plus outcome submission; write/edit/bash/task/network remain unavailable.

## Final Compliance Report

| Check | Status | Evidence / resolution |
|---|---|---|
| Applicable `AGENTS.md` files and routed guides/skills reviewed | pass | root rules, Agent Orchestrator 0.8.0 rules, AI workflow/orchestrator/attachment references |
| Data models, APIs, events, UI, and tests are internally consistent | pass | no data/API/UI additions; traceability maps the additive agent contract |
| Every workflow completes end to end without a catch-all integration phase | pass | one complete bounded phase with an artifact-backed smoke oracle |
| Platform-native reuse and extension points were chosen before custom code | pass | existing attachment staging, file-agent discovery, runtime registration, and cleanup |
| UI contracts identify references, canonical components, and theme/state coverage | pass | N/A — no UI change; installed surfaces reused |
| Every phase has dependencies, bounded slices, tests, value, and an observable exit gate | pass | Phase 1 |

Verdict: Implemented and artifact-verified

## Open Questions

N/A — the request fixes the input modality, grouping rule, per-room record boundary, and top-level array output. The smallest non-invented schema keeps printed names and units nullable.

## Changelog

| Date | Change |
|---|---|
| 2026-09-18 | Initial ready specification for the additive image agent |
| 2026-09-19 | Implemented bounded vision tool and verified nine-room output with the requested attachment |

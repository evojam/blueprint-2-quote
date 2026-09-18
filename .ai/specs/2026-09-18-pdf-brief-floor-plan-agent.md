# PDF Brief and Floor-Plan Intake Agent

**Date**: 2026-09-18
**Status**: Implemented

## TLDR

Add an app-owned OpenCode file agent that accepts one tenant- and organization-scoped PDF attachment, separates text-brief pages from drawing pages, parses the brief into provenance-bearing JSON, and renders each detected floor-plan page as an individual PNG. The action returns a `kind: "artifact"` outcome listing `brief.json` and `floor-plans.json`; the bounded finalizer also produces ordered `floor-plan-page-####.png` files inside the action workspace.

The implementation reuses Agent Orchestrator file-plane staging, the existing attachments contract, OpenCode action outcomes, and per-run sandbox cleanup. An app-owned, read-only MCP tool invokes `pdfinfo`, `pdftotext`, and `pdftoppm` through fixed `execFile` calls with validated arguments and current-run paths, hashes the inspected input, validates the complete model-produced manifest payload, and is the only writer of final files; the model receives neither shell nor file-write capability. `poppler-utils` is installed in the app/MCP runtime image and verified as a supported hybrid-development host prerequisite. Durable/downloadable artifact storage is intentionally outside this scope; without a configured `storageService`, action output metadata survives but workspace bytes are removed during cleanup.

## Problem Statement

A single property-intake PDF may combine a textual project brief with plan-view architectural and technical drawings. Downstream processing needs the brief as structured, traceable data while floor-plan pages must remain available as ordered image files and carry machine-readable descriptions such as architectural/walls, electrical, plumbing, HVAC, lighting, reflected ceiling, fire safety, furniture, demolition, site, mixed, or unknown. Elevations, sections, details, schedules, covers, and legends are classified as `other`, summarized in the manifest, and do not produce PNG artifacts.

The current installation can stage attachment bytes for a file agent, but file-plane execution is disabled and neither the host MCP process nor the app/MCP container image has the required PDF utilities. Aggregate OCR text loses page boundaries and cannot reliably distinguish visually similar technical drawings.

## Overview and Success Measures

- **Primary outcome:** For an authorized PDF of at most 48 pages, one agent run produces a provenance-bearing parsed brief and one ordered PNG artifact for every page classified as a floor-plan drawing.
- **Leading indicators:** The agent is discoverable in Backend → Agents; Playground exposes its sample input; generated OpenCode permissions grant workspace `read` while denying `write`, `edit`, and `bash`; the app-owned MCP tool is the only Poppler and output-writing path.
- **Baseline:** The file plane is configured but disabled, no scoped PDF-processing MCP tool exists, and current app/MCP runtimes do not expose the required PDF utilities.
- **Market / product reference:** Docling preserves hierarchy, layout, and provenance in its document model (https://docling-project.github.io/docling/concepts/docling_document/). Unstructured exposes page-aware PDF partition strategies rather than treating the document as one undifferentiated string (https://docs.unstructured.io/open-source/core-functionality/partitioning). This feature adopts page provenance and explicit element classification, but rejects their larger runtime dependency sets in favor of the existing file plane plus a bounded Poppler MCP adapter.

## Goals

- **REQ-001** — An authorized user can run `property_documents.pdf_intake` with exactly one PDF attachment and receive a general parsed brief whose sections, requirements, facts, and unresolved items cite source page numbers.
- **REQ-002** — Every page visually classified as a floor plan is emitted as an individual PNG named with its original 1-based source-page number.
- **REQ-003** — `floor-plans.json` describes every emitted PNG with its source page, title, level when visible, primary type, disciplines, scale when visible, description, confidence, and evidence.
- **REQ-004** — Attachment access, sandbox paths, persisted artifacts, and cleanup remain tenant/org scoped and fail closed.
- **REQ-005** — Local hybrid, full-app development, and full-app production topologies expose the same scoped PDF-processing tool and shared workspace contract.

## Non-goals

- Editing, vectorizing, measuring, or validating the technical correctness of drawings.
- Creating or mutating property, project, quote, task, or workflow records.
- Supporting encrypted/password-protected PDFs, malformed PDFs, or documents above 48 pages in this phase.
- Adding a new upload UI, API route, database entity, migration, queue, or worker.
- Treating model-derived brief fields or drawing classifications as authoritative domain data.
- Supporting non-PDF inputs.

## Proposed Solution

1. Add an app-owned `property_documents` module containing the file agent `property_documents.pdf_intake` and the read-only MCP tool `property_documents.process_pdf`.
2. Enable the existing Agent Orchestrator file plane for this application and raise the artifact capture count to 50: two JSON artifacts plus at most 48 page PNGs.
3. Install `poppler-utils` in the main app/MCP Docker image. Hybrid host development declares and verifies the same OS prerequisite.
4. Stage only an attachment object ID through the reserved `input.__files.attachments` envelope. The installed stager validates the stored record under trusted tenant and organization scope before staging; the sample intentionally omits optional filename/OCR fields.
5. Generate the OpenCode agent with `files: true`, `filesBash: false`, and only `property_documents.process_pdf` plus core outcome tools. The model can read page previews inside the serialized, wiped workspace but cannot write/edit files or execute shell commands.
6. The MCP tool derives the current run from `McpToolContext.sessionId`, confirms the active agent ID, and never accepts a filesystem path from the model. It requires the server-issued token to match the installed generator's exact `^sess_[0-9a-f]{32}$` format and uses that token unchanged as the directory name; any other token is rejected rather than sanitized. It resolves `<OM_OPENCODE_WORKSPACE_ROOT>/<sessionToken>`, verifies realpath containment under the workspace root, requires existing `in/` and `out/` directories, and requires `agentRunSessionStore` to resolve the same active agent/run before every operation. It exposes:
   - `inspect`: find exactly one staged PDF in that run's `in/`, validate it with `pdfinfo`, reject encrypted/malformed/over-48-page inputs, create page-bounded text and 96-DPI preview PNGs under the run's sibling `analysis/` directory, and persist a server-owned filename/page-count/SHA-256 inspection marker;
   - `finalize`: require the unchanged inspected bytes, validate the complete brief/floor-plan schemas, require every nested brief provenance list to be a subset of `briefPages`, and validate the exact page partition. Semantic failures return one bounded message containing all actionable violations and replace partial outputs with normative `processing-error.json`; the agent may correct them and retry finalization once against the existing inspection. A valid finalization renders plan pages at 150 DPI, then atomically writes `brief.json`, `floor-plans.json`, and exact `floor-plan-page-####.png` outputs.
7. Classify every page as `brief`, `floor_plan`, or `other`. Only plan-view sheets are `floor_plan`; elevations, sections, details, schedules, covers, and legend-only sheets are `other`.
8. Return an `artifact` action outcome listing the server-authored JSON manifests. The finalizer writes both manifests and final PNGs under that run's `out/`; text files, the inspection marker, and 96-DPI previews remain under the sibling `analysis/` directory, cannot collide with a staged input filename, and are wiped with the workspace. A deployment may configure the installed artifact collector separately, but this feature does not require S3 or another durable file store.

### Design Decisions and Alternatives

| Decision | Rationale | Alternative considered | Why rejected / deferred |
|---|---|---|---|
| App-owned file agent | Uses installed orchestration, trace, guardrail, attachment, and artifact contracts | Standalone PDF API | Would duplicate auth, scoping, storage, and lifecycle behavior |
| Bounded Poppler MCP tool in app/MCP runtime | Fixed binaries/arguments, validated current-run paths, inspected-byte binding, schema/page-set validation, server-owned atomic outputs, and no model shell/write capability | `filesBash: true` or model-authored output files in OpenCode | Untrusted PDF prompt injection could use shell/write access to read configuration or persist arbitrary/invalid artifacts |
| Individual PNG artifacts | Matches the required downstream representation and preserves page independence | One PDF or archive | User explicitly selected unarchived per-page images |
| General brief JSON | Avoids guessing a future property schema while remaining machine-usable | Property-specific fixed schema | Domain fields and owning record are not yet specified |
| Source page in every record/filename | Stable provenance and debuggability | Re-number extracted subsets | Loses traceability to the submitted document |
| 48-page hard limit | Fits the approved 50-artifact cap with two manifests and bounds model/runtime cost | Unbounded PDFs | Risks resource exhaustion and silent artifact truncation |
| Artifact-only output | Preserves propose-only/no-direct-write policy | Agent writes business records | No approved target entity or mutation contract exists |

## Domain Vocabulary and Business Rules

| Term / invariant | Precise meaning or rule | Source of truth | Failure behavior |
|---|---|---|---|
| Input PDF | Exactly one staged attachment whose bytes are accepted by `pdfinfo`; extension or model assertion alone is insufficient | `attachments` record + staged bytes + Poppler | Reject before model analysis where possible |
| Source page | Original 1-based page number in the submitted PDF | Poppler page order | Never renumber extracted pages |
| Brief page | Page whose primary information is textual project requirements/context | Agent classification | Low confidence is recorded; page may still be `other` |
| Floor-plan page | Plan-view drawing communicating spatial layout or building systems | Visual page classification | Emit one PNG and one manifest entry |
| Other page | Cover, legend-only, schedule, elevation, section, detail, or unrelated content not itself a plan view | Agent classification | Add one `otherPages` entry; do not emit PNG |
| Primary type | One of `architectural`, `walls`, `electrical`, `plumbing`, `hvac`, `lighting`, `reflected_ceiling`, `fire_safety`, `furniture`, `demolition`, `site`, `mixed`, `unknown` | `floor-plans.json` | Use `unknown`, never invent a type |
| Disciplines | Unique subset of the primary-type vocabulary excluding `mixed`; may contain several systems | `floor-plans.json` | Empty when unsupported by visible evidence |
| Complete output | Two valid JSON manifests plus one PNG for every floor-plan page; no partial subset | Sandbox output before capture | If input or output limits are exceeded, emit only normative `processing-error.json` |

## Users, Permissions, and Scope

| Actor | Allowed outcomes | Scope rule | Required feature IDs |
|---|---|---|---|
| Authorized staff user | Run agent and view/download its run artifacts | Exactly one selected tenant organization | `agent_orchestrator.agents.run` |
| Workflow principal | Invoke the agent and consume artifact references | Workflow-bound tenant and organization | Workflow granted features including `agent_orchestrator.agents.run` |

Trusted `tenantId` and `organizationId` come from the authenticated session or workflow context. The input contains only an attachment UUID; the stager re-resolves it with both trusted scope keys. Missing, cross-tenant, cross-organization, or inaccessible attachments fail the run. There is no system-scope execution.

## Reuse and Ownership Map

| Capability | Reuse / extend / app-own | Existing module or new module | Integration seam | Why |
|---|---|---|---|---|
| Attachment storage and scoped reads | reuse | `attachments` | attachment object ID + storage driver | Canonical storage and authorization |
| Agent execution and typed artifact result | reuse | `agent_orchestrator` | file-agent discovery | Canonical run/trace/guardrail lifecycle |
| OpenCode execution | reuse | `ai_assistant` / OpenCode | installed runtime handler + MCP session auth | Avoid direct HTTP/runtime reimplementation |
| PDF intake instructions and artifact contract | app-own | `property_documents` | `agents/<id>/` discovery | Application-specific behavior |
| Bounded PDF processing | app-own | `property_documents` | discovered `ai-tools.ts` / MCP context | Prevent model shell access while preserving current-run file processing |
| Poppler binaries | app-owned image extension | main `Dockerfile` app/MCP image + documented host prerequisite | fixed `execFile` calls | Deterministic PDF inspection, text extraction, and rasterization |
| Artifact encryption/storage | reuse | `agent_orchestrator` artifact plane + configured storage | run artifact capture | Existing encrypted, scoped download contract |

## Architecture and Data Flow

```text
Playground / INVOKE_AGENT
  -> existing agent run/process surface
  -> trusted tenant + selected organization
  -> attachment UUID in input.__files
  -> Agent Orchestrator stages PDF in private workspace/in
  -> OpenCode agent calls scoped property_documents.process_pdf
       -> MCP validates active session/run/agent
       -> requires exact server token ^sess_[0-9a-f]{32}$ and uses it unchanged
       -> derives <workspaceRoot>/<sessionToken>
       -> realpath containment + existing in/out directory checks
       -> execFile(pdfinfo/pdftotext/pdftoppm), fixed arguments only
       -> page text + 96-DPI previews + SHA-256 inspection marker in workspace/analysis
  -> model reads previews/text, classifies pages, parses brief
  -> scoped tool validates the unchanged PDF and exact page partition
  -> scoped tool atomically writes validated manifests + selected 150-DPI PNGs
  -> artifact action outcome lists the validated manifests
  -> optional installed collector may persist workspace/out when storageService exists
  -> sandbox wipe + session-token revocation
```

- **Module boundaries:** `property_documents` owns the agent and its bounded ephemeral PDF tool. `attachments` remains source of truth for uploaded bytes; Agent Orchestrator owns runs/artifacts; OpenCode owns model execution.
- **Extension points:** app module metadata, discovered `ai-tools.ts`, and `agents/<id>/{AGENT.md,OUTCOME.md,SAMPLE.json}`; no installed source is edited.
- **Alternatives considered:** direct document-processing API and a new persistent document entity were rejected because no domain record/lifecycle was requested. Unrestricted OpenCode bash was rejected because PDF contents are untrusted.
- **Compatibility:** Additive module, stable additive agent/tool IDs, additive runtime package, and opt-in file-plane configuration. Existing agents and APIs remain unchanged.

### Runtime topology contract

| Topology | Files changed | Workspace visible to run owner / MCP / OpenCode | Required environment | Poppler location |
|---|---|---|---|---|
| Hybrid host app + container OpenCode | `.env`, `docker-compose.yml` | host `./.mercato/opencode-work` / same host path / container `/home/opencode/work` via bind mount | app+MCP: `OM_OPENCODE_FILES_ENABLED=true`, `OM_OPENCODE_WORKSPACE_ROOT=./.mercato/opencode-work`, `OM_OPENCODE_WORKSPACE_ROOT_CONTAINER=/home/opencode/work`, `OM_AGENT_ARTIFACT_MAX_COUNT=50`; OpenCode: file flag true | host OS prerequisite |
| Full-app development | `docker-compose.fullapp.dev.yml`, main `Dockerfile` | named `opencode_work` mounted at `/home/opencode/work` in `app`, `mcp`, and `opencode` | all three: file flag true and both workspace roots `/home/opencode/work`; app: artifact count 50 | app/MCP image |
| Full-app production | `docker-compose.fullapp.yml`, main `Dockerfile` | named `opencode_work` mounted at `/home/opencode/work` in `app`, `mcp`, and `opencode` | all three: file flag true and both workspace roots `/home/opencode/work`; app: artifact count 50 | app/MCP image |

The OpenCode image does not need Poppler because the model has no bash capability. The MCP process owns all binary execution; all three processes share only the per-run workspace bytes required by their role.

## User Journeys

### Journey J-001 — Analyze one mixed PDF

1. Staff uploads a PDF through the existing attachment flow and selects one organization.
2. Staff opens Backend → Playground, selects `property_documents.pdf_intake`, and supplies the attachment UUID through `input.__files`.
3. The agent validates/stages the PDF, invokes the bounded PDF tool, classifies its pages, parses brief content, and requests rendering only for floor-plan pages.
4. The completed action returns an artifact outcome naming both JSON manifests; the finalizer has produced the ordered PNG files for that action. Without optional durable storage, the file bytes are intentionally removed with the sandbox after completion.
5. If the attachment is inaccessible, not a PDF, malformed, password-protected, or above 48 pages, the run fails closed or emits a single structured processing error without partial success artifacts.

### Journey J-002 — Invoke from a durable workflow

1. A workflow `INVOKE_AGENT` step receives an authorized attachment UUID.
2. The same file-agent contract runs under the workflow principal and organization scope.
3. The workflow receives the artifact action outcome and decides whether/how later steps consume its metadata; the agent itself performs no domain mutation.

## UI and Interaction Contracts

No new or changed UI route. The existing surfaces are reused unchanged:

| Surface / route | Purpose and primary actions | Data source / mutations | Closest installed reference | Canonical shell / components | Required states | Requirement IDs |
|---|---|---|---|---|---|---|
| `/backend/playground` | Select agent, insert sample, submit scoped attachment input, inspect result/artifacts | Existing Agent Orchestrator APIs | `agent_orchestrator/backend/playground/page.tsx` | Existing installed page | Existing loading/error/permission/run states | REQ-001–REQ-004 |
| `/backend/agents/property_documents.pdf_intake` | Inspect generated prompt, files, runtime and token budget | Existing Agent Orchestrator APIs | `agent_orchestrator/backend/agents/[id]/page.tsx` | Existing installed page | Existing loading/not-found/forbidden states | REQ-005 |

### UI architecture

N/A — no navigation, component, widget, localization, or interaction contract changes. The agent appears through existing generated registry behavior.

## Data Models

N/A — no new entity or migration. Inputs reuse `attachments`; outputs reuse `AgentRunArtifact`. `brief.json` and `floor-plans.json` are encrypted artifact bytes, not database JSON columns.

### `brief.json` — normative schema

Every listed field is required. Unknown scalar values use `null`; collections are present as empty arrays. Additional properties are prohibited.

| Field | Contract |
|---|---|
| `schemaVersion` | integer constant `1` |
| `source` | object `{ fileName, pageCount, briefPages }`; `fileName` 1–255 chars; `pageCount` integer 1–48; `briefPages` sorted unique integers within the document |
| `language` | non-empty string ≤32 chars, using `undetermined` when unknown |
| `title` | string ≤500 chars or `null` |
| `summary` | string ≤5,000 chars |
| `sections` | array ≤100 of required `{ heading: string|null, text: string, sourcePages: number[] }`; heading ≤500, text 1–20,000, source pages sorted/unique/in range |
| `requirements` | array ≤200 of required `{ category: string, text: string, sourcePages: number[] }`; category ≤200, text 1–4,000 |
| `keyFacts` | array ≤200 of required `{ label: string, value: string, sourcePages: number[] }`; label ≤200, value 1–2,000 |
| `unresolvedItems` | array ≤100 of required `{ text: string, sourcePages: number[] }`; text 1–2,000 |
| `warnings` | array ≤100 of strings 1–1,000 chars |
| `confidence` | finite number from 0 through 1 |

### `floor-plans.json` — normative schema

Every listed field is required. Additional properties are prohibited. Arrays are sorted by `sourcePage`.

| Field | Contract |
|---|---|
| `schemaVersion` | integer constant `1` |
| `source` | object `{ fileName, pageCount }` with the same bounds as `brief.json` |
| `plans` | array ≤48; source pages are unique and each has exactly one captured PNG |
| `plans[].sourcePage` | integer 1–`pageCount` |
| `plans[].artifactPath` | exact `floor-plan-page-####.png`, where digits equal zero-padded `sourcePage` |
| `plans[].title` / `level` / `scale` | string ≤500/200/100 chars or `null`; never inferred without visible evidence |
| `plans[].primaryType` | enum `architectural|walls|electrical|plumbing|hvac|lighting|reflected_ceiling|fire_safety|furniture|demolition|site|mixed|unknown` |
| `plans[].disciplines` | unique array of the same enum excluding `mixed`, maximum 12 |
| `plans[].description` | non-empty string ≤2,000 chars |
| `plans[].confidence` | finite number from 0 through 1 |
| `plans[].evidence` | array ≤20 of non-empty strings ≤500 chars describing visible evidence, never hidden reasoning |
| `otherPages` | array ≤48 of required `{ sourcePage, reason }`; pages unique; reason enum `cover|legend|schedule|elevation|section|detail|unrelated|unknown` |
| `warnings` | array ≤100 of strings 1–1,000 chars |

`plans` and `otherPages` are disjoint. Together with `source.briefPages`, their page-number union equals every source page exactly once. The number and paths of captured PNG artifacts exactly match `plans`.
Every `sections[].sourcePages`, `requirements[].sourcePages`, `keyFacts[].sourcePages`, and `unresolvedItems[].sourcePages` value is a subset of `source.briefPages`. Facts visible only on a plan page belong in that plan's description/evidence, not in the brief.

### `processing-error.json` — normative schema

This is the only output when a same-scope staged file cannot be processed safely. Every field is required; additional properties are prohibited.

```json
{
  "schemaVersion": 1,
  "status": "rejected",
  "code": "page_limit_exceeded",
  "message": "PDF has 49 pages; maximum is 48.",
  "source": { "fileName": "input.pdf", "pageCount": 49 },
  "limits": { "maxPages": 48, "maxArtifacts": 50 }
}
```

`code` is one of `invalid_attachment_count`, `not_pdf`, `encrypted_pdf`, `malformed_pdf`, `page_limit_exceeded`, `pdf_runtime_unavailable`, `pdf_processing_failed`, `artifact_limit_exceeded`. `message` is 1–500 chars and contains no raw document content. `source.fileName` is 1–255 chars or `null`; `source.pageCount` is a positive integer or `null`. No brief, floor-plan manifest, or PNG may coexist with this artifact.

## API, Command, and Error Contracts

No new HTTP API or command. The new app-owned MCP tool is an additive stable tool contract:

| Method / command | Path / ID | Auth and feature gate | Input | Success response / event | Errors and concurrency | Requirement IDs |
|---|---|---|---|---|---|---|
| `POST` | `/api/agent_orchestrator/agents/property_documents.pdf_intake/run` | Auth + `agent_orchestrator.agents.run` + one selected organization | `{ input: { task?, __files: { attachments: [{ attachmentId }] } } }` | Existing artifact AgentResult + `runId` | Existing 400/401/403/404/422/429/500/503 | REQ-001–REQ-004 |
| MCP tool | `property_documents.process_pdf` | active per-run session + active agent ID `property_documents.pdf_intake` + `agent_orchestrator.agents.run` | discriminated union `{ operation: "inspect" }` | `{ operation, fileName, pageCount, pages: [{ sourcePage, textPath, previewPath }] }` | canonical failure code and server-authored `processing-error.json`; one inspect per run | REQ-001, REQ-004, REQ-005 |
| MCP tool | `property_documents.process_pdf` | same | `{ operation: "finalize", brief, floorPlans }` with bounded strict schemas | validated manifests plus `{ operation, artifacts, manifests }` | aggregates actionable source/provenance/page-partition violations into the existing bounded `pdf_processing_failed` response; permits one corrected retry against the existing inspection; rejects changed/uninspected input, partial render, unavailable Poppler, or artifact overflow; every failure replaces partial output with one error artifact | REQ-002–REQ-005 |
| Workflow activity | `INVOKE_AGENT` | Workflow principal + granted feature | Same business input and reserved file envelope | Existing artifact result | Existing workflow retry/timeout/cancel behavior | REQ-001–REQ-004 |

The MCP tool is `isMutation: false`: it changes only the active run's ephemeral workspace and cannot persist domain state. It never accepts a path, command, DPI, output name, tenant ID, organization ID, or session token from model input. For every call it resolves `ctx.sessionId` through `agentRunSessionStore`, confirms the active run and exact agent ID, requires the installed generator's exact `^sess_[0-9a-f]{32}$` token format, uses the token unchanged as the directory name, verifies realpath containment beneath `OM_OPENCODE_WORKSPACE_ROOT`, and requires already-created `<sessionToken>/{in,out}` directories. It uses `execFile` without a shell, enforces time/output bounds, and returns serializable metadata only.

The stable agent/tool IDs are additive. Existing request routes, session-token format, attachment envelope, and artifact response shape are unchanged.

Processing errors:

- wrong-scope or missing attachments fail in the installed stager before inference; zero/multiple same-scope staged inputs are rejected by the first bounded tool call with only normative `processing-error.json`;
- non-PDF bytes, malformed/password-protected PDF, page count above 48, unavailable/failed Poppler, changed inspected bytes, invalid manifest data, or projected artifact overflow create only normative `processing-error.json` when the sandbox is writable; semantic manifest errors use a bounded actionable message so the agent can correct all reported invariants and retry once;
- model-authored arbitrary files are impossible because generated `write` and `edit` tools are denied; the finalizer validates and writes the only accepted output set;
- artifact storage unavailable remains fail-closed: no dangling artifact row is recorded.

## Events, Jobs, Notifications, and Cross-Module Flows

No new worker, queue, event, notification, or scheduler contract. Direct Playground execution is synchronous. Durable workflow execution continues through the installed workflow and worker contracts.

## Security, Privacy, and Compliance

- **Authorization / artifact-authorization:** Only attachment object IDs are accepted. Staging re-resolves each attachment under trusted tenant and organization scope. The PDF tool additionally requires an active run session for exactly `property_documents.pdf_intake`. If a deployment later enables durable run artifacts, downloads reuse the installed run-artifact authorization path.
- **Tenant isolation:** No tenant/org/session identifier or filesystem path is trusted from tool input. Wrong-scope or missing attachments fail closed before inference.
- **Sensitive data / optional encrypted storage:** Source bytes remain in attachment storage. The action result contains only bounded artifact metadata. When a deployment separately enables AgentRunArtifact storage, the installed collector/encryption/download authorization contracts apply; this feature neither requires nor configures S3.
- **Prompt injection:** PDF text and drawings are untrusted evidence, never instructions. The agent has no bash, network, file write/edit, domain mutation, or sub-agent capability. Generated `read` permission is workspace-root scoped only because the installed OpenCode policy is static; the supported topology pins `OM_OPENCODE_POOL_SIZE=1`, and the installed lease manager wipes the sole run directory before reuse.
- **Binary boundary:** Only the MCP process invokes `/usr/bin/pdfinfo`, `/usr/bin/pdftotext`, and `/usr/bin/pdftoppm`, using `execFile` with fixed options and the active server-derived session directory. No shell expansion, user command, user path/session, arbitrary DPI, or output filename is accepted.
- **Output boundary:** The finalizer writes only under `out/`. Inspection text and 96-DPI previews live under the sibling `analysis/` directory, are never included in the action outcome, cannot collide with staged input names, and are removed on release. The optional installed collector also scans only `out/`.
- **Cleanup:** The complete per-run workspace is wiped in `finally` before the lease is reused; the session token is revoked. Source attachment retention remains owned by `attachments`; this feature intentionally retains only action-level artifact metadata.
- **Draft-only AI output:** Parsed brief and drawing labels are advisory artifacts. No business entity is updated and later persistence requires a separately approved workflow/command.
- **Resource bounds:** Maximum 48 pages, 96-DPI previews, 150-DPI final PNGs, 50 output files, subprocess timeout/output cap, at most three PDF-tool calls per turn (inspect, finalize, one corrected finalize), one shared workspace lease by default, and existing run timeout/admission control.

## Integration Coverage

| Test ID | Level | Setup / fixture | Actions | Assertions | Requirement IDs |
|---|---|---|---|---|---|
| TEST-001 | generation | Enabled `property_documents` module with valid agent/tool files | Run `yarn generate` | Generated manifest has stable IDs and artifact/file settings; generated OpenCode agent allows workspace read only, denies write/edit/bash, uses the fixed container root, and permits only the PDF/core outcome MCP tools | REQ-001, REQ-005 |
| TEST-002 | tool integration | Temporary current-run workspace containing a deterministic mixed PDF; mocked active-session store | Call `inspect`, then `finalize` | Page-bounded text/previews and inspection hash are created; strict manifests/page partition are validated; exact selected final PNGs are atomically created; wrong agent/session, changed or uninspected input, malformed/encrypted/49-page inputs fail closed | REQ-001–REQ-005 |
| TEST-003 | end-to-end smoke | Same-scope synthetic PDF containing one textual brief page plus visually distinct electrical/plumbing plan pages; configured model | Upload, invoke through the authenticated run API, inspect the trace and finalization response | Normative brief/manifest finalization; exactly one correctly numbered PNG per floor-plan page; types/evidence/provenance present; no PNG for the brief page; artifact action outcome lists both manifests | REQ-001–REQ-003 |
| TEST-004 | security | Attachment owned by another tenant/org | Invoke agent with its UUID | Run fails before tool/model; no workspace output/artifact row/data leak | REQ-004 |
| TEST-005 | boundary | 49-page PDF | Invoke agent | Only normative `processing-error.json`; no partial success manifests or PNG artifacts | REQ-004 |
| TEST-006 | cleanup | Successful and injected-failure runs | Inspect workspace after completion | Per-run directory no longer exists in all mounted views | REQ-004 |
| TEST-007 | regression | Inspected PDF plus a manifest that cites a plan page from a brief record and classifies one page twice | Finalize once, correct every reported invariant, then finalize again without re-inspection | First response reports both provenance and partition violations and leaves only `processing-error.json`; corrected retry succeeds and renders only validated plan pages | REQ-001–REQ-003 |

## Implementation Phases

### Phase 1 — Runtime and agent contract

- **Depends on:** none
- **Outcome:** The application discovers a file-enabled PDF intake agent and bounded MCP tool; every supported runtime topology provides one shared workspace and Poppler-capable MCP process.
- **Why this order / value delivered:** Agent/tool generation, binary availability, and topology mounts must exist before an end-to-end run can be exercised.
- **Deliverables:** `property_documents` metadata, `ai-tools.ts`, focused tool tests, `AGENT.md`, `OUTCOME.md`, `SAMPLE.json`, module registration, main Dockerfile dependency, file-plane environment/mount wiring, artifact cap.
- **Independent slices / estimated commits:** one cohesive slice because discovery, session-bound tool execution, and runtime configuration form one executable security contract.
- **Requirements closed:** REQ-001–REQ-005
- **Tests:** TEST-001, TEST-002
- **Validation:** focused PDF-tool test; `yarn generate`; generated agent inspection; Compose config rendering; app/MCP image build; host/container utility smoke.
- **Exit gate:** Generated agent denies bash and allows only the bounded PDF tool; tool boundary tests pass; every topology shares exact workspace paths; host and app/MCP image expose Poppler.

### Phase 2 — End-to-end PDF exercise

- **Depends on:** Phase 1 exit gate
- **Outcome:** A representative mixed PDF produces complete parsed and visual artifacts under real tenant/org authorization.
- **Why this order / value delivered:** Verifies the model/runtime contract only after the deterministic runtime surface is proven.
- **Deliverables:** Synthetic smoke fixture/run evidence; any prompt corrections required by the observed output; no production fixture retained unless it defends a deterministic regression.
- **Independent slices / estimated commits:** one sequential browser/API smoke because one run supplies all artifact and cleanup evidence.
- **Requirements closed:** REQ-001–REQ-004
- **Tests:** TEST-003–TEST-006
- **Validation:** Actual upload/run/trace inspection; focused generation/container checks after corrections; configured broad validation gate.
- **Exit gate:** All acceptance criteria pass with finalization and outcome metadata inspected, inaccessible attachment and page-limit behavior fail closed, workspace cleanup is observed, and the full configured validation gate exits zero.

## Implementation Status

Source doc: `.ai/specs/2026-09-18-pdf-brief-floor-plan-agent.md`

| Phase | State | Dependencies | Acceptance IDs | Focused validation | Exit gate |
|---|---|---|---|---|---|
| Phase 1 — Runtime and agent contract | completed | none | AC-001–AC-005 | 21 focused tests; `yarn generate`; three Compose configs; Poppler runtime check; production OpenCode image | Generated agents deny bash/write/edit and can read only server-authored analysis paths; bounded tool, metadata, and topology contracts pass |
| Phase 2 — End-to-end PDF exercise | completed | Phase 1 | AC-001–AC-004 | authenticated PDF run and trace; live agent/source-metadata APIs; inaccessible attachment failure; workspace cleanup; full configured gate | Finalization, scope failure, page limit, cleanup, discovery, metadata, and full gate verified |

### Phase 1 progress

- [x] Runtime and agent contract implemented: module, bounded tool, generated policy hardener, Poppler runtime, topology mounts, schemas, and focused tests.
- [x] Phase 2 final gate: trace `06404ece-6b10-40ef-9b40-ee0593d72089`; 21 tests; 227 design-system files; production build; live source metadata returned for both agents; final review found no remaining Critical/Important defects.

## Requirement Traceability

| Requirement | Journey / surface | Data/API/event contracts | Reference capability and mechanism | Phase | Tests | Acceptance criterion |
|---|---|---|---|---|---|---|
| REQ-001 | J-001/J-002, existing Playground/workflow | Additive agent ID + `brief.json` + scoped MCP tool | `src/modules/agent_examples/agents/deals_health_check/AGENT.md`; emitted-example file-agent discovery plus framework-only app tool | Phase 1–2 | TEST-001–TEST-003 | AC-001 |
| REQ-002 | J-001/J-002 | PNG artifact naming + render operation | `src/modules/agent_examples/agents/deals_health_check/OUTCOME.md`; framework-only file-plane artifact output | Phase 1–2 | TEST-001–TEST-003, TEST-005 | AC-002 |
| REQ-003 | J-001/J-002 | Normative `floor-plans.json` v1 contract | `src/modules/agent_examples/agents/deals_health_check/SAMPLE.json`; emitted-example sample/discovery | Phase 1–2 | TEST-003 | AC-003 |
| REQ-004 | J-001/J-002 | Existing attachment/session/artifact contracts + active-run tool guard | Installed Agent Orchestrator attachment stager; framework-only config | Phase 1–2 | TEST-002, TEST-004–TEST-006 | AC-004 |
| REQ-005 | Runtime | Exact topology matrix, main image dependency, shared workspace | main `Dockerfile`, three named Compose files; framework-only deployment configuration | Phase 1 | TEST-001, TEST-002 | AC-005 |

## Rollout, Migration, and Rollback

No database migration. Rollout order:

1. install `poppler-utils` on the hybrid-development host and in the main app/MCP Docker image;
2. run `yarn generate` so the agent and MCP tool registries contain the new stable IDs;
3. for `docker-compose.yml`, enable the file plane and keep the existing host bind mount `./.mercato/opencode-work:/home/opencode/work`;
4. for `docker-compose.fullapp.dev.yml` and `docker-compose.fullapp.yml`, mount one named `opencode_work` volume at `/home/opencode/work` in `app`, `mcp`, and `opencode`;
5. set the topology-matrix environment exactly, including `OM_OPENCODE_FILES_ENABLED=true`, matching workspace roots, and `OM_AGENT_ARTIFACT_MAX_COUNT=50` on the run-owning app;
6. restart app, MCP, and OpenCode, then run tool integration and synthetic end-to-end smoke checks.

Rollback: disable `OM_OPENCODE_FILES_ENABLED`, remove `property_documents` from enabled modules, regenerate, and restart. Existing runs/artifacts remain readable under existing authorization/retention rules. Removing Poppler later has no database or HTTP API migration impact. The additive agent/tool IDs must not be repurposed.

## Risks and Tradeoffs

| Risk / tradeoff | Impact | Mitigation / detection | Residual risk |
|---|---|---|---|
| Prompt injection embedded in PDF | Agent may attempt irrelevant tool actions | No bash/network/domain mutation/sub-agent tools; MCP uses fixed `execFile` binaries and current-run paths; explicit untrusted-data instruction; trace inspection | Model can still misclassify content |
| Drawing misclassification | Wrong/missing images or discipline labels | Confidence/evidence fields, exact taxonomy, source-page provenance, `unknown`/`mixed`, representative smoke | Classification remains probabilistic |
| Large raster output | Storage/runtime exhaustion | 48-page, 96/150-DPI, 50-artifact, subprocess, per-file byte, and run-time caps | Dense A0 drawings may still approach byte cap |
| No durable artifact storage | Generated file bytes are not downloadable after sandbox cleanup | User explicitly accepted action-level `kind: artifact` metadata; finalization response and trace prove the generated file set; deployments may independently configure `storageService` | Later consumers that require bytes must add a storage provider |
| Password-protected/malformed PDF | Processing failure | Deterministic inspection and normative error artifact; no partial success | No recovery in this phase |
| Runtime workspace skew | Tool/agent cannot see the same files | Explicit three-topology matrix; one shared mount; config and containment tests | Operator overrides can still misconfigure paths |
| New system package increases image/host maintenance | Larger operational surface | `--no-install-recommends`, apt cache removal, documented host prerequisite, image scanning | Poppler updates require host/image refresh |

## Acceptance Criteria

- [x] **AC-001** — A same-scope PDF with brief pages produces normative schemaVersion 1 `brief.json` data with required fields, bounds, and source-page provenance.
- [x] **AC-002** — Every detected floor-plan page produces exactly one `floor-plan-page-####.png` during finalization; brief, elevation, section, detail, schedule, cover, legend-only, and unrelated pages produce none.
- [x] **AC-003** — Normative `floor-plans.json` covers every source page exactly once across brief/plan/other sets and has a one-to-one plan-to-PNG mapping with bounded typed metadata.
- [x] **AC-004** — Cross-scope/missing inputs fail before tool/model; same-scope invalid/over-limit PDFs produce only normative `processing-error.json`; per-run workspace is removed after success/failure.
- [x] **AC-005** — Hybrid, full-app development, and full-app production configurations match the topology matrix; generated agent denies bash/write/edit; only the app/MCP process exposes Poppler.
- [x] Existing Playground/Agents surfaces remain unchanged and show the new generated agent through discovery.
- [x] The configured validation gate passes.

## Final Compliance Report

| Check | Status | Evidence / resolution |
|---|---|---|
| Applicable `AGENTS.md` files and routed guides/skills reviewed | pass | Root rules; `ai-workflows`; attachments and ai-assistant facts; installed Agent Orchestrator guide; `om-create-ai-agent`; `om-spec-writing` |
| Data models, APIs, events, UI, and tests are internally consistent | pass | No DB/HTTP/event/UI change; normative artifacts, additive MCP tool, topology matrix, and traceability are explicit |
| Every workflow completes end to end without a catch-all integration phase | pass | J-001/J-002 and Phase 1/2 exit gates |
| Platform-native reuse and extension points were chosen before custom code | pass | Existing attachments, file-agent discovery, runtime handler, artifact capture, Playground and workflow activity reused |
| UI contracts identify references, canonical components, and theme/state coverage | pass | No UI change; installed Playground/Agents surfaces named explicitly |
| Every phase has dependencies, bounded slices, tests, value, and an observable exit gate | pass | Phase 1 and Phase 2 sections |

Verdict: Implemented

## Open Questions

N/A — dependency, individual PNG format, parsed-brief shape, plan-view taxonomy, bounded MCP execution, runtime topology, and action-level artifact retention were resolved with the user on 2026-09-18.

## Changelog

| Date | Change |
|---|---|
| 2026-09-18 | Initial skeleton: scoped PDF file agent, general brief JSON, drawing manifest, Poppler runtime. |
| 2026-09-18 | Replaced unrestricted OpenCode shell execution with a session-bound MCP tool; made drawing taxonomy, artifact schemas, error shape, and all topology mounts/environment normative after scope-cohesion review. |
| 2026-09-18 | User selected individual PNG artifacts instead of an archive; completed security, runtime, contracts, tests, phasing, and traceability. |
| 2026-09-18 | Implemented and exercised the bounded PDF agent; user selected action-level artifact metadata without S3 or another durable artifact store. |
| 2026-09-18 | Corrected semantic finalization recovery after trace `6d63c741-526b-4610-b46a-9e3932de6b3c`: nested brief provenance must stay within `briefPages`, validation reports all actionable violations, one corrected retry is allowed, and artifact outcome examples include the required discriminator and paths. |
| 2026-09-18 | Reloaded the standalone MCP tool bundle and OpenCode agent profile, then verified the corrected flow end to end in trace `a2e9b325-1027-4a61-988d-0d3caa4144bf`: the first semantic rejection named the duplicate page, the agent retried once, finalization succeeded, and the complete artifact outcome was accepted on its first submission. |

# PDF Brief and Floor-Plan Intake Agent

**Date**: 2026-09-18
**Status**: Draft amendment — raw text and page images

## TLDR

Amend the existing `property_documents.pdf_intake` file agent into a deterministic PDF preprocessing step. One authorized PDF produces strict `brief.json` containing exactly `{ "brief": string }`, a non-semantic `pdf-pages.json` inventory, and one ordered `pdf-page-####.png` for every source page. Because installed Agent Orchestrator 0.8.0 limits `AgentResult.artifacts` to 20 references, the result names the two JSON control artifacts while the filesystem-authoritative file plane durably captures every PNG as a scoped `AgentRunArtifact`; a later flow accepts only the exact complete captured set.

This stage performs no image interpretation, page classification, floor-plan description, or brief parsing. `floor-plans.json` is removed; later workflow stages own all image analysis. The current Agent Orchestrator file plane, scoped attachment/artifact contracts, Poppler runtime, stable agent/tool IDs, and workspace cleanup remain in use.

## Problem Statement

The current intake agent asks the model to parse the brief, inspect every rendered page, classify floor plans, and produce a large pair of manifests. The requested boundary is simpler: downstream stages need the original extracted PDF text and source-page images, while semantic interpretation belongs later in the workflow.

Keeping classification here duplicates responsibility, makes the output probabilistic, and couples preprocessing to one floor-plan taxonomy. The intake stage must instead preserve source material deterministically: full Poppler text plus an image for every page, with source order encoded in filenames.

## Overview and Success Measures

- **Primary outcome:** For an authorized PDF of at most 48 pages, one run produces strict one-field `brief.json` and exactly one `pdf-page-####.png` per source page.
- **Leading indicators:** The agent never reads page text/images; `finalize` accepts no model-authored document data; no `floor-plans.json` or classification fields appear in authored/generated runtime contracts.
- **Baseline:** The implemented agent asks the model to parse a structured brief, classify pages, describe floor plans, and finalizes `brief.json`, `floor-plans.json`, and selected plan PNGs.
- **Market / product reference:** Docling and Unstructured separate deterministic document extraction from later semantic processing. This amendment adopts that boundary using the already-installed Poppler/file-plane path and defers every image interpretation decision.

## Goals

- **REQ-001** — An authorized user can run `property_documents.pdf_intake` with exactly one PDF attachment and receive `brief.json` containing only `{ "brief": string }`, where `brief` equals the complete raw text emitted by server-owned `pdftotext -layout` for the unchanged PDF.
- **REQ-002** — Every source page is emitted and durably captured as exactly one PNG named `pdf-page-####.png`; strict `pdf-pages.json` declares the complete ordered filename set, and a run is handoff-ready only when the inventory, brief, and all image rows exist in tenant/org/run-scoped `AgentRunArtifact` storage with retrievable bytes.
- **REQ-003** — The stage emits no `floor-plans.json` and performs no model-based brief parsing, image analysis, page classification, floor-plan typing, or drawing description.
- **REQ-004** — Attachment access, sandbox paths, persisted artifacts, raw text/page images, and cleanup remain tenant/org scoped and fail closed.
- **REQ-005** — Local hybrid, full-app development, and full-app production topologies expose the same scoped PDF-processing tool and shared workspace contract.

## Non-goals

- Determining whether a page is a floor plan or another document type.
- Extracting rooms, dimensions, disciplines, evidence, titles, levels, scales, or other image semantics.
- Parsing, summarizing, translating, normalizing, or semantically validating the extracted text.
- Creating or mutating property, project, quote, task, or workflow records.
- Supporting encrypted/password-protected PDFs, malformed PDFs, documents above 48 pages, non-PDF inputs, or OCR for image-only PDFs.
- Adding a new upload UI, API route, database entity, migration, queue, worker, or downstream image-analysis agent in this amendment.

## Proposed Solution

1. Keep stable IDs `property_documents.pdf_intake` and `property_documents.process_pdf`, plus the existing one-attachment file-agent entry point.
2. Preserve `inspect` as the intake-only hash boundary: validate one staged PDF with `pdfinfo`, run fixed `pdftotext -layout`, retain the complete aggregate UTF-8 output, and persist the filename/page-count/SHA-256 inspection marker. Do not render 96-DPI previews or split page text; the separately retired `pdf_text_reader` remains retired.
3. Make the intake prompt call `inspect` once and, on success, call `finalize` once with exactly `{ "operation": "finalize" }`. It does not read document files or send model-authored document content.
4. Bind `finalize` to the unchanged inspected PDF. Read the retained aggregate text, render every source page at 150 DPI, and atomically write strict `brief.json`, strict `pdf-pages.json`, and `pdf-page-####.png` for every page.
5. On success, submit one `artifact` outcome listing only `brief.json` and `pdf-pages.json`, staying within the installed 20-reference AgentResult limit. The filesystem-authoritative collector independently scans `out/`, durably stores all control files and PNGs, and persists scoped `AgentRunArtifact` rows; downstream handoff fails closed unless those rows exactly match `pdf-pages.json`. Remove `floor-plans.json` entirely.
6. On any validation, Poppler, hash, render, or output failure, replace partial output with the existing normative `processing-error.json`; there is no semantic correction retry because finalization accepts no model-authored classification.
7. Keep scope, active-run binding, exact session-token validation, realpath containment, fixed `execFile` arguments, page/artifact limits, storage authorization, and workspace cleanup unchanged.
8. Add an RFQ-owned complete-set validator now. It may run only after the synchronous intake invocation returns; it strict-parses byte-retrievable `brief.json` and `pdf-pages.json`, then verifies the exact scoped page artifact rows and PNG bytes. The current RFQ commands raise bounded code `PDF_INTAKE_DOWNSTREAM_DEFERRED` before any semantic agent or promotion call. The approved dependent RFQ implementation reuses this validator and replaces only the deliberate stop with complete-brief matching and idempotent materialization of every page.

### Design Decisions and Alternatives

| Decision | Rationale | Alternative considered | Why rejected / deferred |
|---|---|---|---|
| Server-owned raw text | Preserves actual Poppler output and removes model rewriting/truncation | Ask the model to copy page text | Model output is not raw |
| PNG for every page | Defers all image decisions and guarantees the next stage receives complete ordered source material | Keep selecting floor-plan pages here | Selection is image analysis and belongs to the next stage |
| Remove `floor-plans.json` | No semantic image data is produced in preprocessing | Emit an empty or path-only manifest | Duplicates information already encoded in ordered filenames |
| One-field `brief.json` | Matches the selected machine-readable contract | Emit `brief.txt` | User selected a one-field JSON object |
| Retain the file agent | Reuses authorized attachment staging, run trace, artifact capture, and cleanup behind the existing entry point | Add a direct PDF API | Duplicates file-plane authorization/lifecycle and changes the user entry point |
| Keep `inspect` + `finalize` | Preserves the inspected-byte hash boundary while removing all model-authored finalization data | Collapse to one new operation | Unnecessary contract churn |
| Two control references + file-plane PNGs | Preserves 48-page support under the installed `AgentResult.artifacts.max(20)` while every PNG remains a durable run artifact | Lower PDF limit to 19 or patch the framework globally | User selected 48-page support; dependency patch is disproportionate |
| Clean app-contract cutover | The implemented RFQ consumer is not compatible with the new artifacts and must stop before semantic analysis until its downstream contract is implemented | Keep old artifacts beside new output | Contradicts the requested boundary and retains unnecessary model work |

## Domain Vocabulary and Business Rules

| Term / invariant | Precise meaning or rule | Source of truth | Failure behavior |
|---|---|---|---|
| Input PDF | Exactly one staged attachment whose bytes are accepted by `pdfinfo`; extension/model assertion is insufficient | `attachments` record + staged bytes + Poppler | Reject before output |
| Raw PDF text | Complete UTF-8 contents written by `pdftotext -layout`, preserved at the parsed-string level | Server-owned aggregate analysis file bound to inspection hash | Fail finalization; never substitute model/OCR text |
| Source page | Original 1-based page position in the PDF | `pdfinfo` page count and Poppler render order | Never renumber or omit |
| Page image | 150-DPI PNG named `pdf-page-####.png`; exactly one per source page, captured from `out/` as a run artifact rather than enumerated in `AgentResult` | Server-owned `pdftoppm` render + Agent Orchestrator collector | Any missing/empty page fails preprocessing; any missing persisted row makes the run ineligible for downstream handoff |
| Complete output | Strict `brief.json`, strict `pdf-pages.json`, and exactly `pageCount` PNGs; no semantic manifest | Scoped result/out directory | Any preprocessing failure leaves only `processing-error.json` |
| Handoff-ready run | The scoped artifact list exactly matches `brief.json`, `pdf-pages.json`, and its declared ordered PNG filenames, all with retrievable bytes | Installed Agent Orchestrator 0.8.0 file plane | Later flow rejects incomplete/skipped/extra/failed capture; source run success alone is insufficient |
| Deferred analysis | Classification, plan detection, room/dimension extraction, and other image semantics happen after this stage | Future downstream contract | Not implemented or guessed here |

## Users, Permissions, and Scope

| Actor | Allowed outcomes | Scope rule | Required feature IDs |
|---|---|---|---|
| Authorized staff user | Run agent and view/download its run artifacts | Exactly one selected tenant organization | `agent_orchestrator.agents.run` |
| Workflow principal | Invoke the agent and consume verified artifact references | Workflow-bound tenant and organization; exact complete-set check required | Workflow granted features including `agent_orchestrator.agents.run` |

Trusted `tenantId` and `organizationId` come from the authenticated session or workflow context. The input contains only an attachment UUID; the stager re-resolves it with both trusted scope keys. Missing, cross-tenant, cross-organization, or inaccessible attachments fail the run. There is no system-scope execution.

## Reuse and Ownership Map

| Capability | Reuse / extend / app-own | Existing module or new module | Integration seam | Why |
|---|---|---|---|---|
| Attachment storage and scoped reads | reuse | `attachments` | attachment object ID + storage driver | Canonical storage and authorization |
| Agent execution and typed artifact result | reuse | `agent_orchestrator` | file-agent discovery | Canonical run/trace/guardrail lifecycle |
| OpenCode execution | reuse | `ai_assistant` / OpenCode | installed runtime handler + MCP session auth | Preserve the existing authorized agent entry point and outcome lifecycle |
| PDF intake instructions and artifact contract | app-own | `property_documents` | `agents/<id>/` discovery | Application-specific deterministic preprocessing contract |
| Bounded PDF processing | app-own | `property_documents` | discovered `ai-tools.ts` / MCP context | Keep all extraction/rendering and writes server-owned |
| Poppler binaries | app-owned image extension | main `Dockerfile` app/MCP image + documented host prerequisite | fixed `execFile` calls | Deterministic PDF inspection, text extraction, and rasterization |
| Artifact encryption/storage | reuse | `agent_orchestrator` 0.8.0 artifact plane + configured tenant storage | run artifact capture before sandbox wipe | Existing encrypted, scoped download contract; capture failure records no dangling row |
| Handoff eligibility validation | app-own now | `rfq_intake` | source run result + scoped `AgentRunArtifact` rows after invocation return | Makes the current consumer fail explicitly and gives the later flow one reusable exact-set guard |

## Architecture and Data Flow

```text
Playground / INVOKE_AGENT
  -> existing agent run/process surface
  -> trusted tenant + selected organization
  -> attachment UUID in input.__files
  -> Agent Orchestrator stages PDF in private workspace/in
  -> OpenCode agent calls process_pdf { operation: "inspect" }
       -> active session/run/agent + containment validation
       -> pdfinfo + pdftotext -layout
       -> aggregate raw text + page text + SHA-256 marker in analysis/
  -> OpenCode agent calls process_pdf { operation: "finalize" }
       -> unchanged inspected-byte validation
       -> pdftoppm renders every page at 150 DPI
       -> atomic brief.json + pdf-pages.json + pdf-page-####.png outputs
  -> artifact outcome lists brief.json + pdf-pages.json (2 of max 20 references)
  -> collector independently scans out/, durably stores every control file and PNG, and persists scoped AgentRunArtifact rows
  -> later flow strict-parses pdf-pages.json and validates the exact complete persisted set before handoff
  -> sandbox wipe + session-token revocation
```

- **Module boundaries:** `property_documents` owns deterministic ephemeral PDF preprocessing. `attachments` owns uploaded bytes; Agent Orchestrator owns runs/artifacts; future workflow stages own image analysis.
- **Extension points:** app module metadata, discovered `ai-tools.ts`, and `agents/<id>/{AGENT.md,OUTCOME.md,SAMPLE.json}`; no installed source is edited.
- **Alternatives considered:** a direct processing API was rejected because the existing file agent already supplies scoped staging/capture/cleanup. Model page reads were rejected because preprocessing has no interpretive task.
- **Compatibility:** Stable agent/tool IDs, result kind, run route, attachment envelope, authorization, and topology remain. `brief.json` changes shape; `floor-plans.json` is removed; selected `floor-plan-page-####.png` outputs become complete `pdf-page-####.png` outputs; `finalize` no longer accepts `brief`/`floorPlans`.

### Runtime topology contract

| Topology | Files changed | Workspace visible to run owner / MCP / OpenCode | Required environment | Poppler location |
|---|---|---|---|---|
| Hybrid host app + container OpenCode | `.env`, `docker-compose.yml` | host `./.mercato/opencode-work` / same host path / container `/home/opencode/work` via bind mount | app+MCP: `OM_OPENCODE_FILES_ENABLED=true`, `OM_OPENCODE_WORKSPACE_ROOT=./.mercato/opencode-work`, `OM_OPENCODE_WORKSPACE_ROOT_CONTAINER=/home/opencode/work`, `OM_AGENT_ARTIFACT_MAX_COUNT=50`; OpenCode: file flag true | host OS prerequisite |
| Full-app development | `docker-compose.fullapp.dev.yml`, main `Dockerfile` | named `opencode_work` mounted at `/home/opencode/work` in `app`, `mcp`, and `opencode` | all three: file flag true and both workspace roots `/home/opencode/work`; app: artifact count 50 | app/MCP image |
| Full-app production | `docker-compose.fullapp.yml`, main `Dockerfile` | named `opencode_work` mounted at `/home/opencode/work` in `app`, `mcp`, and `opencode` | all three: file flag true and both workspace roots `/home/opencode/work`; app: artifact count 50 | app/MCP image |

The MCP process owns Poppler execution. OpenCode needs no shell, file write/edit, document read, or image capability for this agent.
`@open-mercato/enterprise` 0.8.0 completes the run row before best-effort artifact capture, but the same `agentRuntime.run` / `INVOKE_AGENT` promise returns only after that capture attempt finishes. Capture is file-level fail-closed—unstored bytes create no row—but does not retroactively fail the run. Therefore configured tenant storage is a handoff prerequisite. Consumers validate only after the invocation promise resolves; observing run status alone is not a readiness signal. A recovered completed run without the exact captured set is terminally not handoff-ready and must be rerun rather than polled indefinitely.

## User Journeys

### Journey J-001 — Preprocess one PDF

1. Staff uploads a PDF through the existing attachment flow and selects one organization.
2. Staff runs `property_documents.pdf_intake` with the attachment UUID.
3. The agent invokes server-owned inspection and finalization without reading or interpreting document content.
4. The result lists strict `brief.json` and non-semantic `pdf-pages.json`; runtime capture attempts to persist both plus one ordered PNG per page under the run, no `floor-plans.json` is present, and the run is handoff-ready only after an exact persisted-set check.
5. Invalid scope/input, unsupported PDF, changed bytes, missing raw text, or any failed/empty page render yields only `processing-error.json`.

### Journey J-002 — Hand off to a later workflow stage

1. A workflow awaits the scoped intake invocation and checkpoints its returned `runId`; it never triggers handoff from run-status observation alone.
2. After invocation return, the shared RFQ validator strict-parses scoped, byte-retrievable `brief.json` and `pdf-pages.json`, then requires every exact declared `pdf-page-####.png` `AgentRunArtifact` and rejects missing, extra, unreadable, incorrectly typed, or out-of-sequence files.
3. In this amendment, the existing RFQ consumer then raises `PDF_INTAKE_DOWNSTREAM_DEFERRED` before any semantic Agent or artifact-promotion call. The approved dependent slice reuses the validator, sends the complete authorized brief to the matcher once, and idempotently materializes every image artifact as a scoped temporary Attachment for one room-dimensions invocation per page.

## UI and Interaction Contracts

No new or changed UI route. The existing surfaces are reused unchanged:

| Surface / route | Purpose and primary actions | Data source / mutations | Closest installed reference | Canonical shell / components | Required states | Requirement IDs |
|---|---|---|---|---|---|---|
| `/backend/playground` | Select agent, insert sample, submit scoped attachment input, inspect result/artifacts | Existing Agent Orchestrator APIs | `agent_orchestrator/backend/playground/page.tsx` | Existing installed page | Existing loading/error/permission/run states | REQ-001–REQ-004 |
| `/backend/agents/property_documents.pdf_intake` | Inspect generated prompt, files, runtime and token budget | Existing Agent Orchestrator APIs | `agent_orchestrator/backend/agents/[id]/page.tsx` | Existing installed page | Existing loading/not-found/forbidden states | REQ-005 |

### UI architecture

N/A — no navigation, component, widget, localization, or interaction contract changes. The agent appears through existing generated registry behavior.

## Data Models

N/A — no new entity or migration. Inputs reuse `attachments`; outputs reuse `AgentRunArtifact`.

### `brief.json` — normative schema

Strict object with exactly one required field:

```json
{
  "brief": "Complete raw text emitted by pdftotext -layout"
}
```

| Field | Contract |
|---|---|
| `brief` | string, including `""` when the PDF has no extractable text; after JSON parsing equals the complete UTF-8 aggregate `pdftotext -layout` output, including whitespace/form-feed separators |

No additional properties are present.

For downstream use, the same scoped `brief.json` must also exist as a byte-retrievable `AgentRunArtifact`; the later matcher handoff reads and JSON-parses those authorized bytes, validates the strict one-field schema, and never trusts text copied from an Agent result summary.

### `pdf-pages.json` — normative schema

Strict server-authored object `{ "pageCount": number, "files": string[] }`. `pageCount` is 1 through 48; `files` has exactly `pageCount` entries and equals `pdf-page-0001.png` through the final contiguous page name in order. No semantic fields or additional properties are present.


### `pdf-page-####.png` — normative contract

- Exactly one non-empty PNG per source page.
- `####` is the original 1-based page number, zero-padded to four digits.
- PNGs are not enumerated in `AgentResult.artifacts`; installed 0.8.0 caps that array at 20 while this contract supports 48 pages.
- With configured tenant storage, the filesystem-authoritative collector can persist one same-name `AgentRunArtifact` per PNG under the source `runId`, `tenantId`, and `organizationId`; downstream handoff requires the exact `pdf-pages.json` set and retrievable bytes.
- 150 DPI, produced only by fixed server-owned `pdftoppm`; no semantic metadata is emitted.

### Removed success artifact

`floor-plans.json` is not emitted. Historical runs retain their existing artifact bytes; new runs expose `brief.json`, `pdf-pages.json`, and page PNGs on success.

### `processing-error.json` — normative schema

This remains the only output when a same-scope staged file cannot be processed safely. Its existing schema/failure codes remain unchanged. No brief, page inventory, or page PNG may coexist with this artifact.

## API, Command, and Error Contracts

No new HTTP API or command. Stable tool ID, amended app-owned operations:

| Method / command | Path / ID | Auth and feature gate | Input | Success response / event | Errors and concurrency | Requirement IDs |
|---|---|---|---|---|---|---|
| internal commands | `rfq_intake.plans.analyze`, `rfq_intake.requirements.match` | trusted workflow scope | correlated new-format intake run after invocation return | no success path in this amendment | reuse complete-set validator, then throw `[internal] PDF_INTAKE_DOWNSTREAM_DEFERRED` before model/runtime/promotion work; no automatic retry | REQ-002–REQ-004 |
| `POST` | `/api/agent_orchestrator/agents/property_documents.pdf_intake/run` | Auth + `agent_orchestrator.agents.run` + selected organization | existing reserved attachment input | Existing artifact AgentResult + `runId` | Existing route errors | REQ-001–REQ-004 |
| MCP tool | `property_documents.process_pdf` | active session + allowed PDF agent + feature | `{ operation: "inspect" }` | `{ operation, fileName, pageCount, pages: [{ sourcePage }] }` | canonical failure + server-authored error; one inspect per run | REQ-001, REQ-004, REQ-005 |
| MCP tool | `property_documents.process_pdf` | active session + exact `property_documents.pdf_intake` | `{ operation: "finalize" }` | metadata only: `{ operation, pageCount, artifacts: [{ sourcePage, path }], manifests: [briefPath, pageInventoryPath] }`; raw text exists only in `brief.json` | rejects changed/uninspected input, missing raw text, failed/empty render, unavailable Poppler, or artifact overflow; failure replaces partial output | REQ-001–REQ-005 |

`inspect` and `finalize` are intake-only and accept no model-supplied text, page numbers, classifications, metadata, paths, scope, or output names. The retired `property_documents.pdf_text_reader` identity remains rejected.

Processing errors:

- wrong-scope/missing attachments fail before inference; zero/multiple PDFs produce only `processing-error.json`;
- malformed/encrypted/over-limit input, Poppler failure, changed bytes, missing aggregate text, wrong render count, empty PNG, or artifact overflow produce only `processing-error.json`;
- no semantic retry exists; one failed finalization is terminal;
- artifact storage failure creates no dangling `AgentRunArtifact`; installed 0.8.0 capture is best-effort after run completion, so a later flow treats an incomplete persisted set as not handoff-ready even if the Agent result succeeded.

## Events, Jobs, Notifications, and Cross-Module Flows

No new worker, queue, event, notification, or scheduler contract. Direct Playground execution is synchronous. Installed capture runs before the invocation promise returns; `agent_orchestrator.artifact.captured` remains audit evidence, not a trigger required by this slice. The artifact result/run plus an exact post-return persisted-set check is the stable handoff boundary. Current RFQ commands stop with `PDF_INTAKE_DOWNSTREAM_DEFERRED`; later flow code converts selected images to `Attachment` IDs before downstream `__files.attachments`. A captured artifact ID is never passed where an Attachment ID is required, and the installed proposal-only promotion command is not used without an approved proposal.

## Security, Privacy, and Compliance

- **Authorization / artifact-authorization:** Attachment IDs are re-resolved under trusted tenant and organization. The tool requires an active run/session for an allowed PDF agent; `finalize` additionally requires exact intake-agent identity. Page artifacts are resolved later only by source run + artifact ID + tenant + organization.
- **Tenant isolation:** No scope/session/path/raw content is accepted from model input. A later handoff must fail closed on foreign run/artifact identity.
- **Sensitive data / encrypted storage:** Raw text and page images remain only in scoped workspace/artifacts; tool responses, traces, errors, and business records contain no raw content. Handoff requires configured tenant artifact storage; installed capture encrypts bytes before durable storage and records no row on failed storage. A downstream temporary Attachment inherits canonical scoped storage and cleanup.
- **Prompt injection:** The intake agent never reads document text/images, so embedded instructions do not enter its model context.
- **Binary boundary:** Only MCP invokes fixed `/usr/bin/pdfinfo`, `/usr/bin/pdftotext`, and `/usr/bin/pdftoppm` via `execFile`.
- **Output boundary:** Only the tool writes `brief.json`, `pdf-pages.json`, `pdf-page-####.png`, or `processing-error.json` under `out/`.
- **Cleanup:** Complete per-run workspace is wiped before lease reuse; source retention remains owned by Attachments.
- **Draft-only AI output:** N/A — deterministic artifact preprocessing only; no proposal or domain mutation.
- **Resource bounds:** 48 pages; two JSON files + at most 48 PNGs (50 success artifacts under cap 50); AgentResult carries 2 references under its fixed cap 20; 150 DPI; subprocess timeout/output bounds; exactly one inspect and one finalize call.

## Integration Coverage

| Test ID | Level | Setup / fixture | Actions | Assertions | Requirement IDs |
|---|---|---|---|---|---|
| TEST-001 | generation | enabled module with valid agent/tool files | `yarn generate` | generated prompt makes exactly inspect/finalize calls, contains no analysis instructions, lists only `brief.json` + `pdf-pages.json` in the outcome, explains file-plane PNG capture, and denies shell/write/edit/document read | REQ-001–REQ-003, REQ-005 |
| TEST-002 | tool integration | three-page workspace; mocked Poppler raw text includes layout/form feeds | inspect then empty-payload finalize | strict one-field brief equals aggregate text; strict inventory declares three ordered PNGs; output contains no `floor-plans.json`/preview/page-text files | REQ-001–REQ-005 |
| TEST-003 | end-to-end smoke | same-scope representative PDF + configured tenant storage | await authenticated run, then inspect persisted artifacts | artifact result contains the two control references; captured rows contain retrievable controls plus every declared page PNG with matching names/MIME/run/scope; no model document reads or semantic manifest | REQ-001–REQ-004 |
| TEST-004 | security | foreign attachment / wrong active agent / invalid token/path | invoke operations | fail closed; no leaked output | REQ-004 |
| TEST-005 | boundary | 49-page PDF | invoke agent | only normative error; no partial success | REQ-004 |
| TEST-006 | failure atomicity | inject failure on a middle/final render and missing aggregate text | finalize | only error artifact; no brief/PNG subset | REQ-001, REQ-002, REQ-004 |
| TEST-007 | retired-agent regression | invoke `process_pdf` under retired `pdf_text_reader` identity | inspect | identity remains rejected; no retired files/profile/runtime entry is restored | REQ-005 |
| TEST-008 | handoff eligibility | resolved intake invocation with complete set, then one missing/unreadable/extra/mistyped artifact variant | run shared RFQ validator | strict brief+inventory and complete PNG set pass eligibility; every mismatch is terminally rejected without polling or Attachment conversion | REQ-002, REQ-004 |
| TEST-009 | deferred consumer guard | fully captured new-format run | invoke current plan and requirement commands | both raise `PDF_INTAKE_DOWNSTREAM_DEFERRED` before agent runtime, command-bus promotion, or semantic parsing; legacy artifact UI readability remains unchanged | REQ-002–REQ-004 |

## Implementation Phases

### Historical Phase 1 — Runtime and agent contract

- **Depends on:** none
- **Outcome:** The application discovers a file-enabled PDF intake agent and bounded MCP tool; every supported runtime topology provides one shared workspace and Poppler-capable MCP process.
- **Why this order / value delivered:** Agent/tool generation, binary availability, and topology mounts must exist before an end-to-end run can be exercised.
- **Deliverables:** `property_documents` metadata, `ai-tools.ts`, focused tool tests, `AGENT.md`, `OUTCOME.md`, `SAMPLE.json`, module registration, main Dockerfile dependency, file-plane environment/mount wiring, artifact cap.
- **Independent slices / estimated commits:** one cohesive slice because discovery, session-bound tool execution, and runtime configuration form one executable security contract.
- **Historical baseline closed:** original 2026-09-18 requirements, superseded by the amendment requirements below
- **Historical tests:** legacy focused tool and generation coverage
- **Validation:** focused PDF-tool test; `yarn generate`; generated agent inspection; Compose config rendering; app/MCP image build; host/container utility smoke.
- **Exit gate:** Generated agent denies bash and allows only the bounded PDF tool; tool boundary tests pass; every topology shares exact workspace paths; host and app/MCP image expose Poppler.

### Historical Phase 2 — End-to-end PDF exercise

- **Depends on:** historical Phase 1 exit gate
- **Outcome:** A representative mixed PDF produced the then-current parsed brief and visual artifacts under real tenant/org authorization.
- **Why this order / value delivered:** Verifies the model/runtime contract only after the deterministic runtime surface is proven.
- **Deliverables:** Synthetic smoke fixture/run evidence; any prompt corrections required by the observed output; no production fixture retained unless it defends a deterministic regression.
- **Independent slices / estimated commits:** one sequential browser/API smoke because one run supplies all artifact and cleanup evidence.
- **Historical baseline closed:** original 2026-09-18 end-to-end requirements, superseded by the amendment requirements below
- **Historical tests:** legacy end-to-end, scope, boundary, and cleanup coverage
- **Validation:** Actual upload/run/trace inspection; focused generation/container checks after corrections; configured broad validation gate.
- **Exit gate:** All then-current acceptance criteria passed with finalization and outcome metadata inspected, inaccessible attachment and page-limit behavior failing closed, workspace cleanup observed, and the configured validation gate exiting zero.

### Phase 3 — Deterministic raw-text and page-image amendment

- **Depends on:** historical Phases 1–2
- **Outcome:** Existing agent emits exact raw text and every source page image, with no image/brief interpretation.
- **Why this order / value delivered:** Establishes a lossless preprocessing boundary for later analysis and deletes duplicate semantic work.
- **Deliverables:** amended specs; intake `AGENT.md`/`OUTCOME.md`; intake inspect/finalizer; strict page inventory; two-reference artifact result; complete file-plane capture; focused tests; regenerated runtime/profile/policy; RFQ-owned exact-set validator and deliberate consumer stop; documented downstream `AgentRunArtifact → Attachment` boundary; dependent RFQ spec marked for separate image-analysis/materialization.
- **Independent slices / estimated commits:** one cohesive contract cutover across source prompt, tool schema/output, generated runtime, tests, current consumer validator/guard, and dependent documentation.
- **Requirements closed:** REQ-001–REQ-005
- **Tests:** TEST-001–TEST-009
- **Validation:** focused tests; `yarn generate`; generated source/profile/MCP schema/effective policy inspection; `yarn typecheck`; `yarn lint`; `yarn build`; fresh live smoke with configured artifact storage when MCP/OpenCode are available.
- **Exit gate:** Fresh run produces exact one-field brief, strict page inventory, and exactly one ordered PNG per PDF page in scoped persisted artifacts with retrievable bytes; AgentResult contains the two control references; the post-return validator accepts only that complete set; current RFQ consumers stop before semantic/promotion calls; no `floor-plans.json`, model document read, or current-stage analysis; unchanged scope/cleanup; green required validation.

## Implementation Status

Source doc: `.ai/specs/2026-09-18-pdf-brief-floor-plan-agent.md`

| Phase | State | Dependencies | Acceptance IDs | Focused validation | Exit gate |
|---|---|---|---|---|---|
| Historical Phase 1 — Runtime and agent contract | completed | none | historical 2026-09-18 baseline | 21 focused tests; `yarn generate`; three Compose configs; Poppler runtime check; production OpenCode image | Generated agents deny bash/write/edit and can read only server-authored analysis paths; bounded tool, metadata, and topology contracts pass |
| Historical Phase 2 — End-to-end PDF exercise | completed | historical Phase 1 | historical 2026-09-18 baseline | authenticated PDF run and trace; live agent/source-metadata APIs; inaccessible attachment failure; workspace cleanup; full configured gate | Finalization, scope failure, page limit, cleanup, discovery, metadata, and full gate verified |
| Phase 3 — Deterministic raw-text and page-image amendment | implemented; live persistence smoke pending | historical Phases 1–2 | AC-001–AC-006 | deterministic artifact regression; retired-agent regression; RFQ eligibility/guard regression; runtime parity; direct Poppler smoke; required gate | Strict raw brief + page inventory + all page PNGs; no semantic manifest/analysis; downstream consumers explicitly deferred |

### Historical Phase 1–2 progress

- [x] Runtime and agent contract implemented: module, bounded tool, generated policy hardener, Poppler runtime, topology mounts, schemas, and focused tests.
- [x] Phase 2 final gate: trace `06404ece-6b10-40ef-9b40-ee0593d72089`; 21 tests; 227 design-system files; production build; live source metadata returned for both agents; final review found no remaining Critical/Important defects.


### Phase 3 progress

- [x] Remove model brief/image interpretation and semantic finalization input.
- [x] Emit strict raw brief, strict page inventory, and all page PNGs; remove `floor-plans.json`.
- [x] Keep the AgentResult within two control references; validate the exact scoped persisted set after invocation return.
- [x] Replace current RFQ semantic consumers with the explicit deferred guard while preserving historical artifact readability.
- [x] Preserve the existing retirement of `pdf_text_reader`; do not restore its files, profile, ID, or tool authorization.
- [x] Run generation, focused tests, typecheck, lint, full tests, build, and a real four-page Poppler smoke.
- [ ] Exercise encrypted `AgentRunArtifact` persistence in a fresh live app/MCP/OpenCode run; no live runtime process was available during this implementation session.

## Requirement Traceability

| Requirement | Journey / surface | Data/API/event contracts | Reference capability and mechanism | Phase | Tests | Acceptance criterion |
|---|---|---|---|---|---|---|
| REQ-001 | J-001/J-002, Playground/workflow | strict raw `brief.json`; inspect/finalize | emitted-example file-agent + framework-only app tool | Phase 3 | TEST-001–TEST-003 | AC-001 |
| REQ-002 | J-001/J-002 | strict `pdf-pages.json` + exact scoped brief/inventory/page `AgentRunArtifact` set | installed file-plane capture + RFQ-owned eligibility validator + downstream artifact-to-Attachment boundary | Phase 3 | TEST-001–TEST-003, TEST-005, TEST-006, TEST-008, TEST-009 | AC-002 |
| REQ-003 | J-001/J-002 | removed floor manifest/prompt analysis + explicit RFQ consumer stop | generated prompt/profile/MCP contract + current RFQ commands | Phase 3 | TEST-001–TEST-003, TEST-009 | AC-003, AC-006 |
| REQ-004 | J-001/J-002 | existing attachment/session/artifact guards + scoped exact-set validation | installed stager + active-run tool guard + RFQ validator | Phase 3 | TEST-002, TEST-004–TEST-006, TEST-008, TEST-009 | AC-004, AC-006 |
| REQ-005 | Runtime | topology + retired-agent rejection | existing runtime configuration | Phase 3 | TEST-001, TEST-002, TEST-007 | AC-005 |

## Rollout, Migration, and Rollback

No database migration.

### Migration & Backward Compatibility

- Stable: agent/tool IDs, run API, result kind, attachment envelope, authorization, workspace topology, artifact cap, and error artifact.
- Intentional cutover: `brief.json` becomes strict `{ "brief": string }`; strict non-semantic `pdf-pages.json` declares the ordered image set; `floor-plans.json` is removed; selected `floor-plan-page-####.png` becomes captured `pdf-page-####.png` artifacts for every page; `finalize` accepts only `{ operation: "finalize" }`; inspect drops previews/page-text outputs.
- The already-retired `pdf_text_reader` remains absent and rejected; this amendment does not restore it.
- `src/modules/rfq_intake/commands/analysis.ts` now owns the reusable post-invocation complete-set validator and replaces both invalid legacy semantic paths with bounded `PDF_INTAKE_DOWNSTREAM_DEFERRED` stops. The approved dependent RFQ spec reuses that validator and owns idempotent `AgentRunArtifact → Attachment` materialization for every page, one image-analysis call per page, and one whole-brief matcher call. Historical artifacts remain readable through the installed artifact surface but are not reprocessed by the invalid legacy path.
- Historical run artifacts remain unchanged/readable. External consumers must distinguish by run date or artifact set.

Rollout:

1. update the PDF intake prompt/outcome, tool schema/finalizer, focused tests, and dependent spec;
2. generate and inspect runtime registry/profile/MCP schema/effective policy;
3. restart app, standalone MCP, and OpenCode;
4. run focused retirement/eligibility regressions and fresh intake smoke.

Rollback restores prompt/tool/outcome together, regenerates, and restarts; historical artifacts are never rewritten.

## Risks and Tradeoffs

| Risk / tradeoff | Impact | Mitigation / detection | Residual risk |
|---|---|---|---|
| Every page is rendered | More bytes/time than selected plans | Existing 48-page, 150-DPI, artifact-count, timeout, and atomic-failure bounds | Dense drawings can still be expensive |
| Downstream receives non-plan images | Room extraction must safely return no rooms for unsupported pages | Approved dependent contract analyzes every ordered page without preprocessing classification | Extra bounded vision calls are intentional |
| Raw content is sensitive | Authorized readers receive full text/images | Scoped/encrypted artifacts, no raw traces/errors/business state, cleanup | Exposure to authorized artifact readers is intentional |
| JSON escaping mistaken for normalization | Serialized bytes differ from text bytes | Compare parsed string with aggregate Poppler file | JSON control-character escaping is unavoidable |
| Restoring stale text-reader assumptions | Reintroduces a retired agent and widens authorization | Keep current deletion/rejection tests; remove obsolete shared-reader requirements from this amendment | Historical text-reader spec remains archival only |
| Artifact is mistaken for downstream Attachment | Next file-agent cannot stage input | Explicit handoff contract requires scoped validation and idempotent materialization; never pass artifact IDs in `__files.attachments` | Adapter implementation remains part of the later flow slice |
| Installed capture is best-effort after run completion | Result row can show success while storage leaves an incomplete artifact set | Validate only after invocation return; require configured storage, exact scoped rows, and retrievable bytes | Status-only observers must not start handoff; crash before capture requires rerun |
| Unknown external consumer expects old artifacts | Break on missing manifest/renamed images | Migration/changelog; stable run/agent IDs; clean historical artifacts | Undisclosed scripts need manual migration |

## Acceptance Criteria

- [ ] **AC-001** — Same-scope PDF produces strict `brief.json` with exactly one `brief` field equal to complete server-owned `pdftotext -layout` output.
- [ ] **AC-002** — With configured tenant storage, a PDF with `N` pages produces strict `pdf-pages.json` plus exactly `N` non-empty `pdf-page-####.png` files and the same scoped, byte-retrievable `AgentRunArtifact` rows; AgentResult stays within two control references; post-return validation rejects any missing, extra, unreadable, mistyped, or out-of-sequence file.
- [ ] **AC-003** — New successful runs contain no `floor-plans.json`, `floor-plan-page-*`, parsed brief fields, preview/page-text artifacts, or model document read/analysis.
- [ ] **AC-004** — Scope/input/hash/runtime/render failures leave only normative `processing-error.json`; failed artifact storage creates no dangling row; cleanup remains unchanged.
- [ ] **AC-005** — Retired `pdf_text_reader` files/profile/runtime entry/tool authorization remain absent; generated registry/profile/MCP/policy agree after restart; the result/run exposes sufficient identity for a later scoped artifact-to-Attachment adapter without treating an artifact ID as an Attachment ID.
- [ ] **AC-006** — On a fully captured new-format run, both current RFQ analysis commands raise `PDF_INTAKE_DOWNSTREAM_DEFERRED` before semantic agent, brief parsing, or proposal-only promotion calls; the later RFQ spec explicitly reuses the complete-set validator.
- [ ] Existing Playground/Agents surfaces remain unchanged.
- [ ] Focused tests, `yarn generate`, `yarn typecheck`, `yarn lint`, and `yarn build` pass; fresh live smoke is recorded when runtime is available.

## Final Compliance Report

| Check | Status | Evidence / resolution |
|---|---|---|
| Applicable rules/guides/skills reviewed | pass | root rules; compatibility; AI/file-agent/attachments guidance; matching lesson |
| Data/API/artifact/test contracts internally consistent | pass | strict brief + strict page inventory + all-page PNG capture; installed 0.8.0 result/capture limits and timing are explicit; RFQ-owned validator requires exact retrievable control/page rows after invocation return |
| Scope is one deployable capability | pass | deterministic preprocessing cutover plus reusable current-consumer validator/guard; image analysis/materialization remain deferred |
| Platform-native reuse precedes custom code | pass | existing stager, run, tool, Poppler, encrypted capture, and cleanup reused |
| UI contract complete | pass | no UI change |
| Phase has dependencies, tests, value, exit gate | pass | Phase 3 |

Verdict: Ready for implementation — written amendment and 48-page file-plane strategy approved

## Open Questions

N/A for this amendment — user selected strict raw `brief.json`, PNG for every page, deferred image analysis, encrypted run-artifact handoff, and preservation of 48-page support through file-plane capture rather than enumerating every PNG in the capped AgentResult on 2026-09-19.

## Changelog

| Date | Change |
|---|---|
| 2026-09-18 | Initial skeleton: scoped PDF file agent, general brief JSON, drawing manifest, Poppler runtime. |
| 2026-09-18 | Replaced unrestricted OpenCode shell execution with a session-bound MCP tool; made drawing taxonomy, artifact schemas, error shape, and all topology mounts/environment normative after scope-cohesion review. |
| 2026-09-18 | User selected individual PNG artifacts instead of an archive; completed security, runtime, contracts, tests, phasing, and traceability. |
| 2026-09-18 | Implemented and exercised the bounded PDF agent; user selected action-level artifact metadata without S3 or another durable artifact store. |
| 2026-09-18 | Corrected semantic finalization recovery after trace `6d63c741-526b-4610-b46a-9e3932de6b3c`: nested brief provenance must stay within `briefPages`, validation reports all actionable violations, one corrected retry is allowed, and artifact outcome examples include the required discriminator and paths. |
| 2026-09-18 | Reloaded the standalone MCP tool bundle and OpenCode agent profile, then verified the corrected flow end to end in trace `a2e9b325-1027-4a61-988d-0d3caa4144bf`: the first semantic rejection named the duplicate page, the agent retried once, finalization succeeded, and the complete artifact outcome was accepted on its first submission. |
| 2026-09-19 | Drafted the approved raw-brief amendment: `brief.json` becomes strict `{ "brief": string }` from server-owned full-document `pdftotext -layout`; model-authored brief interpretation is removed while plan extraction, filenames, scope, and runtime controls remain stable. |
| 2026-09-19 | Revised per user feedback: removed `floor-plans.json` and all current-stage image analysis; success is strict raw `brief.json` plus `pdf-page-####.png` for every source page. |
| 2026-09-19 | Made every page PNG an explicit result artifact persisted as scoped `AgentRunArtifact`; documented the required downstream idempotent artifact-to-Attachment bridge before another file-agent can consume it. |
| 2026-09-19 | Corrected the handoff contract against installed Agent Orchestrator 0.8.0: capture is durable per file but best-effort after run completion, so later flow checks exact scoped rows/bytes; identified and guarded the implemented legacy RFQ consumer. |
| 2026-09-19 | Resolved review findings: Phase 3 owns a reusable post-invocation exact-set validator covering `brief.json`, `pdf-pages.json`, and all PNGs; current RFQ consumers stop with `PDF_INTAKE_DOWNSTREAM_DEFERRED`; approved dependent RFQ work owns whole-brief matching, every-page analysis, and materialization. |
| 2026-09-19 | Resolved installed `AgentResult.artifacts.max(20)`: user kept 48-page support; added strict non-semantic `pdf-pages.json`, limited AgentResult to two control references, and made scoped file-plane rows the authoritative PNG handoff. Preserved the pre-existing retirement of `pdf_text_reader`. |
| 2026-09-19 | Implemented the deterministic cutover, generated the no-read two-reference profile, added exact scoped RFQ artifact validation plus deferred guards, passed focused/full/type/lint/build gates, and verified a real four-page PDF through Poppler. Fresh encrypted file-plane persistence remains a live-runtime QA boundary. |

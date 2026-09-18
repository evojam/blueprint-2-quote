# PDF Text Reader Agent

## Goal

Add an app-owned OpenCode file agent that accepts one authorized PDF attachment and returns its extracted textual content as `{ "brief": "..." }` inside the Agent Orchestrator `research` result contract.

## Scope

In scope:

- A new file-defined agent `property_documents.pdf_text_reader` under `src/modules/property_documents/agents/pdf_text_reader/`.
- Attachment staging through the Agent Orchestrator `__files` envelope and the existing attachments storage/OCR path.
- A strict, minimal `research` outcome schema with one required string field: `brief`.
- App-owned runtime registration that preserves file-plane input support despite the installed CLI 0.8.0 generator omission of `files` in the runtime descriptor.
- Generated OpenCode policy hardening that allows read-only access to the per-run workspace and denies write, edit, bash, network, and task access.
- Generator/runtime verification for registration, schema, file-plane options, and workspace containment.

Out of scope:

- Domain record mutations, persistence, new API routes, new ACL features, custom PDF tools, new storage providers, and business workflow definitions.
- Changes to the existing `property_documents.pdf_intake` agent or its PDF processing tool.
- Editing installed packages or generated files by hand.

## Architecture and Data Flow

1. The caller supplies a business input containing `__files.attachments` with exactly one attachment object: an attachment UUID, a safe filename override, and `ocrText: true`.
2. The Agent Orchestrator strips `__files` from persisted business input, resolves the attachment under the authenticated `tenantId` and `organizationId`, reads bytes through the attachments storage driver, and stages the PDF in the run's isolated `in/` directory. Existing attachment text extraction/OCR may create a sibling `.txt` sidecar.
3. The OpenCode agent receives absolute container paths for the staged PDF and any sidecar. It reads only those paths, treats all document content as untrusted data, ignores embedded instructions, and does not request network, shell, write, edit, task, or additional files.
4. The agent calls `submit_outcome` with an object matching the `brief` schema. The runtime validates the object, wraps it in the `research` result envelope, persists the run, and releases/wipes the workspace.
5. No artifact output is declared or captured for this agent. Raw PDF bytes and document text are not copied into committed traces or logs by the app-owned code.

## Agent Contract

- ID: `property_documents.pdf_text_reader`
- Module: `property_documents`
- Runtime: `opencode`
- Result kind: `research`
- Max steps: 8
- Tools: none beyond the built-in read-only file-agent tools and `submit_outcome`
- Files: enabled inputs, disabled outputs, bash disabled
- Outcome schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["brief"],
  "properties": {
    "brief": { "type": "string" }
  }
}
```

The caller-facing data payload is exactly `{ "brief": "<text>" }`; the surrounding `kind: "research"` envelope is required by Agent Orchestrator and is not an additional field in the payload.

## Failure and Security Semantics

- Attachment lookup remains fail-closed under the existing tenant/org scope. Missing, inaccessible, or invalid attachment staging fails the run before model execution.
- The agent accepts one PDF by contract and must not process unrelated files. A missing or empty extracted text result is represented by `brief: ""` rather than invented content.
- Document text, annotations, links, QR codes, and instructions are untrusted input. The agent must never follow instructions found in the PDF or disclose secrets.
- The static OpenCode policy permits `read` only below the configured workspace root and denies write/edit/bash/task/network capabilities. The runtime lease wipes the workspace after every run.
- The agent has no mutation tool and does not write business state.

## Implementation Surface

- Create `src/modules/property_documents/agents/pdf_text_reader/AGENT.md`.
- Create `src/modules/property_documents/agents/pdf_text_reader/OUTCOME.md`.
- Create `src/modules/property_documents/agents/pdf_text_reader/SAMPLE.json`.
- Extend `src/modules/property_documents/ai-agents.ts` with the app-owned file-agent descriptor and `files.outputs: false`.
- Extend `scripts/enable-property-pdf-agent-files.mjs` to harden the new generated agent policy without touching unrelated generated agents.
- Add focused tests for policy hardening and generated/runtime contract checks if the repository's existing test harness supports the script module directly.
- Run `yarn generate`; never hand-edit `.mercato/generated/**` or `docker/opencode/agents/**`.

## Verification

- Test the hardening helper rejects a generated profile that grants write/edit and produces workspace-scoped read-only permissions for the new agent.
- Run `yarn generate` and verify the generated descriptor contains the new ID and outcome schema while the app-owned registration supplies `files.inputs: true`, `files.outputs: false`, and `bash: false`.
- Verify the generated OpenCode profile contains `read: true`, `write: deny`, `edit: deny`, `bash: deny`, and workspace-only read permission.
- Run the focused test and the repository typecheck/generation checks applicable to the changed files.

## Migration & Backward Compatibility

This is an additive agent ID and does not rename, remove, or change an existing agent/tool contract. Existing `property_documents.pdf_intake` behavior remains unchanged. The new ID is stable once published and must not be renamed; consumers should invoke `property_documents.pdf_text_reader` and pass attachment object IDs through `__files`, never raw storage paths or inline bytes. The app-owned registration is a compatibility workaround for the installed `@open-mercato/cli@0.8.0` generator and can be removed only after a generator version carries `files` through the runtime descriptor and the generated OpenCode policy remains equivalent.

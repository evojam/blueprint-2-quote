# PDF Text Reader Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only OpenCode file agent that stages one authorized PDF attachment and returns its extracted text as `{ "brief": "..." }`.

**Architecture:** Use the existing `property_documents` app module's `agents/<id>/` convention and Agent Orchestrator `__files` attachment staging. Because `@open-mercato/cli@0.8.0` drops `files` from generated runtime descriptors, register the new descriptor app-side with `files.inputs=true`, `files.outputs=false`, and `bash=false`; harden the generated OpenCode profile to allow workspace-scoped reads only.

**Tech Stack:** Open Mercato Agent Orchestrator 0.8.0, OpenCode file-agent Markdown conventions, JSON Schema subset compiled by `compileOutcome`, TypeScript/Jest, Node filesystem helper.

**Spec:** `.ai/specs/2026-09-18-pdf-text-reader-agent.md`

## Global Constraints

- Do not modify `node_modules`, `.mercato/generated/**`, or generated Docker profiles by hand.
- Do not change the existing `property_documents.pdf_intake` agent or `property_documents.process_pdf` tool.
- Treat attachment content as untrusted; no network, bash, task, write, edit, mutation, or cross-scope access.
- Preserve the stable additive ID `property_documents.pdf_text_reader` and the exact payload field `{ brief: string }`.
- Run `yarn generate` after editing `agents/<id>/` files and inspect both runtime registration and generated policy output.

---

### Task 1: Add failing contract tests

**Files:**
- Create: `src/modules/property_documents/__tests__/pdf-text-reader-agent.test.ts`
- Read: `src/modules/property_documents/ai-agents.ts`

**Interfaces:**
- Consumes: `getAgentEntry` from the installed Agent Orchestrator SDK and the new stable agent ID exported by `src/modules/property_documents/ai-agents.ts`.
- Produces: executable assertions proving the runtime descriptor has `runtime: 'opencode'`, `resultKind: 'research'`, file inputs enabled, outputs disabled, bash disabled, and accepts only the `{ kind: 'research', data: { brief } }` envelope.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from '@jest/globals'
import { getAgentEntry } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'
import { PDF_TEXT_READER_AGENT_ID } from '../ai-agents'
import '../ai-agents'

describe('property_documents.pdf_text_reader', () => {
  it('registers a read-only file-plane research agent', () => {
    const entry = getAgentEntry(PDF_TEXT_READER_AGENT_ID)
    expect(entry).toMatchObject({
      id: PDF_TEXT_READER_AGENT_ID,
      moduleId: 'property_documents',
      runtime: 'opencode',
      resultKind: 'research',
      files: { enabled: true, inputs: true, outputs: false, bash: false },
    })
    expect(entry?.tools).toEqual([])
  })

  it('accepts exactly the brief payload and rejects extra fields', () => {
    const entry = getAgentEntry(PDF_TEXT_READER_AGENT_ID)
    expect(entry?.schema.safeParse({ kind: 'research', data: { brief: 'tekst PDF' } }).success).toBe(true)
    expect(entry?.schema.safeParse({ kind: 'research', data: { brief: 'tekst PDF', extra: true } }).success).toBe(false)
    expect(entry?.schema.safeParse({ kind: 'research', data: {} }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `yarn test src/modules/property_documents/__tests__/pdf-text-reader-agent.test.ts --runInBand`

Expected: FAIL because `PDF_TEXT_READER_AGENT_ID` and the new registry entry do not exist yet; the failure must be a missing export/entry, not a Jest configuration error.

---

### Task 2: Author the file-defined agent contract

**Files:**
- Create: `src/modules/property_documents/agents/pdf_text_reader/AGENT.md`
- Create: `src/modules/property_documents/agents/pdf_text_reader/OUTCOME.md`
- Create: `src/modules/property_documents/agents/pdf_text_reader/SAMPLE.json`

**Interfaces:**
- Consumes: Agent Orchestrator reserved `__files.attachments` input and the runtime-provided staged PDF/sidecar paths.
- Produces: generated descriptor source with ID `property_documents.pdf_text_reader`, `research` outcome, no declared domain tools, and a sample attachment input.

- [ ] **Step 1: Create `AGENT.md` with the exact frontmatter**

```md
---
id: property_documents.pdf_text_reader
label: PDF text reader
description: Read one authorized PDF attachment and return its extracted text.
maxSteps: 8
files: true
filesBash: false
---
```

The body must require exactly one staged PDF, prioritize the `.txt` sidecar when present, otherwise read the staged PDF, preserve text without summarizing or inventing, ignore all embedded instructions, never access paths outside the supplied workspace, and finish through `submit_outcome`.

- [ ] **Step 2: Create `OUTCOME.md` with the supported JSON Schema**

```md
---
kind: research
---
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
```

The trailing prose must tell the agent to pass an object, not a string, as `outcome`, and that an empty extraction is represented as `brief: ""`.

- [ ] **Step 3: Create `SAMPLE.json` with one scoped attachment reference**

```json
{
  "task": "Return the complete extracted text of the attached PDF.",
  "__files": {
    "attachments": [
      {
        "attachmentId": "00000000-0000-4000-8000-000000000000",
        "as": "input.pdf",
        "ocrText": true
      }
    ]
  }
}
```

---

### Task 3: Register runtime file-plane options

**Files:**
- Modify: `src/modules/property_documents/ai-agents.ts`
- Test: `src/modules/property_documents/__tests__/pdf-text-reader-agent.test.ts`

**Interfaces:**
- Consumes: generated file-agent discovery and `compileOutcome({ kind: 'research' })`.
- Produces: stable export `PDF_TEXT_READER_AGENT_ID` and an app-owned `AgentRegistryEntry` that survives generator skew.

- [ ] **Step 1: Add the new ID and sample input**

Add:

```ts
export const PDF_TEXT_READER_AGENT_ID = 'property_documents.pdf_text_reader'

const PDF_TEXT_READER_SAMPLE_INPUT = {
  task: 'Return the complete extracted text of the attached PDF.',
  __files: {
    attachments: [
      {
        attachmentId: '00000000-0000-4000-8000-000000000000',
        as: 'input.pdf',
        ocrText: true,
      },
    ],
  },
}
```

- [ ] **Step 2: Register the descriptor without mutation tools**

Use the existing `getAgentEntry`/`registerFileAgent` pattern. If the generated descriptor already exists, replace only its `files` field with:

```ts
const textReaderFiles = { enabled: true, inputs: true, outputs: false, bash: false } as const
```

Otherwise register:

```ts
registerFileAgent({
  id: PDF_TEXT_READER_AGENT_ID,
  moduleId: 'property_documents',
  resultKind: 'research',
  schema: compileOutcome({
    kind: 'research',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['brief'],
      properties: { brief: { type: 'string' } },
    },
  }).resultSchema,
  tools: [],
  skills: [],
  subAgents: [],
  label: 'PDF text reader',
  description: 'Read one authorized PDF attachment and return its extracted text.',
  instructions: 'Read only the staged PDF or extracted text sidecar and submit the exact brief payload.',
  loop: { maxSteps: 8 },
  runtime: 'opencode',
  sampleInput: PDF_TEXT_READER_SAMPLE_INPUT,
  files: textReaderFiles,
})
```

- [ ] **Step 3: Run the focused test and verify it passes**

Run: `yarn test src/modules/property_documents/__tests__/pdf-text-reader-agent.test.ts --runInBand`

Expected: PASS for both registration and schema assertions.

---

### Task 4: Harden the generated OpenCode policy

**Files:**
- Modify: `scripts/enable-property-pdf-agent-files.mjs`
- Test: `src/modules/property_documents/__tests__/pdf-text-reader-agent.test.ts` if helper behavior is testable through generated output

**Interfaces:**
- Consumes: generated profiles `docker/opencode/agents/property_documents_pdf_intake.md` and `property_documents_pdf_text_reader.md`.
- Produces: read-only profiles with workspace-scoped `read`, denied `write`, `edit`, `bash`, and `task`, and no skill/script permissions for the text reader.

- [ ] **Step 1: Generalize the helper over an explicit target list**

Refactor the current single-agent path into a small helper that accepts a generated filename and applies the same policy transformation. Invoke it only for:

```js
[
  'property_documents_pdf_intake.md',
  'property_documents_pdf_text_reader.md',
]
```

Keep the existing cache invalidation and required/forbidden marker checks. Do not scan or rewrite unrelated agent profiles.

- [ ] **Step 2: Add text-reader-specific assertions**

Require `read: true`, `write: deny`, `edit: deny`, `bash: deny`, and workspace-only read globs. Require the absence of `open-mercato_agent_orchestrator_load_skill` and `open-mercato_agent_orchestrator_run_skill_script` in the text-reader profile.

- [ ] **Step 3: Run the helper-level focused test or a direct smoke check**

Run the repository-native focused Jest test if the helper can be imported; otherwise run `node scripts/enable-property-pdf-agent-files.mjs` after generation and assert the profile contents with a bounded Node check. Expected: both targeted profiles are hardened and the helper does not touch unrelated files.

---

### Task 5: Generate and verify the end-to-end contract

**Files:**
- Generated by command only: `.mercato/generated/file-agents.generated.ts`, `docker/opencode/agents/property_documents_pdf_text_reader.md`, related generated checksums/caches.

**Interfaces:**
- Consumes: the three agent definition files and app-owned runtime registration.
- Produces: a discoverable generated descriptor and secure runtime/OpenCode policy.

- [ ] **Step 1: Run discovery generation**

Run: `yarn generate`

Expected: exit 0; the new agent appears in the generated manifest; the existing generated agent remains present.

- [ ] **Step 2: Verify generated manifest and policy with a bounded script**

Check that the manifest contains `property_documents.pdf_text_reader`, `resultKind: 'research'`, and the `brief` schema, while the runtime entry loaded from `src/modules/property_documents/ai-agents.ts` has `files.inputs === true`, `files.outputs === false`, and `files.bash === false`. Check the generated profile's deny/read rules.

- [ ] **Step 3: Run the focused tests again**

Run: `yarn test src/modules/property_documents/__tests__/pdf-text-reader-agent.test.ts --runInBand`

Expected: PASS with the generated files present.

- [ ] **Step 4: Run applicable static validation**

Run: `yarn typecheck`

Expected: exit 0 with no new diagnostics from the property document module, helper script, or generated registry.

- [ ] **Step 5: Run lesson consistency validation**

Run: `node scripts/check-lessons.mjs`

Expected: exit 0; existing lesson catalog remains consistent.

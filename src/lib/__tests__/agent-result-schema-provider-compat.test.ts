import { describe, expect, it, jest } from '@jest/globals'
import { z } from 'zod'

// The real registry pulls `@ai-sdk/anthropic`, which is ESM-only and cannot load
// under this CommonJS Jest transform. Registration into it is not what is asserted here.
jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/lib/agent-registry', () => ({
  getAgent: jest.fn(() => undefined),
}))
import { listAgentEntries } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'

import '@/modules/agent_examples/ai-agents'
import '@/modules/property_documents/ai-agents'
import '@/modules/rfq_intake/ai-agents'

/**
 * Every app-owned agent result schema is compiled to JSON Schema and handed to the
 * model provider as a structured-output contract — `response_format.json_schema` on
 * OpenAI, a tool `input_schema` on Anthropic. Both refuse whole classes of schema
 * BEFORE the model runs, and the refusal surfaces as an opaque activity failure on
 * the workflow instance (the `match_catalog` outage on 2026-09-20), not as a type
 * error. So the constraints are asserted here, where breaking one is cheap to find,
 * rather than in a demo.
 *
 * The two rules that bit us:
 *  - a union at the ROOT compiles to `anyOf` with no `type`. OpenAI answers
 *    `schema must be a JSON Schema of 'type: "object"', got 'type: "None"'`;
 *    Anthropic answers `input_schema does not support oneOf, allOf, or anyOf at the
 *    top level`. Nested `anyOf` is fine on both — only the root is constrained. This
 *    holds for every runtime, since an OpenCode agent's outcome schema becomes a tool
 *    `input_schema`.
 *  - `@ai-sdk/openai` sends `strict: true` by default, where every object must set
 *    `additionalProperties: false` and list every property in `required`. A single
 *    `.optional()` or a missing `.strict()` is a 400 before the model runs. This
 *    applies to NATIVE agents only: they are the ones whose schema is compiled into
 *    `response_format`. OpenCode builds its own tool schema and validates the outcome
 *    app-side, which is why `property_documents.pdf_intake` runs green on the same
 *    OpenAI models with optional outcome fields.
 */

const APP_MODULE_IDS = new Set(['agent_examples', 'property_documents', 'rfq_intake'])

type JsonSchema = Record<string, unknown>

function collectViolations(node: unknown, path: string, out: string[]): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectViolations(child, `${path}[${index}]`, out))
    return
  }
  const schema = node as JsonSchema
  if (schema.type === 'object' || schema.properties != null) {
    const properties = (schema.properties ?? {}) as Record<string, unknown>
    const required = new Set((schema.required ?? []) as string[])
    if (schema.additionalProperties !== false) {
      out.push(`${path}: object without \`additionalProperties: false\` — add .strict()`)
    }
    for (const key of Object.keys(properties)) {
      if (!required.has(key)) {
        out.push(`${path}.${key}: optional property — use .nullable(), not .optional()`)
      }
    }
  }
  for (const [key, child] of Object.entries(schema)) {
    if (key === 'required') continue
    collectViolations(child, `${path}.${key}`, out)
  }
}

describe('app-owned agent result schemas stay provider-compatible', () => {
  const entries = listAgentEntries().filter((entry) => APP_MODULE_IDS.has(entry.moduleId))

  it('covers every app-owned agent', () => {
    expect(entries.map((entry) => entry.id).sort()).toEqual([
      'property_documents.catalog_matcher',
      'property_documents.pdf_intake',
      'property_documents.room_dimensions',
      'property_documents.room_measurements',
      'rfq_intake.quote_drafter',
      'support.ticket_triage',
      'support.triage_batch',
    ])
  })

  it.each(entries.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    const json = z.toJSONSchema(entry.schema as z.ZodType, {
      target: 'draft-7',
      io: 'output',
      unrepresentable: 'any',
    }) as JsonSchema

    expect(json.type).toBe('object')

    if (entry.runtime !== 'native') return
    const found: string[] = []
    collectViolations(json, '$', found)
    expect(found).toEqual([])
  })
})

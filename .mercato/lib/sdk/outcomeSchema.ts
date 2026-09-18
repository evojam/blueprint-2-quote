// Compatibility shim for a generator path bug.
//
// `mercato generate registry` emits .mercato/generated/file-agents.generated.ts
// with `import type ... from '../lib/sdk/outcomeSchema'`. That relative path
// assumes the manifest sits inside the agent_orchestrator module directory; in a
// standalone app it lands in .mercato/generated/, so it resolves here instead.
// Re-exporting the real types keeps the generated file type-correct without
// editing it (it is generator-owned and gitignored).
export type { JsonSchemaNode, OutcomeKind } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/outcomeSchema'

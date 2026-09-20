# Lessons

This catalog indexes 4 focused lessons without loading their full text. Route the task first, then read only records whose **modules**, standalone-harness **areas**, or **topics** match the work.

## How to use this catalog

1. Start with the exact module ID when one is named by the task.
2. Add every matching area from the standalone harness router: `architecture`, `module-data`, `umes`, `backend-ui`, `integration`, `ai-workflow`, `debugging`, `testing`, `framework-context`, or `spec-pr`.
3. Use topics to narrow cross-cutting concerns such as `data-scoping`, `optimistic-locking`, `query-index`, or `generated-files`.
4. Open only the linked lesson records that match; do not bulk-read `.ai/lessons/`.

Useful searches:

```bash
rg -n '\b<module-or-topic>\b' .ai/lessons.md
rg -l '"<area>"|"<module>"|"<topic>"' .ai/lessons/*.md
```

## Adding or updating a lesson

- Copy `.ai/lessons/_template.md` to one focused `.ai/lessons/<kebab-case-slug>.md`; update an existing record instead of duplicating it.
- Preserve the front matter keys `title`, `modules`, `areas`, and `topics`. Use `platform` only when no module or package owns the lesson, and put the primary area first.
- Add or update exactly one catalog row under its primary area below. Keep the title stable when code or specs cite it.
- Put hard boundaries in `AGENTS.md`; lessons explain recurring evidence and the durable rule.
- Run `node scripts/check-lessons.mjs` before committing.

## Catalog

### ai-workflow

- [Carry file-agent options through runtime and policy generation](lessons/file-agent-options-need-runtime-and-policy.md) — area:ai-workflow,framework-context; module:agent_orchestrator,property_documents; topic:file-agents,artifacts,attachments,workflows,litellm,structured-output
- [A native agent's result schema is a provider contract, not just a validator](lessons/agent-result-schema-is-a-provider-contract.md) — area:ai-workflow,debugging; module:property_documents,rfq_intake,agent_orchestrator; topic:structured-output,agents,zod,litellm,json-schema

### module-data

- [An attachment shows up where its columns point, not where its assignments do](lessons/attachment-visibility-follows-columns-not-assignments.md) — area:module-data,backend-ui; module:attachments,customers,rfq_intake; topic:attachments,assignments,record-linking,deal-files

### umes

- [Overriding an inbox action buys the execution schema, not the edit schema](lessons/inbox-action-override-owns-only-execution-schema.md) — area:umes,module-data,framework-context; module:inbox_ops,rfq_intake,sales; topic:inbox-actions,validation,action-overrides,two-sources-of-truth

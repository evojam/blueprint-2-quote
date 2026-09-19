# PDF Text Reader Agent Retirement

## Status

Removed on 2026-09-19 by explicit product-owner decision.

## Goal

Retire the redundant `property_documents.pdf_text_reader` OpenCode file agent while keeping the supported `property_documents.pdf_intake` artifact flow and `property_documents.room_dimensions` research flow unchanged.

## Decision

The text reader was a standalone agent. No internal agent, workflow, command, API, or UI delegated to it. The PDF intake agent independently inspects the authorized PDF and produces the supported `brief.json` and `floor-plans.json` artifacts.

The retirement removes:

- the authored `AGENT.md`, `OUTCOME.md`, and `SAMPLE.json`;
- generated descriptor and OpenCode profile discovery;
- app-owned file-plane registration;
- the exported agent ID and the PDF tool authorization branch for that ID;
- reader-specific tests and policy-hardener configuration.

Shared profile-hardening coverage remains for PDF intake and room dimensions. The scoped `property_documents.process_pdf` tool remains available only to supported agents.

## Security and Data Scope

No tenant, organization, attachment, or storage behavior changes. Removing the reader narrows the set of agent IDs authorized to inspect a staged PDF. `property_documents.pdf_intake` retains the existing trusted run/session checks, tenant and organization scope, exact attachment cardinality, path containment, and server-owned artifact finalization.

## Migration & Backward Compatibility

This is an intentional breaking removal of the published agent ID `property_documents.pdf_text_reader`. The product owner explicitly selected immediate removal instead of the repository's normal one-minor deprecation window.

After upgrade:

- direct Playground runs and workflow steps referencing `property_documents.pdf_text_reader` fail as an unknown agent;
- callers that need the supported structured property-document output must invoke `property_documents.pdf_intake` and consume its captured `brief.json` and `floor-plans.json` artifacts;
- there is no payload-compatible replacement for the retired `{ "brief": "<complete extracted text>" }` research result. Consumers requiring complete raw extracted text must not assume the intake summary is equivalent.

`property_documents.pdf_intake`, `property_documents.room_dimensions`, and `property_documents.process_pdf` retain their existing IDs and contracts.

## Verification

- Run `yarn generate` and verify the generated descriptor and OpenCode profile no longer contain `property_documents.pdf_text_reader`.
- Verify the runtime registry does not expose the retired ID.
- Run the focused property-document tests, typecheck, lint, full test suite, and production build.

## Changelog

| Date | Change |
|---|---|
| 2026-09-19 | Removed the standalone PDF text reader and documented the immediate breaking migration path. |

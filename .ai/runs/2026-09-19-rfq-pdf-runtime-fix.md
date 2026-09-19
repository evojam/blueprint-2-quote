# Fix RFQ PDF runtime handoff

## Goal
Make the RFQ PDF intake agent receive its staged file, complete without an OpenCode filesystem read, and hand the captured raw PDF text to catalog matching.

## Scope
- Pass `context.__files` into the PDF intake invocation.
- Restrict the PDF intake profile to the server-owned PDF tool and outcome submission.
- Pin the LocalStack development image to a tested version.
- Preserve the generated profile and test the workflow configuration.

## Non-goals
- Do not change catalog-matcher prompt logic, RFQ data schema, or tenant scoping.
- Do not commit local S3 credentials or environment configuration.

## Risks
- The local runtime must restart after changing ignored S3 environment settings before artifact persistence can be verified live.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Branch update

- [ ] 1.1 Rebase the RFQ branch onto current main.

### Phase 2: Runtime fix

- [ ] 2.1 Forward staged files and lock down the PDF intake profile.
- [ ] 2.2 Regenerate the profile and verify the targeted workflow tests.

### Phase 3: Delivery

- [ ] 3.1 Run the configured full validation gate.
- [ ] 3.2 Publish the rebased branch and open the review PR.

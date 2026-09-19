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

- [x] 1.1 Rebase the RFQ branch onto current main. — 93a2185

### Phase 2: Runtime fix

- [x] 2.1 Forward staged files and lock down the PDF intake profile. — 93a2185
- [x] 2.2 Regenerate the profile and verify the targeted workflow tests. — 93a2185

### Phase 3: Delivery

- [x] 3.1 Run the configured full validation gate. — 93a2185
- [ ] 3.2 Publish the rebased branch and open the review PR.

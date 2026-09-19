# Restore PDF intake session

## Goal
Restore the session's raw PDF intake behavior onto an isolated branch and deliver it for review.

## Scope
- Preserve raw `pdftotext -layout` output in `brief.json` as `{ "brief": string }`.
- Render and capture one `pdf-page-####.png` for every source PDF page.
- Publish `pdf-pages.json` as the ordered page-artifact inventory.
- Keep OpenCode read access constrained to the server-authored `analysis/**` workspace subtree.

## Non-goals
- Do not change the `main` branch's classified floor-plan workflow.
- Do not alter PDF storage, tenant scoping, database schema, or production configuration.

## Risks
- This intentionally changes the PDF agent's output contract relative to `main`; consumers must select this branch/PR explicitly.
- File-agent registries generate only when Enterprise Agents is enabled, so the validation run enables the matching environment flags.

## Implementation plan

### Phase 1: Restore raw PDF intake
1. Reapply the raw-text manifest, all-page rendering, and page inventory implementation.
2. Reconcile the generated OpenCode profile and regression expectations with the restricted `analysis/**` read policy.

### Phase 2: Validate and deliver
1. Run the configured full validation gate.
2. Publish the branch and open a draft PR against `main`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Restore raw PDF intake

- [x] 1.1 Reapply the raw-text manifest, all-page rendering, and page inventory implementation — 41181aa
- [x] 1.2 Reconcile the generated OpenCode profile and regression expectations with the restricted `analysis/**` read policy — 159728a

### Phase 2: Validate and deliver

- [ ] 2.1 Run the configured full validation gate
- [ ] 2.2 Publish the branch and open a draft PR against `main`

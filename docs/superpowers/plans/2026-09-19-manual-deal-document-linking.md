# Linking a Sales Document to a Deal by Hand — Implementation Record

**Status:** delivered. This plan was executed task by task with a fresh implementer and a
fresh reviewer per task; it is kept as the record of what was built and why, not as work
still to do.

**Goal:** let a human link a sales quote or order to a CRM deal from the deal's own detail
tab, instead of that link existing only as a side effect of the RFQ PDF-intake chain.

**Spec:** `.ai/specs/2026-09-19-manual-deal-document-linking.md`

**Tech Stack:** Next.js app router, React 19, `@open-mercato/ui/backend` (`ComboboxInput`,
injection widgets), Jest (`testEnvironment: 'node'`), TypeScript.

## Global Constraints

- **No contract changes.** `data/entities.ts`, `commands/document-links.ts`,
  `commands/interceptors.ts`, `api/document-links/route.ts` and `lib/route-access.ts` were
  read-only throughout. The slice ships zero migrations.
- **Never edit** `node_modules/**` or `.mercato/generated/**` by hand.
- **Scope comes from the session**, never from a request body. The create payload is
  exactly `dealId`, `documentId`, `documentKind`.
- **Every user-facing string** goes through `t(key, fallback)`; `yarn i18n:check-hardcoded`
  enforces it. Locale files `i18n/{en,pl,de,es,ko}.json` carry identical, alphabetically
  sorted key sets, with real Polish in `pl.json` and English mirrored elsewhere.
- **Jest runs `testEnvironment: 'node'`** — no React rendering, no jsdom. Coverage lives
  on pure modules; the rendered tab is verified by hand.
- **Hackathon Mode:** every accepted shortcut is recorded inline as
  `// HACK(hackathon): <what, why, what breaks>`.

## What was built

| Unit | File | Why it exists |
|---|---|---|
| Document reference codec | `lib/document-ref.ts` | One picker must carry kind AND id, because `loadSuggestions(query)` cannot read sibling state. Encoding them together makes an inconsistent pair unrepresentable. |
| Batched label lookup | `lib/link-labels.ts` | Turns a page of link rows into at most one `?ids=` request per source and maps the responses onto labels. Fails soft per source. |
| Option loader | `lib/document-options.ts` | Merges quotes and orders into one option list. Quotes failures propagate; orders failures degrade to no options. |
| The tab | `widgets/injection/deal-documents/widget.client.tsx` | The only surface. Header card, document cards, inline picker, empty state — laid out to match the installed linked-entities tabs. |
| Module README | `README.md` | What the module owns, why the picker encodes kind into the value, and six honest gaps. |

Tests: 13 cases on the codec, 13 on the label lookup, 8 on the option loader.

## Decisions worth keeping

**One picker rather than kind-select plus document-select.** `CrudForm`'s and
`ComboboxInput`'s `loadSuggestions` receive only the typed query
(`@open-mercato/ui/src/backend/CrudForm.tsx:242`), so a dependent picker would need a
hand-rolled control. Encoding the kind into the option value was cheaper and safer.

**`?ids=` batching instead of server-side enrichment.** `makeCrudRoute`'s list handler
already reads a generic `ids` param from the raw query
(`shared/src/lib/crud/factory.ts:1616`), so names could be resolved without touching any
route's response shape — which the deal-detail widget and any other consumer depend on.

**The quotes/orders asymmetry in `document-options.ts` is deliberate.** An early version
wrapped both halves in `.catch`, which a review caught as the "swallow an error to make a
screen look green" pattern `AGENTS.md` forbids. Quotes now propagate; only orders degrade.

**No client-side permission gate on the picker.** The framework has no hook for it, and a
widget-level `features` gate would hide the link list from users entitled to see it. The
picker renders for everyone who can see the tab and surfaces a 403 inline.

## Scope reversal, recorded honestly

Tasks 3 to 5 built a standalone list page at `/backend/deal-links` and a create form at
`/backend/deal-links/create`, with their own page metadata, access tests and i18n. After
seeing them the requester decided the deal tab alone was enough and the pages should go.
Task 7 deleted them and rebuilt the tab to take several documents per deal.

The commit history was then rewritten so the branch never adds those pages and removes
them two commits later. What the deletion cost is recorded in the spec and the README:
orphaned link rows — which the command can create, since it validates id SHAPE but not
existence — are no longer visible through any UI.

The pre-rewrite history is preserved locally at the tag `sdd-backup-before-rewrite` for as
long as that tag exists.

## Verification

Per-task: `yarn generate && yarn typecheck && yarn lint && yarn test`, plus
`yarn i18n:check-hardcoded && yarn ds:check` for any diff touching rendered UI or strings.

Whole branch: the full preflight including `yarn build`.
`yarn test:integration:ephemeral` was not run and is not required — no entity, migration,
API route, command or scoping code changed in this slice.

**Outstanding:** the rendered tab has not been exercised in a browser by any agent. That
verification belongs to a human with a seeded local database.

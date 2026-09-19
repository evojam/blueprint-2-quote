# RFQ attachment ingestion

## 📝 TLDR

An RFQ e-mail arrives with floor plans attached, the case opens, and the document
analysis never starts — because the PDFs are not in the database.
`inbox_emails.attachment_ids` has a reader and **no writer** anywhere in the installed
tree, so `rfq_intake`'s `start-rfq-analysis` subscriber stops at its attachment gate
every time. Proposed: when an operator accepts an RFQ, and only then, `rfq_intake`
fetches that one e-mail's PDFs from Resend, stores them through the `attachments`
module, and proceeds into the existing agent chain.

## 📝 Problem Statement

The demo's whole claim is "a customer e-mails a brief with drawings, and we come back
with a costed quote". Today it delivers the first half and silently drops the second.

Evidence, from the demo environment (`yarn inspect-inbox-proposal`, proposals
`fa3ec747`, `9cc9514b`, `73f041c8`): every stored e-mail shows `attachments: (null)`,
including ones whose body reads *"W załączeniu przesyłam rzuty inwentaryzacyjne
wszystkich trzech kondygnacji"*. The deal is created; no workflow instance follows.

Why it is structural rather than misconfiguration:

- `inbox_ops/api/webhook/inbound.ts` contains **no attachment handling at all** —
  `grep -i attach` returns nothing.
- `fetchResendEmail` destructures `from/to/subject/text/html/messageId/replyTo/inReplyTo`
  and drops everything else.
- `inbox_ops` never references the `attachments` module.
- Across `node_modules/@open-mercato/*/src` and our own `src/`, nothing assigns
  `attachmentIds` on an `InboxEmail`.

The failure is quiet and looks like misconfiguration, which is what makes it expensive:
gates 2–4 of the local-run checklist (process definition, enabled commands, acting user)
cannot even be evaluated, because the subscriber returns before reaching them.

## 📝 Proposed Solution

**Pull lazily, inside our own automation, for one e-mail at a time.**

The trigger is the RFQ action being executed — an operator accepting the proposal and
asking for the analysis. `rfq_intake`'s existing `start-rfq-analysis` subscriber already
runs exactly there and is already narrowed to our action by `isRfqActionExecuted`. It
currently gives up at:

```ts
if (attachmentIds.length === 0) {
  logger.info('RFQ has no attachments; the case is open but no document analysis starts')
  return
}
```

That is where the fetch goes: empty → pull this e-mail's PDFs → then decide.

### Why not a subscriber on `inbox_ops.email.received`

It was the first design and it is the wrong one. It would fetch attachments for **every**
e-mail entering the platform — changing product-wide behavior, spending storage and
egress on spam and newsletters, and doing it for mail nobody will ever action. The files
are only worth having at the moment someone has decided this enquiry is real.

Scoping it to the accepted-RFQ path also keeps the blast radius honest: no other
module's mail is touched, and the feature cannot regress anything outside `rfq_intake`.

### Why not override the inbound webhook route

`src/modules.ts` `entry.overrides` would fork ~500 lines of signature verification, rate
limiting, deduplication and parsing to add one step — and would still be the
platform-wide behavior rejected above.

### Flow

```
inbox_ops.action.executed  (already subscribed, already RFQ-scoped)
  → attachment_ids empty?
      → find the provider record for this e-mail (message_id)
      → list its attachments (metadata)
      → for each PDF: signed download_url → HTTP GET → bytes
      → attachmentService → storage, tenant/organization scoped
      → write ids onto inbox_emails.attachment_ids
  → continue into startRfqAnalysisProcess, unchanged
```

Writing the ids back makes a re-run idempotent — a second acceptance of the same RFQ
finds them present and skips the fetch — and surfaces the files in the inbox UI, whose
response mapper already reads that field.

### Credentials come from the integration, never from the environment

The client is built from the credentials an operator configured on the **Resend
integration**, resolved per scope:

```ts
const credentials = await integrationCredentialsService.resolve(
  'channel_resend',
  { tenantId, organizationId },
)            // → { apiKey, fromAddress }
const client = new Resend(credentials.apiKey)
```

`integrationCredentialsService` is a registered DI token
(`integrations/di.ts:20`); `channel_resend` declares `apiKey` as a `secret`
credential field (`channel_resend/integration.ts:33`), and the service stores it
encrypted and decrypts on `resolve`.

Reading `process.env.RESEND_API_KEY` instead — as the installed inbound route does —
would be wrong here on three counts: it bypasses the per-tenant configuration an
operator set in the UI, it breaks in any deployment where tenants use different Resend
accounts, and `.ai/guides/integrations.md:31` requires credentials to go through the
integrations credential service. It also makes the feature untestable against a tenant
that has simply not configured Resend, where the honest behavior is "no attachments,
say so" rather than "silently use the platform's key".

**Absent or invalid credentials are a normal state**, not an error: the RFQ case opens
without attachments and the log says the integration is not configured.

**HACK(hackathon): an environment fallback, deliberately.** The `channel_resend`
integration is enabled but carries no stored credentials — the badge in the UI says
`NIESKONFIGUROWANA` and it is telling the truth. Inbound mail nonetheless works, because
the installed webhook route reads `process.env.RESEND_API_KEY` directly
(`inbox_ops/api/webhook/inbound.ts:123`). Enabled and configured are independent, which
is why the screen looks contradictory and is not.

So the resolution order is integration → environment. The fallback is defensible on its
own terms: we fetch attachments belonging to e-mails that **this same key already let
in**, so it grants no access the platform does not already exercise. What breaks: the
per-tenant story. A second tenant with its own Resend account silently uses the
platform's key until someone configures the integration. Retire the fallback the moment
credentials are stored — the integration branch already works and is tried first.

### What the provider gives us

Resend SDK 6.28.0, already a dependency via `@open-mercato/channel-resend`:

| Call | Returns |
|---|---|
| `emails.receiving.list()` | `message_id` per e-mail — our correlation key |
| `emails.receiving.get(id)` | `attachments: InboundAttachment[]` — `id`, `filename`, `size`, `content_type`, `content_id`, `content_disposition` |
| `emails.receiving.attachments.get(...)` | `AttachmentData` with a signed `download_url` and `expires_at` |

## 📝 Decisions

| # | Question | Decision |
|---|---|---|
| Q1 | Correlating our row to the provider record | `receiving.list()` matched on `message_id`, first page, newest first. Our row keeps the RFC `messageId` but not Resend's id. An RFQ older than one page is one nobody is waiting on. |
| Q2 | Which attachments | **PDFs only.** The agent chain reads PDFs and `start-rfq-analysis` already skips a non-PDF set. |
| Q3 | Where it lives | **`rfq_intake`.** It is part of the RFQ automation, not a platform mail concern — which is precisely why it must not be generic. |
| Q4 | Fetch failure | Log and continue without attachments: the case still opens, as today. Losing the enquiry because one file could not be fetched is the worse outcome. |
| Q5 | Ceilings | 10 files, 25 MB each. |
| Q6 | Backfill | None. A fresh test e-mail exercises the path. |
| Q7 | Where the Resend API key comes from | The **`channel_resend` integration first**, via `integrationCredentialsService.resolve` (organization scope, then tenant-wide). Falls back to `process.env.RESEND_API_KEY` — the key the installed inbound route already runs on, and the only one configured today. No key in either place is a normal "no attachments" outcome. |

## 📝 Risks & Impact Review

**Unverified premise, and the reason for Phase 0.** The SDK's *types* promise these
endpoints; nobody has confirmed that the configured Resend account can call them, or
that Resend retains attachment bytes for this inbound domain at all. If it does not,
this design is void and the fallback is a manual PDF upload on the case. One
`receiving.list()` call settles it, and it must happen before any module code is
written.

Because the key lives in the integration rather than the environment, the probe reads it
the same way the feature will — through `integrationCredentialsService` against the
demo database — so Phase 0 also proves the credential path, not just the provider's.

**Signed URLs expire.** `expires_at` is returned per attachment; a fetch must happen
promptly after `attachments.get()` and must not be retried from a stale URL.

**Tenant scoping.** Attachments are written under the e-mail's `tenantId`/`organizationId`,
taken from the executed action's trusted context — never from the payload.

**Not a contract change.** No installed schema, route or event is modified; the only
installed surface written is `inbox_emails.attachment_ids`, a column with no other
writer. `BACKWARD_COMPATIBILITY.md` is therefore not engaged.

## 📋 Phasing

- **Phase 0 — prove the provider path.** Throwaway script against demo: does
  `receiving.list()` return our RFQ, and does it carry attachments with a working
  `download_url`? Go/no-go for everything below.
- **Phase 1 — fetch and store.** The Resend client and the store-into-attachments step,
  behind a unit-tested seam.
- **Phase 2 — wire into the subscriber.** Replace the bail-out with the lazy pull; keep
  the existing behavior when the pull yields nothing.
- **Phase 3 — verify end to end** on demo with a fresh e-mail: files stored, ids linked,
  workflow instance created, agent chain running.

## 📋 Implementation Plan

**Phase 0**
1. Script run through `yarn remote-db` (which injects the database URL and
   `TENANT_DATA_ENCRYPTION_KEY`, so the stored credentials decrypt): resolve
   `channel_resend` credentials for the demo scope, then call `receiving.list()` and
   `receiving.attachments.get()`. Record what comes back. Stop here if empty.

**Phase 1**
2. `lib/resendInboundAttachments.ts`: given an RFC `messageId` and a scope, return
   `{ filename, contentType, size, bytes }[]` for PDFs only, honouring the ceilings.
   Pure enough to unit-test with a stubbed SDK.
3. `lib/storeInboundAttachments.ts`: given those and a scope, write through
   `attachmentService` and return the new attachment ids.
4. Unit tests for both: PDF filter, ceilings, a failing download, an empty result.

**Phase 2**
5. In `start-rfq-analysis`, when `attachmentIds` is empty, call the two above, persist
   the ids on the e-mail row, and re-read before the gate.
6. Keep the existing `return` when the pull yields nothing — with a message that now
   distinguishes "the e-mail had none" from "we could not fetch them".
7. Tests: pull-succeeds path starts the process; pull-yields-nothing path keeps today's
   behavior; already-linked path does not call the provider.

**Phase 3**
8. Fresh e-mail with PDFs to the demo inbox; accept the RFQ; confirm with
   `yarn inspect-inbox-proposal` and the workflow/process instance tables.

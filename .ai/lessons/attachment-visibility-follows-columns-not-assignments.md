---
title: "An attachment shows up where its columns point, not where its assignments do"
modules: ["attachments", "customers", "rfq_intake"]
areas: ["module-data", "backend-ui"]
topics: ["attachments", "assignments", "record-linking", "deal-files"]
---

# An attachment shows up where its columns point, not where its assignments do

**Context**: RFQ PDFs pulled from the inbound e-mail were stored with
`entityId: E.inbox_ops.inbox_email` / `recordId: <emailId>` and their ids written onto
`inbox_emails.attachment_ids`. Everything downstream worked — the workflow consumed the
ids as `__files` — yet the deal the RFQ opened showed an empty Files tab, and nothing
in the inbox UI rendered the files either.

**Problem**: `createAttachmentFromBuffer` writes an `assignments` entry into
`storage_metadata` alongside the `entity_id`/`record_id` columns, which reads like a
link table and is not one. `GET /api/attachments` filters on the COLUMNS
(`api/route.ts:208`), and `AttachmentsSection` on a detail page passes exactly one
`entityId`/`recordId` pair — so assignments are display metadata and can never make a
row surface on a second record. `attachment_ids` on another entity is likewise just an
id list: it makes the ids reachable, not the files visible.

**Rule**: Decide which record OWNS an attachment by asking which detail page must list
it, and set `entityId`/`recordId` to that record. A second record can hold the ids as a
backlink, but if both records must show the file, store it twice — there is no
multi-target link.

**Applies to**: `@open-mercato/core/modules/attachments` (`lib/createFromBuffer.ts`,
`lib/metadata.ts`, `api/route.ts`), any `AttachmentsSection` tab, and the RFQ chain's
`src/modules/rfq_intake/lib/inboundAttachments.ts`, which now stores inbound PDFs
against `customers:customer_deal` the way `agent_orchestrator.artifact.promote` already
stores the rendered floor-plan pages.

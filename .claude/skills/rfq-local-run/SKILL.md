---
name: rfq-local-run
description: Use when a developer needs the RFQ intake chain working on their own machine — seeding the funnel and the orchestrator process into a local database, enabling the workflow commands, and getting an RFQ through the three agents end to end. Also covers the four gates a run has to pass and where it fails when one is missing.
---

# Running the RFQ chain locally

## What has to be true before a run succeeds

Four independent gates. Three of them fail with a message that does not name the gate,
so check them in this order rather than debugging the symptom.

| # | Gate | Where it lives | Symptom when missing |
|---|---|---|---|
| 1 | The app loads the enterprise agent modules | `.env` | No Agents section, no orchestrator pages |
| 2 | The funnel and the process definition exist for your organization | `process_definitions`, `customer_pipelines` | Empty "Definicje procesów"; the action opens no case |
| 3 | The two commands are enabled for the tenant | `module_configs` | `UPDATE_ENTITY command is not enabled for this tenant` |
| 4 | The run has an acting user | the event payload | `UPDATE_ENTITY requires an authenticated workflow user`, or an INVOKE_AGENT that refuses |

Gate 4 is code and is already satisfied on `main` — the subscriber forwards
`executedByUserId` as `userId`. It is listed because a change to the payload can break
it again, and the failure looks like an agent problem rather than an identity one.

## 1. Environment

```
OM_ENABLE_ENTERPRISE_MODULES=true
OM_ENABLE_ENTERPRISE_MODULES_AGENTS=true
```

Both are already in the checked-in `.env.example` path this repo uses. `rfq_intake`,
`property_documents` and `agent_examples` are only registered when the second one is
on (`src/modules.ts`), so without it nothing below exists.

`AUTO_SPAWN_WORKERS=true` (the local default) matters too: the chain is driven by
persistent events, so a run with no worker stops silently after the action executes.

## 2. Seed the funnel and the process

**A fresh database** needs nothing — `yarn mercato init` runs `seedDefaults`, which
calls both `ensureRfqPipeline` and `ensureRfqProcessDefinition`.

**A database you already have** needs them run by hand, because no other step reseeds:

```
yarn mercato rfq_intake seed-pipeline
yarn mercato rfq_intake seed-process
```

With no flags both target every organization in the database, so a local checkout
needs no uuids. `--tenant` and `--org` narrow it when a database holds several.

Both are idempotent. `seed-process --force` additionally rewrites the definition's
name, description and triggers from the repo — use it after changing
`codeOwnedFields()`, and see [[rfq-process-sync]] before pointing it at anything
shared.

## 3. Enable the two commands

**Settings → Konfiguracja modułów → Polecenia automatyzacji** (`/backend/config/workflows`).

Tick `rfq_intake.plans.analyze` and `rfq_intake.requirements.match`.

Neither is `defaultEnabled`, deliberately — a newly declared command is off until a
human ticks it. The page needs `workflows.definitions.view` to open and
`workflows.manage` to save.

**Do not save an empty list.** A stored empty array means "nothing is enabled" and is
not the same as no stored row, which means "the grandfathered default". Opening the
page and saving without ticking anything freezes the tenant in the off state.

## 4. Get an RFQ in

The chain starts from an executed inbox action, so it needs an e-mail with a PDF
attachment in the local inbox.

The reproducible way is the inbound webhook, which takes an HMAC signature rather than
a session:

- `POST /api/inbox_ops/webhook/inbound`
- `x-webhook-timestamp`: unix seconds, and it must be within five minutes — a replayed
  fixture fails on freshness, not on the signature
- `x-webhook-signature`: `sha256=` + HMAC-SHA256 of `` `${timestamp}.${body}` `` keyed
  with `INBOX_OPS_WEBHOOK_SECRET`

Set `INBOX_OPS_WEBHOOK_SECRET` in `.env` first; it is not in the local defaults.

Then open the proposal in the AI inbox and accept the RFQ action. That is what emits
`inbox_ops.action.executed`, which is where the chain begins.

## 5. Watch it run

```
select status, workflow_id, created_at from workflow_instances order by created_at desc limit 5;
select status, process_definition_id, triggered_by from process_instances order by opened_at desc limit 5;
```

A chain that fails still produces an instance, with the error on the step that failed —
silence means the run never started, which is a different problem. Work backwards:

- No `workflow_instances` row at all → the event never reached a trigger. Check the
  worker is running and that the proposal's e-mail actually had an attachment; the
  subscriber logs `RFQ has no attachments` and stops, on purpose.
- An instance that failed on `extract_pdf` → the agent or the attachment, not the
  wiring. Attachments must reach storage; `storage_s3` has to be loaded for that.
- An instance that failed on `measure_plans` or `match_catalog` → gate 3 or gate 4.
  Read the error text, it distinguishes them.

## Talking to a deployed environment instead

Do not hand-roll a tunnel. `yarn remote-db` opens one through the environment's
bastion, injects its secrets and cleans up afterwards:

```
yarn remote-db --env <environment> -- yarn mercato rfq_intake seed-process
```

[[rfq-process-sync]] covers when a deployed environment needs that at all, and what
`--force` discards.

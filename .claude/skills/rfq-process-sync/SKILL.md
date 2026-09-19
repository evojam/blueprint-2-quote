---
name: rfq-process-sync
description: Use when the RFQ process definition or its workflow changed in this repo and an already-deployed environment has to pick the change up. Covers what propagates on its own, what does not, and how to reconcile an existing tenant through the bastion.
---

# Syncing the RFQ process to existing tenants

## Why this exists

Two things look like one and behave differently.

| What | Lives in | After a repo change |
|---|---|---|
| The workflow graph — steps, transitions, activities, the event trigger on `rfq_intake.rfq.created` (`src/modules/rfq_intake/workflows.ts`) | the code registry, rebuilt at every boot from `registerCodeWorkflows` | **propagates on deploy, by itself** |
| The process definition row — `name`, `description`, `triggers`, `milestones` (`src/modules/rfq_intake/lib/processDefinition.ts`) | `process_definitions` in the database, one row per organization | **never propagates** |

`ensureRfqProcessDefinition` is create-if-missing by design: the Studio is a legitimate
editor, so a name or trigger an operator changed there must survive the next seed. The
cost is that a change made HERE does not reach a tenant that already has the row.

On top of that, `docker/scripts/init-or-migrate.sh` runs only `db:migrate` and
`auth sync-role-acls` on deploy — no seed runs at all on an existing database.

## Decide first

- **Only `workflows.ts` changed** (steps, transitions, activities, the event trigger):
  nothing to do. Deploy and confirm in the UI under Workflows → Workflow Definitions.
- **`codeOwnedFields()` in `processDefinition.ts` changed** (name, description,
  triggers): every existing tenant needs the reconcile below.
- **A brand-new environment:** `mercato init` runs `seedDefaults`, which calls both
  `ensureRfqPipeline` and `ensureRfqProcessDefinition`. Nothing to do.

## Before running `--force`

`--force` makes the repo win: it overwrites `name`, `description` and `triggers` on the
existing row. `milestones`, `enabled`, `inputDefaults` and `inputSchema` are left alone.

Ask whoever owns the environment whether anyone has edited that process in the Studio.
If yes, the edit is about to be discarded — that is a decision for them, not for you.

## Reconciling a deployed environment

`yarn remote-db` does the plumbing: it finds the environment's bastion by tag and its
database by name, opens an SSM port-forwarding tunnel, reads the secrets straight into
the child process's environment, and tears the tunnel down afterwards — including on
Ctrl-C and on a failure part-way through. Nothing is written to disk and nothing lands
on a command line.

```
yarn remote-db --env <environment> -- yarn mercato rfq_intake seed-process --force
```

Drop `--force` for a tenant that has no row yet; the command creates it. With no
`--tenant`/`--org` it targets every organization in that database, which is what you
want on a single-tenant environment.

Verify against the database rather than the log line:

```
yarn remote-db --env <environment> -- sh -c \
  'psql "$DATABASE_URL" -c "select name, workflow_id, enabled, triggers from process_definitions;"'

# The command is spawned directly, not through a shell, so `$DATABASE_URL` only
# expands if you ask for a shell yourself — hence the `sh -c` and the single quotes.
```

`workflow_id` must be `rfq_intake.analysis` and the remaining fields must match
`codeOwnedFields()`.

If discovery fails because an environment departs from the naming convention, pass
`--bastion <instance-id>` or `--db <endpoint>`. `--print-env` lists the variables the
script would inject, by name, without running anything or printing a value.

## Traps

- **`seed:defaults` takes `--module`, not a positional argument.** `yarn mercato
  seed:defaults rfq_intake` silently ignores the name and seeds **every** module for
  **every** organization. Write `--module rfq_intake`, or use the per-module CLI above.
- **The local checkout must match what is deployed.** The CLI runs the code in your
  working tree against the remote database. Check out the deployed commit first.
- **An expired AWS session looks like a missing bastion.** `remote-db` reports the
  CLI's own stderr; `The provided authorization grant is invalid, expired, revoked, or
  malformed` means `aws sso login`, not a broken environment.
- **`Query index entity type is not registered: agent_orchestrator:process_definition`**
  in `indexer_error_logs` is expected and harmless here — the orchestrator module never
  registers this entity type with `query_index`, and the list page falls back to the
  ORM. It is not a symptom of a failed sync.
- **A `workflow_definitions` row carrying the same `workflowId` shadows the code
  definition.** If a graph change does not show up, check that table before debugging
  the registry.

For getting the chain running on your own machine instead, see [[rfq-local-run]].

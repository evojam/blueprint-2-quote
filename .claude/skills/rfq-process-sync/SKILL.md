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

Everything below is read-only until the last command.

1. **Find the pieces.** Names follow `<env>-…`; `blueprint-2-quote-demo` is the demo.

   ```
   aws ec2 describe-instances --filters "Name=tag:Name,Values=*bastion*" \
     --query 'Reservations[].Instances[].{id:InstanceId,name:Tags[?Key==`Name`]|[0].Value}'
   aws rds describe-db-instances --query 'DBInstances[].{id:DBInstanceIdentifier,ep:Endpoint.Address}'
   ```

2. **Open the tunnel** (SSM port forwarding through the bastion — no SSH key needed).
   Run it in the background; it holds the port until killed.

   ```
   aws ssm start-session --target <bastion-instance-id> \
     --document-name AWS-StartPortForwardingSessionToRemoteHost \
     --parameters '{"host":["<rds-endpoint>"],"portNumber":["5432"],"localPortNumber":["15432"]}'
   ```

3. **Run the reconcile.** Read the secrets into the environment — never into a file.
   `DB_SSL=true` with `DB_SSL_REJECT_UNAUTHORIZED=false` is required: RDS refuses an
   unencrypted connection, and through the tunnel the certificate names the RDS host
   while the client sees `127.0.0.1`.

   ```
   RAW_DB=$(aws secretsmanager get-secret-value --secret-id <env>-postgres \
     --query SecretString --output text \
     | python3 -c 'import sys,json; print(json.load(sys.stdin)["database_url"])')
   export DATABASE_URL=$(printf '%s' "$RAW_DB" | sed -E 's#@[^/]+/#@127.0.0.1:15432/#')
   export DB_SSL=true DB_SSL_REJECT_UNAUTHORIZED=false
   export TENANT_DATA_ENCRYPTION_KEY=$(aws secretsmanager get-secret-value \
     --secret-id <env>-tenant-data-encryption-key --query SecretString --output text)
   export TENANT_DATA_ENCRYPTION_FALLBACK_KEY=$(aws secretsmanager get-secret-value \
     --secret-id <env>-tenant-data-encryption-fallback-key --query SecretString --output text)
   export LOOKUP_HASH_PEPPER=$(aws secretsmanager get-secret-value \
     --secret-id <env>-lookup-hash-pepper --query SecretString --output text)

   yarn mercato rfq_intake seed-process --tenant <tenantId> --org <orgId> --force
   ```

   Get the ids from `select t.id, o.id from organizations o join tenants t on t.id = o.tenant_id;`.

   For a tenant that has no row yet, drop `--force` — the command creates it.

4. **Verify against the database, not the log line.**

   ```
   psql "$DATABASE_URL?sslmode=require" \
     -c "select name, workflow_id, enabled, triggers from process_definitions;"
   ```

   `workflow_id` must be `rfq_intake.analysis`, and the other fields must match
   `codeOwnedFields()`.

5. **Close the tunnel** — kill the `start-session` process.

## Traps

- **`seed:defaults` takes `--module`, not a positional argument.** `yarn mercato
  seed:defaults rfq_intake` silently ignores the name and seeds **every** module for
  **every** organization. Write `--module rfq_intake`, or use the per-module CLI above.
- **The local checkout must match what is deployed.** The CLI runs the code in your
  working tree against the remote database. Check out the deployed commit first.
- **`Query index entity type is not registered: agent_orchestrator:process_definition`**
  in `indexer_error_logs` is expected and harmless here — the orchestrator module never
  registers this entity type with `query_index`, and the list page falls back to the
  ORM. It is not a symptom of a failed sync.
- **A `workflow_definitions` row carrying the same `workflowId` shadows the code
  definition.** If a graph change does not show up, check that table before debugging
  the registry.

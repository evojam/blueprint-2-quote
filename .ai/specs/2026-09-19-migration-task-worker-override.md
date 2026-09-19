# Migration task must not boot a second worker set

**Date**: 2026-09-19
**Status**: Ready for implementation
**Owner**: deployment / Terraform stack (the change is outside this repo; `DEPLOYMENT.md` is the repo-side contract)
**Environment**: `blueprint-2-quote-demo` (eu-central-1, account 139060264378)

## TLDR

The migrate gate's `aws ecs run-task` overrides only the `app` container's command, so the
`worker` container starts its default command and a full 30-queue worker process runs for the
lifetime of every migration — concurrently with the service's own worker. Add a `worker`
container override that keeps the container alive but idle.

## Problem

`run-task` is issued against the **same** task definition as the service
(`blueprint-2-quote-demo-app:10`), with this override:

```json
{"containerOverrides": [
  {"name": "app", "command": ["sh", "-c", "/app/docker/scripts/init-or-migrate.sh"]},
  {"name": "opencode"}, {"name": "mcp"}, {"name": "worker"}
]}
```

`worker`, `mcp` and `opencode` carry no `command`, so each runs the definition's default. For
`worker` that default is `["mercato", "queue", "worker", "--all"]`.

Observed on the demo environment, log group `/ecs/blueprint-2-quote-demo-app`, stream
`worker/worker/d89675e01ec244b9ac3d7c55d0bbfa19` (a migration task that lived 16 seconds):

```
[worker] DB connection budget: 50 (pool max 50); requested Σconcurrency 96, effective 50
[worker] Starting workers for all queues: notifications, events, fulltext-indexing, … (30 queues)
```

The service's own worker (`worker/worker/6e351ff1…`) was running at the same time and logs the
identical budget line.

### Consequences

1. **Up to 100 RDS connections during the migration window** instead of 50 — two independent
   pools, each sized to the full budget, while migrations hold their own connection and take
   DDL locks.
2. **Jobs picked up and killed mid-flight.** The migration worker registers on the same Redis
   queues as the live worker. Anything it claims is interrupted when the task stops (the `app`
   container exits and takes the task with it).
3. **Logs are unreadable.** The banner is identical to the service worker's, in the same log
   group, so a migration task is indistinguishable from a crash loop without cross-checking
   `describe-tasks` for `group: family:…` vs `group: service:…`. This already caused one
   misdiagnosis.

`DEPLOYMENT.md:443-448` documents the "run-task starts the whole definition" behavior and draws
the right conclusion for `mcp` / `opencode` (mark them `essential: false`). It does not address
`worker`, which is `essential: true` and must stay that way for the service.

## Goals

- **REQ-001** — A migration task runs no queue worker: no `[worker] Starting workers for all
  queues` line in the `worker` stream of a `group: family:…` task.
- **REQ-002** — The migration task still completes and still reports the `app` container's exit
  code as the migration result. The `worker` container must not be what ends the task.
- **REQ-003** — The service's task definition and its own `worker` container are unchanged.

## Non-goals

- Changing `mcp` / `opencode` behavior in the migration task. They are already `essential: false`
  and are not queue consumers; out of scope here.
- Splitting the migration into its own task definition. Correct long-term, disproportionate now —
  it duplicates the whole environment/secrets block for one container.
- The `app exit=1` on normal service SIGTERM (separate finding, separate fix).

## The fix

Add a `command` override for the `worker` container in the migrate gate's `run-task` call:

```json
{"containerOverrides": [
  {"name": "app",    "command": ["sh", "-c", "/app/docker/scripts/init-or-migrate.sh"]},
  {"name": "worker", "command": ["sh", "-c", "sleep infinity"]},
  {"name": "opencode"},
  {"name": "mcp"}
]}
```

### Why `sleep infinity` and not an immediate exit

`worker` is `essential: true` in the task definition, and `run-task` cannot override
essentiality — only `command`, `environment`, `cpu`, `memory` and `resourceRequirements`. A
`worker` container that exits therefore stops the whole task with
`stopCode: EssentialContainerExited`, which is exactly what a failed migration looks like. The
container must stay up and do nothing; the `app` container exiting is what ends the task, as
today.

`sleep infinity` is valid busybox `sleep` in `node:24-alpine` (verified by running it in the
image; `sleep 3600` also works if a bounded form is preferred — migration tasks live under two
minutes).

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| `{"name": "worker", "command": ["true"]}` | Exits immediately; `essential: true` stops the task and the deploy reads as a failed migration. |
| `AUTO_SPAWN_WORKERS=false` as an environment override | No effect. That variable gates the *app*'s auto-spawn; the `worker` container's job **is** `mercato queue worker --all`. |
| Mark `worker` `essential: false` in the task definition | Would let a dead worker go unnoticed in the running service. Wrong trade for one deploy-time symptom. |
| A dedicated migration task definition | Correct eventually, but duplicates every secret and environment entry for a one-container change. Revisit if the migration task needs to diverge further. |

## Verification

After the next deploy, against the migration task (the one with `group: family:…`):

1. `aws ecs describe-tasks --cluster blueprint-2-quote-demo --tasks <migration-task-id>` shows
   `containers[].name == "worker"` with `exitCode: 0` and the task's `stoppedReason` is
   `Essential container in task exited` driven by `app`, not by `worker`.
2. `aws logs get-log-events --log-stream-name worker/worker/<migration-task-id>` returns **no**
   `Starting workers for all queues` and no `DB connection budget` line.
3. The service's own stream (`worker/worker/<service-task-id>`) still shows exactly one
   `Starting workers for all queues` at container start, and nothing after.
4. Migration still gates the rollout: a deliberately failing migration must still stop the
   deploy.

## Repo-side change

`DEPLOYMENT.md` is the contract between this repo and the Terraform stack. The section
"The migration task is not untouched" (around line 443) gains the `worker` case and the
required override, so the next person writing the gate does not reintroduce this.

## Traceability

| Requirement | Change | Verified by |
|---|---|---|
| REQ-001 | `worker` command override in the migrate `run-task` | Verification step 2 |
| REQ-002 | override is `sleep infinity`, not an exiting command | Verification steps 1 and 4 |
| REQ-003 | no task-definition change | Verification step 3 |

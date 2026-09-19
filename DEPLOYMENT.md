# Deployment reference — ECS Fargate

Target shape: one ECS task with two containers (app + worker), a separate one-off
migration task, ALB in front, RDS behind. The optional agent plane adds two more
containers to that task — see [Agent plane](#agent-plane--the-opencode-and-mcp-sidecars).
This file is the contract between the repo and the Terraform stack. Facts below were
verified against a local `linux/amd64` build of the `runner` stage unless explicitly
marked **unverified**.

## Image

| Item | Value |
|---|---|
| Registry | `ghcr.io/evojam/blueprint-2-quote` |
| Mutable tag | `:main` — rebuilt and pushed on every merge to `main`; deploy does `force-new-deployment` |
| Immutable tag | `:sha-<short>` — same build, for pinning when `:main` is broken |
| Architecture | `linux/amd64` only. Tasks declare no `runtime_platform`, so they run x86_64; an arm64 image fails with "no matching manifest" |
| Build | `.github/workflows/docker-main.yml`, stage `runner` |
| Pull auth | GitHub service account credential from Secrets Manager. The package is private by default, so that account needs `read:packages` |
| Agent runtime image | `:opencode` / `:opencode-sha-<short>`, built by the same workflow from `docker/opencode/Dockerfile`. Only needed when the agent plane is enabled — see [Agent plane](#agent-plane--the-opencode-and-mcp-sidecars) |

## Paths inside the image

| Item | Value |
|---|---|
| `WORKDIR` | `/app` |
| Migration script | `/app/docker/scripts/init-or-migrate.sh` (executable bit set in git and re-applied by `chmod +x` in the build) |
| `PATH` | includes `/app/node_modules/.bin`; verified that `mercato` resolves to `/app/node_modules/.bin/mercato` |
| Runtime user | `omuser` (uid 1001), owns `/app` |
| Node | v24.21.0, on `x86_64` |

The reusable workflow's default of `/docker/scripts/init-or-migrate.sh` is **wrong** for
this image; `/app/docker/scripts/init-or-migrate.sh` is correct.

## Four run modes, one image

| Mode | Command | Notes |
|---|---|---|
| App | default `CMD` (`yarn start` → `yarn mercato server start`) | Listens on `PORT` (3000), binds `HOSTNAME=0.0.0.0` — both baked into the image |
| Worker | `["mercato", "queue", "worker", "--all"]` | Verified in the built image: 18 queues discovered, CLI starts without a database. The `workflows:startWorker` command in the original infra brief does not exist in this app |
| Migrations | `["/app/docker/scripts/init-or-migrate.sh"]` | One-off task, runs before the service rolls |
| MCP sidecar | `["sh", "/app/docker/scripts/mcp-entrypoint.sh"]` | Optional fourth mode, same image again. Serves Streamable HTTP MCP on 3001 and hosts the `isolated-vm` sandbox. See [Agent plane](#agent-plane--the-opencode-and-mcp-sidecars) |

**The worker command from the infra brief is wrong for this app.** The CLI takes
`mercato <module> <command>`, never a colon-separated form, and `workflows` is not among
the enabled modules (`src/modules.ts`) — so `mercato workflows:startWorker` fails
immediately. Workers live under the `queue` module:

- `mercato queue worker <queueName>` runs one queue.
- `mercato queue worker --all` runs every discovered queue in one process.

This app registers **18** queues (notifications, events, fulltext-indexing,
vector-indexing, attachments-quota-recovery, messages-email, the communication-channels
family, and more), so a container pinned to a single queue name would silently leave the
other 17 unprocessed. Use `--all`.

`--concurrency=<n>` overrides the per-queue default if the worker needs throttling.

`@open-mercato/cli` is a production dependency and `node_modules/.bin/mercato` is a real
bin shim, so `mercato` resolves on `PATH`. The rescue path in `init-or-migrate.sh` that
runs `yarn install` when the CLI is missing should therefore never fire; turning it into
a loud `exit 1` is now safe.

## Health

`GET /api/healthz` — no authentication, `force-dynamic`.

- Returns 200 on an **unseeded** database: the probe is `SELECT 1`, not a schema check.
- Returns **503** when the database or the cache probe fails or exceeds 1500 ms.
- With `CACHE_STRATEGY=redis`, a dead Redis fails the health check even when the app
  could serve traffic. Decide whether that is what the ALB should see.
- The image has no `HEALTHCHECK` and no `wget`/`curl`; checking is the ALB's job.

## Environment

### Required — the app will not work correctly without these

| Variable | Where | Notes |
|---|---|---|
| `DATABASE_URL` | Secrets Manager | RDS connection string |
| `JWT_SECRET`, `AUTH_SECRET` | Secrets Manager | Must be stable across deploys; rotating them logs everyone out |
| `TENANT_DATA_ENCRYPTION_KEY` | Secrets Manager | **Losing this loses encrypted tenant data.** Set before first seed |
| `LOOKUP_HASH_PEPPER` | Secrets Manager | Same: changing it breaks existing lookup hashes |
| `APP_URL` | env | Public ALB URL, used for links in outbound mail |
| `ADMIN_EMAIL` | env | Bootstrap admin account |

### Shared state — ElastiCache

The two containers share nothing but the database, so the queue, the event bus and the
cache all need an external Redis. On AWS that is **ElastiCache for Valkey** (or Redis OSS)
— the app speaks plain Redis, so no code change is involved.

Provisioning notes for Terraform:

- **Cluster mode disabled**, single primary is enough for a hackathon. The client is a
  standard Redis client; cluster mode has not been tested here (**unverified**).
- Same VPC and subnets as the tasks, with a security group allowing 6379 from the task
  security group. ElastiCache has no public endpoint.
- With encryption in transit enabled the URLs become `rediss://` and an AUTH token is
  required; both the client's TLS support and the token path are **unverified** here.
  The simplest hackathon setup is in-VPC without in-transit encryption.

| Variable | Value | Why |
|---|---|---|
| `REDIS_URL` | `redis://<elasticache-endpoint>:6379` | The single Redis URL. Queue and cache resolve `<PREFIX>_REDIS_URL` first and fall back to this, so `QUEUE_REDIS_URL` / `CACHE_REDIS_URL` are optional overrides, not requirements. The rate limiter reads `REDIS_URL` **only**, with no prefixed override |
| `QUEUE_STRATEGY` | `async` | Accepted values are `local` and `async` (`@open-mercato/queue`, `resolveQueueStrategy`). `async` is the BullMQ/Redis strategy — **not** `redis`, which silently falls back to `local`. Left at the `local` default the queue writes to `QUEUE_BASE_DIR` on the container filesystem, which app and worker do not share: the worker starts healthy and never sees a job |
| `CACHE_STRATEGY` | `redis` | Accepted values are `memory`, `redis`, `sqlite`, `jsonfile`. Default `sqlite` is a per-container file, so the containers would hold divergent caches |
| `RATE_LIMIT_STRATEGY` | `redis` | Accepted values are `memory` and `redis`; an invalid value **throws at startup** rather than degrading. Default `memory` is per-container, so the effective limit is multiplied by the task count |
| `RATE_LIMIT_TRUST_PROXY_DEPTH` | `1` | **Set this even if nothing else about rate limiting is tuned.** The default `0` ("direct mode") makes the app read the ALB's IP as the client IP, so every user shares one rate-limit bucket and a room full of people demoing can trip a 429 on login that looks like an outage. `1` is correct for a single ALB in front of the tasks |
| `AUTO_SPAWN_WORKERS` | `false` **on the app container only** | Default `true` spawns workers inside the app container, so alongside the dedicated worker every job would be processed twice |

`NEXT_PUBLIC_QUEUE_STRATEGY` mirrors the strategy for client code. `NEXT_PUBLIC_*` values are
inlined by Next at **build** time, so setting it in the task definition may have no effect —
if the UI turns out to need it, it has to become a Docker build-arg (**unverified**: which
component reads it).

`DOCUMENTS_COLLAB_REDIS_URL` points at the same endpoint, but only matters if realtime
document collaboration is switched on.

One consequence worth stating explicitly: with `CACHE_STRATEGY=redis`, `/api/healthz`
returns 503 when ElastiCache is unreachable, so a Redis outage takes every ALB target out
of service even though the app could still serve most traffic.

### First boot

The one-off migration task creates the first superadmin, so it needs:

| Variable | Where | Notes |
|---|---|---|
| `OM_INIT_SUPERADMIN_EMAIL` | env | Without it there is no way to log in after the first deploy |
| `OM_INIT_SUPERADMIN_PASSWORD` | Secrets Manager | Compose defaults it to `password`; never carry that default into AWS |

`init-or-migrate.sh` keys "first run" off `INIT_MARKER_FILE`, default `/tmp/init-marker/.seeded`.
On Fargate `/tmp` is ephemeral, so **every** migration task looks like a first run: it calls
`mercato init`, the CLI aborts with "found N existing user(s)", and the script falls through
to migrations. That path is handled and idempotent, but it means the init branch runs on each
deploy — expect the abort message in the logs and do not treat it as a failure.

### Attachments and file storage

Compose keeps uploads on an `attachments_storage` volume. Fargate has no such volume: files
written to the container filesystem are **lost on every task restart** and are not visible to
the other container. If the demo involves uploads, PDFs or documents, enable S3:

- `OM_ENABLE_STORAGE_S3=true` adds `storage_s3` to `enabledModules`. Confirmed: it is a
  **build-time** flag. `yarn generate` writes the registry from `src/modules.ts`, so an image
  built without it has no `s3` storage driver and setting the variable in the task definition
  changes nothing. The Dockerfile defaults the build-arg to `true`; keep the task definition in
  agreement with the image.
- `OM_INTEGRATION_STORAGE_S3_BUCKET` plus the matching region/credentials, or a task role with
  bucket access
- Per-tenant preconfiguration is applied with `mercato storage_s3 configure-from-env`. It needs
  `OM_INTEGRATION_STORAGE_S3_ACCESS_KEY_ID` **and** `_SECRET_ACCESS_KEY`: with only region and
  bucket set it throws "Incomplete S3 env preset". On ECS, where the task role already grants
  bucket access, skip the CLI and leave the marketplace credentials empty — the driver then
  falls back to the AWS default credential chain (ambient mode).
- Last step, and the one nothing does automatically: attachment partitions are seeded with
  `storageDriver: 'local'`. Switch each one to S3 (bucket + region, credentials source left on
  the marketplace/ambient option) in Configuration → Attachments, or uploads keep going to the
  container filesystem even with the module loaded.
- That page needs `DEMO_MODE=false`. The default is inverted: with the variable **unset**,
  `isPartitionSettingsLocked()` treats the app as demo, the settings page renders only a
  "partition settings locked" banner, and `POST/PUT/DELETE /api/attachments/partitions` reject
  writes — so there is no curl workaround either. The image now pins `DEMO_MODE=false` and
  `SELF_SERVICE_ONBOARDING_ENABLED=false` as build-args (the root layout bakes `demoModeEnabled`
  into the prerendered tree), but a task definition that sets `DEMO_MODE` back on re-locks it.

Without this, attachments appear to work and silently vanish on the next deploy: with no `s3`
driver registered, `StorageDriverFactory` falls back to the local driver without an error, and
the partition UI still offers "S3" because it only checks the env flag.

### Search

Optional. `MEILISEARCH_HOST` makes Meilisearch the primary strategy; with it unset the system
falls back to token-based search in Postgres. There is no managed Meilisearch on AWS, so for
the hackathon leave it unset and accept the fallback.

### Document collaboration

`NEXT_PUBLIC_DOCUMENTS_COLLAB_URL` is baked in **at build time** (a Docker build-arg), not read
at runtime — enabling collaboration later means rebuilding the image, not editing the task
definition. It also needs the `documents-collab` sidecar on port 4101 and
`DOCUMENTS_COLLAB_JWT_SECRET_V2` (>= 32 bytes, fails closed). The two-container task does not
include that sidecar, so the editor stays single-user. That is a fine default; it just has to
be a decision rather than a surprise.

### Outbound e-mail (Resend)

All three are required together, on **both** the app and the worker container — the
worker sends queued notifications, so omitting them there leaves silent gaps.

| Variable | Where | Notes |
|---|---|---|
| `SYSTEM_EMAIL_PROVIDER` | env | `resend` |
| `RESEND_API_KEY` | Secrets Manager | |
| `NOTIFICATIONS_EMAIL_FROM` | env | Resolution order is `NOTIFICATIONS_EMAIL_FROM` → `EMAIL_FROM` → `ADMIN_EMAIL`. With a key but no from-address the app logs a warning and sends nothing |

Per-tenant Resend accounts are **not** configured here: the `channel_resend` module is set
up in the admin UI and stores credentials in the database. It declares no environment
variables.

Inbound e-mail (InboxOps) is only needed if we accept mail. It adds
`RESEND_WEBHOOK_SIGNING_SECRET` and `INBOX_OPS_WEBHOOK_SECRET` (both secrets) plus
`INBOX_OPS_DOMAIN`, and requires the webhook endpoint to be reachable through the ALB.

### Optional

`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` and `OM_AI_PROVIDER` / `OM_AI_MODEL` for AI
features; `AWS_*` only if S3 storage or SES is enabled. `.env.example` is the full
catalogue — it documents every variable, including the ones this file omits as
irrelevant to the deployment.

## PDF export

The image ships Chromium plus fonts, and `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`.
No extra configuration. Verified in the built image: Chromium 152 at `/usr/bin/chromium`,
with the `freefont`, `noto` and `opensans` font families present.

## Image size

Measured on local `linux/amd64` builds. Two numbers matter and they differ, so both are
given with the method that produced them:

| | Layer total (pushed, pulled, stored) | Container filesystem |
|---|---|---|
| before the slimming | 8.07 GB | 3.66 GB |
| current | **4.15 GB** | **3.02 GB** |

Layer total is the sum of `docker history` sizes; the filesystem figure is `du` inside a
running container. (`docker images` reports a third, larger number — 10.78 GB for the old
image — because of how it accounts for shared and duplicated layers. The layer sum is the
one to plan pulls around.)

The gap between the two columns used to be a `RUN chown -R omuser:omuser /app` at the end
of the runner stage: it rewrote the whole tree into a second layer, which the filesystem
then collapsed but the registry still had to carry. That step also cost **8 minutes 52
seconds** of every CI build and contributed to a runner running out of disk during layer
export. It is gone; ownership is set with `COPY --chown` as files arrive.

Turbopack's build cache (645 MB) is likewise deleted in the builder stage rather than
shipped.

What is left is mostly irreducible: `node_modules` 1.68 GB (production-only already —
`jest`, `playwright`, `ts-jest` and `eslint` are absent; what remains comes transitively
from the `@open-mercato` packages), the Next build output, and Chromium at 819 MB.

Fargate's default ephemeral storage is 20 GiB and holds the image uncompressed, so there
is comfortable headroom now. Every deploy still pulls the image twice — once for the
migration task, once for the rolling deployment — so the pull remains a real part of
deploy time.

## Agent plane — the `opencode` and `mcp` sidecars

Optional, and off by default: the two-container task above runs the app with the Agent
Orchestrator UI present but its runtime unreachable, which is what the red `OpenCode` /
`MCP` badges in the admin header mean. Turning the plane on adds **two containers to the
same task** and **one new image**.

Enabling it is a decision, not a default. Everything below is additive — none of it
changes the app/worker/migration containers except the three variables called out under
"Changes to the existing containers".

### Images

| Container | Image | Built by |
|---|---|---|
| `mcp` | `ghcr.io/evojam/blueprint-2-quote:main` — **the app image**, different command | existing `build` job |
| `opencode` | `ghcr.io/evojam/blueprint-2-quote:opencode` | `opencode` job in `.github/workflows/docker-main.yml` |

The MCP sidecar is the app image with another entrypoint, so it costs no extra build and
no extra pull — the task already has those layers.

`:opencode` is mutable and moves with every merge to `main`, exactly like `:main`;
`:opencode-sha-<short>` is the immutable pin. Both tags are built from
`docker/opencode/Dockerfile`, which layers `AGENTS.md`, `entrypoint.sh`, `agents/` and
`skills/` onto the published base `docker.io/openmercatocom/open-mercato-opencode:1.18.3`.

That base is multi-arch (`linux/amd64` + `linux/arm64`); the CI job pins `linux/amd64` for
the same reason the app image does. Measured on a local `linux/amd64` build: **147 MB**
container filesystem, against the app image's 3.02 GB — the agent plane is noise against
the 20 GiB ephemeral budget.

**Why a separate image at all.** Compose runs OpenCode straight from the public base and
bind-mounts those four things out of the working tree. Fargate has no bind mounts, so the
base image on its own boots an OpenCode with no agents and no generated config. The
`agents/` and `skills/` directories are `yarn generate` output that is **committed** — if
they are stale in git, they are stale in the image, and nothing at deploy time will say so.

### Topology

All containers of an `awsvpc` task share one network namespace, so the sidecars talk over
`localhost` and need no service discovery. The ports do not collide: app 3000, `mcp` 3001,
`opencode` 4096.

```
app :3000  ──OPENCODE_URL──▶  opencode :4096
   ▲                              │
   │                      OPENCODE_MCP_URL
   │                              ▼
   └──────APP_URL───────────  mcp :3001
              (mcp blocks on app at boot)
```

There is no service discovery to configure — no Cloud Map, no extra networking, and no
target group for either sidecar port. The whole wiring is three environment variables.

The app-side defaults are already `http://localhost:4096` and `http://localhost:3001`
(verified in `@open-mercato/ai-assistant` `opencode-handlers.ts` / `opencode-client.ts`),
so `OPENCODE_URL` and `MCP_URL` can be left unset on the app container. Setting them
explicitly is still worth it as documentation.

The other two directions are **not** safe to leave defaulted, because their defaults are
compose-shaped and unresolvable on ECS:

| Variable | Container | Default in code | Must be |
|---|---|---|---|
| `APP_URL` | `mcp` | `http://app:3000` | `http://localhost:3000` |
| `OPENCODE_MCP_URL` | `opencode` | `http://host.docker.internal:3001/mcp` | `http://localhost:3001/mcp` |

Getting these wrong fails quietly rather than loudly. `APP_URL` is the gate
`mcp-entrypoint.sh` blocks on, so a stale default means `mcp` waits its full 1800 s for a
host that does not exist, and `opencode` then waits its own 1800 s for a key that never
arrives. The task looks alive for an hour and serves nothing.

**Neither sidecar port goes near the ALB.** OpenCode ships no authentication of its own,
and anyone who can reach 4096 can drive the agent runtime. Only the app container's 3000
is a target-group member.

### Boot order

The chain is circular and slow, and both sidecars are built to wait it out rather than
crash-loop:

1. `app` starts and serves HTTP.
2. `mcp` polls the app (`MCP_WAIT_FOR_APP_TIMEOUT`, default **1800 s**), provisions its own
   API key, then listens on 3001.
3. `opencode` polls `http://localhost:3001/health` and the key file
   (`OPENCODE_MCP_KEY_WAIT_SECONDS`, default **1800 s**), writes `opencode.jsonc`, serves 4096.

Use ECS `dependsOn` with `condition: START` for `mcp` → `app` and `opencode` → `mcp`. Not
`HEALTHY`: that requires a container health check, and the 30-minute waits would become
deploy-blocking.

**Do not copy the compose health checks into the task definition.** ECS validates these
fields at `RegisterTaskDefinition` and rejects the whole revision with a 400 — no new task
definition, no rollout, and the service quietly keeps serving the previous revision:

| Field | ECS range | Compose value | On ECS |
|---|---|---|---|
| `retries` | 1–10 | `20` | rejected |
| `startPeriod` | 0–300 s | `start_period: 900s` | rejected |
| `interval` | 5–300 s | `30s` | fine |
| `timeout` | 2–60 s | `5s` / `6s` | fine |

(Ranges from the [ECS HealthCheck API reference](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_HealthCheck.html).)

A 1800 s bootstrap simply cannot be expressed as an ECS container health check — the
grace period caps at 300 s. **The recommendation is to give the sidecars no `healthCheck`
at all** and let `dependsOn: START` plus the entrypoints' own waiting do the sequencing.

Mark both sidecars `essential: false`. An essential container that fails its health check
or exits takes the whole task down and the service replaces it, which against a 30-minute
bootstrap is a restart loop that never converges. With `essential: false` a broken agent
plane degrades to red badges while the app keeps serving.

On timeout `opencode` starts **anyway**, unauthenticated against MCP, and logs a warning.
It will come up listening on 4096 and answer 401 on every tool call — a running container
proves nothing here. Grep its log for `MCP API key loaded from file` before believing the
plane is wired.

### The MCP API key handoff

Compose passes the key through a shared volume: `mcp` writes `/run/mcp-shared/mcp-api-key`,
`opencode` mounts it read-only. **Mirror that on ECS with a task-scoped volume.** Declare one
`volumes` entry, mount it at `/run/mcp-shared` on both containers, read-only on `opencode`,
and set `MCP_SERVER_API_KEY_FILE=/run/mcp-shared/mcp-api-key` on both.

**There is no shared-secret shortcut.** Handing both containers the same
`MCP_SERVER_API_KEY` from Secrets Manager looks like it should remove the volume and one of
the two 1800 s waits. It does not work, and it fails at the first tool call rather than at
boot:

- The MCP server authenticates every request with `findApiKeyBySecret()`
  (`ai-assistant/lib/http-server.ts`) — the secret has to resolve to a live `api_keys` row.
  Only `omk_`-prefixed keys minted by `mcp:ensure-api-key` do; an arbitrary Secrets Manager
  value answers 401.
- `mcp:ensure-api-key` reads no environment variable. The **file** is its idempotency
  anchor (`mcp-ensure-api-key.ts`): when the path holds no live key of the expected name, it
  soft-deletes the stale ones and mints a fresh secret. So even seeding Secrets Manager with
  a real `omk_` value is self-defeating — the next `mcp` boot invalidates it.

`opencode` does honour `MCP_SERVER_API_KEY` and skips the file wait, but only the `mcp` side
can produce a value it will be allowed to use.

Mind the user on the volume. Compose runs `mcp` as `user: "0"`; the image's runtime user is
`omuser` (uid 1001). A Fargate task volume is created root-owned `0755`, so a `mcp` container
left at the image default cannot write the key file. Set `"user": "0"` on the `mcp` container
definition, as compose does. The written file is `0644`, which is what lets `opencode` read it
as its own non-root user.

### Environment

**S** = Secrets Manager, **E** = plain value. Anything not listed is not needed by that
container.

| Variable | `mcp` | `opencode` | Value / note |
|---|:--:|:--:|---|
| `DATABASE_URL` | S | — | same RDS string as the app |
| `JWT_SECRET` | S | — | must match the app |
| `TENANT_DATA_ENCRYPTION_KEY` | S | — | tier-2 session-token decryption |
| `REDIS_URL` | E | — | same ElastiCache as the app |
| `CACHE_STRATEGY` | E | — | `redis` |
| `APP_URL` | E | — | **`http://localhost:3000`, required.** Default is `http://app:3000`, a compose DNS name. Also the boot gate |
| `NEXT_PUBLIC_APP_URL` | E | — | same; pinned so a stray value cannot hijack the base URL |
| `AUTO_SPAWN_WORKERS` | E | — | **`false`** — the sidecar must never drain the worker's queues |
| `AUTO_SPAWN_SCHEDULER` | E | — | **`false`**, same reason |
| `MCP_PORT` | E | — | `3001` |
| `MCP_WAIT_FOR_APP_TIMEOUT` | E | — | seconds; default 1800 |
| `OM_ENABLE_ENTERPRISE_MODULES` | E | — | `true` |
| `OM_ENABLE_ENTERPRISE_MODULES_AGENTS` | E | — | `true` |
| `MCP_SERVER_API_KEY_FILE` | E | E | `/run/mcp-shared/mcp-api-key` on both — the shared volume. Do **not** substitute `MCP_SERVER_API_KEY`; see the handoff section above |
| `OPENCODE_MCP_URL` | — | E | **`http://localhost:3001/mcp`, required.** Default is `host.docker.internal`, a compose-ism |
| `OM_AI_PROVIDER` | — | E | `openai` / `anthropic` / `litellm` / `azure` / `openrouter` / … ; default `openai` |
| `OM_AI_MODEL` | — | E | optional for most providers; **required for `litellm`**, which has no universal default (`entrypoint.sh`) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | S | S | when the provider is the vendor directly, on **both** |
| `LITELLM_BASE_URL` / `LITELLM_API_KEY` | S | S | when `OM_AI_PROVIDER=litellm`. The OpenCode entrypoint has a first-class `litellm` branch, so a gateway needs no extra keys — this is the option to prefer when the app already routes through one |
| `OPENCODE_SERVER_PASSWORD` | — | S | optional HTTP Basic on 4096; cheap defence in depth. The variable is `OPENCODE_SERVER_PASSWORD` — `OPENCODE_PASSWORD` is the compose *host* variable that feeds it, and setting that name in the task definition does nothing |

`OM_ENABLE_ENTERPRISE_MODULES*` are baked into the app image with defaults of `true`
(`Dockerfile`), so the `mcp` container inherits them; the rows above are belt-and-braces
for a task definition that overrides the environment wholesale.

### Changes to the existing containers

| Variable | Container | Value |
|---|---|---|
| `OPENCODE_URL` | app | `http://localhost:4096` (matches the built-in default) |
| `MCP_URL` | app | `http://localhost:3001` (matches the built-in default) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | app | already listed in the matrix; required once agents run |

Nothing changes for the worker.

The **migration task is not untouched**, though nothing about its variables changes: the
migrate gate's `run-task` overrides only the `app` container's command, so it starts the whole
definition — sidecars included. Mark both sidecars `"essential": false`. An essential container
that dies stops the task, which surfaces on the app container as SIGKILL / exit 137 and reads
as a failed migration. Non-essential also keeps an agent-plane failure from cycling the app
service in normal operation.

### Where the sandbox actually runs

Worth stating because the name misleads: the `isolated-vm` sandbox that executes skill
scripts (`run_skill_script`, no fs/net/require/process, 30 s cap) runs **in the OM process
— the `mcp` container**, not inside OpenCode. Web egress likewise runs server-side in the
OM process, never in the sandbox. OpenCode is the agent runtime that *calls* those MCP
tools; its own `bash` tool is denied outright and `read`/`write`/`edit` stay off unless
`OM_OPENCODE_FILES_ENABLED` is set.

So a task that only needs the sandbox exercised needs `mcp`. `opencode` is what makes the
file-defined agents in `docker/opencode/agents/` available to drive it.

### Known limits

- **Single task only.** `agentWorkspaceManager` is a process-wide singleton and its
  concurrency semaphore (`OM_OPENCODE_POOL_SIZE`, default 1) serializes runs *within one
  process*. Two app tasks means two independent semaphores over one shared OpenCode lease
  model. Do not scale the service past one task with the agent plane on.
- **The file plane is off.** Attachments-in / artifacts-out needs
  `OM_OPENCODE_FILES_ENABLED=true` plus a workspace root shared between the app and
  `opencode` (`OM_OPENCODE_WORKSPACE_ROOT`, `OM_OPENCODE_WORKSPACE_ROOT_CONTAINER`) — a
  second shared volume. Left out here deliberately; agents that only read data and submit
  outcomes do not need it.
- **Tool search indexing fails against an SSL-only database.** Upstream bug, not an infra
  problem. On start the MCP server logs:

  ```
  Failed to index 83 tools: vector (no pg_hba.conf entry for host "10.2.1.191", no encryption)
  Search indexing skipped (search service not available)
  ```

  `@open-mercato/search` opens two pools of its own — `src/modules/search/di.ts:78` and
  `src/vector/drivers/pgvector/index.ts:112` — as bare
  `new Pool({ connectionString: dbUrl })`. Neither passes `ssl`, and the package never
  calls `getSslConfig()` (`@open-mercato/shared/src/lib/db/ssl.ts`), which is what the
  app's own MikroORM pool uses. With `DB_SSL=true` the main connection is encrypted and
  these two are not, so RDS refuses them.

  It is not a regression. The app container never reaches this code; `http-server.ts:444`
  calls `indexToolsForSearch` unconditionally at MCP startup, and that startup is a path
  this deployment ran for the first time. Note also that
  `OM_DISABLE_VECTOR_SEARCH_AUTOINDEXING` does **not** gate it — that flag covers entity
  auto-indexing, not tool indexing — and the `catch` misreports the cause as "search
  service not available" when the service was available and the connection was not.

  Impact is degradation, not failure: the MCP server starts, tools are served, and an
  agent calling a tool by name works. Only `tool_search` is affected, and it can come
  back empty.

  **Workaround — keeps the feature on.** Append `?sslmode=no-verify` to `DATABASE_URL` on
  the `mcp` container **and keep `DB_SSL=true`**. Both pools take the connection string
  straight to `pg`, and `pg-connection-string` (2.14.0, `index.js:153`) maps `no-verify`
  to `ssl.rejectUnauthorized = false`, so they connect encrypted without needing the RDS
  CA bundle. `DB_SSL=true` has to stay because `getSslConfig()` matches only
  `sslmode=require`, `ssl=true` or `DB_SSL=true` — it does not recognise `no-verify`, so
  dropping it would silently unencrypt the app's own pool.

  Do **not** use `?sslmode=require` instead: outside libpq-compat mode that enables
  verification without supplying a CA, which fails against RDS.

- **Unverified on ECS.** Everything in this section is derived from the compose
  definitions, the two entrypoints and the module sources, plus a local `linux/amd64` build
  of the `opencode` image. The four-container task has not been run on Fargate.

## Task definition matrix

One row per variable, for writing the three container definitions. **S** = pull from Secrets
Manager, **E** = plain environment value, **—** = not needed. When in doubt, giving the
migration task the same block as the app is safe.

| Variable | App | Worker | Migration | Value |
|---|:--:|:--:|:--:|---|
| `DATABASE_URL` | S | S | S | RDS connection string |
| `JWT_SECRET` | S | S | S | stable across deploys |
| `AUTH_SECRET` | S | S | S | stable across deploys |
| `TENANT_DATA_ENCRYPTION_KEY` | S | S | S | set before first seed; losing it loses data |
| `LOOKUP_HASH_PEPPER` | S | S | S | changing it breaks existing lookup hashes |
| `APP_URL` | E | E | E | public ALB origin |
| `ADMIN_EMAIL` | E | E | E | |
| `REDIS_URL` | E | E | E | `redis://<elasticache>:6379` — covers queue, cache and rate limiting |
| `CACHE_STRATEGY` | E | E | — | `redis` |
| `QUEUE_STRATEGY` | E | E | — | `async` |
| `NEXT_PUBLIC_QUEUE_STRATEGY` | E | — | — | `async`; may need to be a build-arg instead |
| `RATE_LIMIT_STRATEGY` | E | — | — | `redis` |
| `RATE_LIMIT_TRUST_PROXY_DEPTH` | E | — | — | `1` behind the ALB |
| `AUTO_SPAWN_WORKERS` | E | — | — | `false` on the app container |
| `SYSTEM_EMAIL_PROVIDER` | E | E | — | `resend` |
| `RESEND_API_KEY` | S | S | — | |
| `NOTIFICATIONS_EMAIL_FROM` | E | E | — | required, or nothing is sent |
| `OM_INIT_SUPERADMIN_EMAIL` | — | — | E | no login without it |
| `OM_INIT_SUPERADMIN_PASSWORD` | — | — | S | never the compose default |
| `OM_ENABLE_STORAGE_S3` + `OM_INTEGRATION_STORAGE_S3_*` | E/S | E/S | E/S | only if uploads must survive a restart |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | S | S | — | only if AI features are demoed |

`NODE_ENV`, `PORT` and `HOSTNAME` are baked into the image and need no task-definition entry.

## Checklist before apply

1. `:main` exists in GHCR and the pull credential can read the package.
2. `docker manifest inspect ghcr.io/evojam/blueprint-2-quote:main` reports `linux/amd64`.
3. ElastiCache reachable from the task security group on 6379.
4. Migration task runs to completion **before** the service is created, and its logs end with
   migrations applied (an "existing user(s)" abort earlier in the log is expected).
5. `curl http://<alb>/api/healthz` returns 200 and the target group reports healthy.
6. Worker logs show it picked up the queue, not just that it started.
7. Send one test e-mail end to end — a missing from-address fails silently.

## Not covered here

Deliberately out of scope for this file, and still owned by the Terraform stack: log driver and
retention (`awslogs`), task CPU/memory sizing, autoscaling, ALB listener/TLS/certificate setup,
RDS parameter groups and backups, and the rollback procedure (pin `:sha-<short>` and
force-new-deployment).

Two things are untested rather than merely undocumented:

- **The app/worker split itself.** Compose runs no separate worker service — locally the app
  spawns its own workers. Running `workflows:startWorker` as a second container is a new
  arrangement, first exercised on ECS.
- **Multi-task scaling.** `OM_MULTI_INSTANCE` and `OM_INSTANCE_COUNT` exist in compose but are
  documented nowhere in `.env.example`. Before scaling the service past one task, confirm what
  they do.

Strategy values above were read from the published `@open-mercato/queue@0.8.0`,
`@open-mercato/shared@0.8.0` and `@open-mercato/cache@0.8.0` packages, not inferred.

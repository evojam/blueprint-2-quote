# Deployment reference — ECS Fargate

Target shape: one ECS task with two containers (app + worker), a separate one-off
migration task, ALB in front, RDS behind. This file is the contract between the repo
and the Terraform stack. Facts below were verified against a local `linux/amd64` build of the `runner`
stage unless explicitly marked **unverified**.

## Image

| Item | Value |
|---|---|
| Registry | `ghcr.io/evojam/blueprint-2-quote` |
| Mutable tag | `:main` — rebuilt and pushed on every merge to `main`; deploy does `force-new-deployment` |
| Immutable tag | `:sha-<short>` — same build, for pinning when `:main` is broken |
| Architecture | `linux/amd64` only. Tasks declare no `runtime_platform`, so they run x86_64; an arm64 image fails with "no matching manifest" |
| Build | `.github/workflows/docker-main.yml`, stage `runner` |
| Pull auth | GitHub service account credential from Secrets Manager. The package is private by default, so that account needs `read:packages` |

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

## Three run modes, one image

| Mode | Command | Notes |
|---|---|---|
| App | default `CMD` (`yarn start` → `yarn mercato server start`) | Listens on `PORT` (3000), binds `HOSTNAME=0.0.0.0` — both baked into the image |
| Worker | `["mercato", "queue", "worker", "--all"]` | Verified in the built image: 18 queues discovered, CLI starts without a database. The `workflows:startWorker` command in the original infra brief does not exist in this app |
| Migrations | `["/app/docker/scripts/init-or-migrate.sh"]` | One-off task, runs before the service rolls |

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

- `OM_ENABLE_STORAGE_S3=true` (this also adds `storage_s3` to `enabledModules`, so it is a
  build-affecting flag, not just runtime — confirm whether the image must be rebuilt with it)
- `OM_INTEGRATION_STORAGE_S3_BUCKET` plus the matching region/credentials, or a task role with
  bucket access
- Per-tenant preconfiguration is applied with `mercato storage_s3 configure-from-env`

Without this, attachments appear to work and silently vanish on the next deploy.

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

The `runner` image is **10.8 GB uncompressed**, measured on a local `linux/amd64` build:

| Layer | Size |
|---|---|
| `adduser && chown -R omuser:omuser /app` | 2.84 GB |
| `yarn workspaces focus --all --production` | 3.15 GB |
| `.mercato/next` build output | 1.05 GB |
| Chromium + fonts | 819 MB |
| node:24-alpine base | 174 MB |

Two consequences for the task definition:

- Fargate's default ephemeral storage is 20 GiB and holds the image **uncompressed**.
  10.8 GB leaves usable headroom but is worth watching; raise `ephemeralStorage` if
  attachments or temporary files are written to disk.
- Every deploy pulls this, so task start-up is dominated by the pull. Budget for it when
  setting the ALB deregistration delay and any deployment timeout.

The `chown -R` layer is pure duplication: it rewrites every file under `/app` into a new
layer, so it costs almost exactly what the files it touches already cost. Replacing it
with `COPY --chown` on the copies above would cut roughly 2.8 GB. Not done here — it
needs a verified rebuild, and the image works as it stands.

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

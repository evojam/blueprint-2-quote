# `catalog_seed` — renovation service catalog seed

Seeds the renovation service catalog (45 services, 62 variants, 5 categories) into one organization. Data-only module: no entities, no migrations, no API routes, no UI. Everything it does happens in one CLI command.

## Usage

```bash
yarn seed:catalog --org <organizationId> --dry-run
yarn seed:catalog --org <organizationId>
```

Full form, and the form to use inside a container:

```bash
mercato catalog_seed seed-renovation-catalog --org <organizationId> [--dry-run]
```

| Argument | Meaning |
|---|---|
| `--org <uuid>` | Required. The target organization. `--organizationId` / `--orgId` are accepted aliases, `--org=<uuid>` works too. |
| `--dry-run` | Reads and reports, writes nothing. |

The tenant is **not** an argument — it is read from the organization record (`org.tenant.id`) and printed before the first write. Find the organization id with `mercato auth list-orgs`, which prints organization and tenant ids side by side.

### Finding the organization id

- **CLI** — `mercato auth list-orgs` prints organization id, name and tenant id in one table. `mercato auth list-tenants` lists tenants alone.
- **Admin UI** — open `/backend/directory/organizations`. The table has no id column, so take the id out of the row's **Edit** link: `/backend/directory/organizations/<organizationId>/edit`. Tenants work the same way at `/backend/directory/tenants/<tenantId>/edit`, though the seed derives the tenant itself.
- **API** — `GET /api/directory/organizations` from a logged-in browser session returns `id` and `tenantId` as JSON.

## What a run does

1. **Units** — adds the units used by the catalog (`m2`, `szt`, `mb`, `kpl`) to the organization's unit dictionary (`unit` / `units` / `measurement_units`). If the organization has no such dictionary, the run warns and continues; catalog then accepts the unit codes without dictionary validation.
2. **Categories** — upserts `RENOVATION_CATEGORY_TREE` by `slug`, parents before children, and keeps a `slug → categoryId` map for the products.
3. **Price kind** — resolves the existing `regular` price kind (organization-scoped first, tenant-wide as fallback). Missing price kind aborts the run with the `mercato catalog seed-price-kinds` command to fix it. Checked in `--dry-run` too.
4. **Tax rate** — finds or creates the `vat-8` rate (8%) next to whatever rates already exist. The default rate of the organization is not touched.
5. **Products, variants, prices** — creates the missing ones and writes the `vat-8` rate onto every catalog service, including services that already existed without it.

Every write goes through the command bus (`catalog.categories.create`, `catalog.products.create`, `catalog.variants.create`, `catalog.prices.create`, `catalog.products.update`, `catalog.variants.update`, `sales.tax-rates.create`, `dictionaries.entries.create`), never through the EntityManager directly, so audit entries, events, cache invalidation and indexing stay consistent. Reads used for idempotency go through the EntityManager, because they mutate nothing.

## Idempotency — resume-safe, not atomic

There is no surrounding transaction, and this is deliberate: `catalog.*` command handlers fork their own EntityManager and do not read `ctx.transactionalEm`, so an outer `em.transactional` would not cover their writes. The built-in `seedCatalogExamplesForScope` is transactional only because it bypasses the command bus, which would cost audit, events and indexing.

Instead the seed is resume-safe. Existing records are matched on three levels:

| Record | Matched by |
|---|---|
| Product | `handle`, within `(organizationId, tenantId)` |
| Variant | `sku`, within its product |
| Price | variant + price kind + currency (`PLN`) + `minQuantity` |

An interrupted run leaves whatever it already wrote. Running it again fills in only what is missing — no manual cleanup, no duplicates.

## Behavior worth knowing before running against real data

- **The VAT rate is overwritten.** Every run writes `vat-8` onto the products and variants it finds. If someone set a different rate by hand on a product sharing one of these 46 handles, the next run replaces it.
- **Scope fails closed.** A missing organization, a soft-deleted one, or one without a tenant aborts before the first write, with exit code 1.
- **No authenticated actor.** The command runs with `ctx.auth = null` and `systemActor: true`, the same pattern the built-in `feature_toggles` and `catalog seed-examples` CLIs use. With `OM_ENFORCE_ORG_SCOPE_STRICT=true` every command would be rejected with 403 — the flag has to stay off for the seed.
- **Side effects follow the environment.** Index and cache jobs go wherever `QUEUE_STRATEGY` / `REDIS_URL` point. When a run does not go through the deployment's own queue, the index needs rebuilding; the command prints the exact `mercato query_index rebuild` invocation at the end of a non-dry run.

## Running it against a deployed database

The module ships inside the image (`src/` is copied into the runner stage, and the CLI registry is generated during `yarn build`), so no extra tooling is needed in the container — `mercato` is already on `PATH`. A new image has to be built after changing this module.

One-off ECS task:

```bash
aws ecs run-task --cluster <cluster> --task-definition <taskdef> --launch-type FARGATE \
  --network-configuration "<awsvpcConfiguration of the app service>" \
  --overrides '{"containerOverrides":[
    {"name":"app","command":["mercato","catalog_seed","seed-renovation-catalog","--org","<uuid>","--dry-run"]},
    {"name":"worker","command":["sh","-c","sleep 900"]}
  ]}'
```

The `worker` override keeps the one-off task from starting a second worker against the deployment's queues. See `DEPLOYMENT.md` for the task shape and the environment the task needs.

## Files

| Path | Contents |
|---|---|
| `cli.ts` | The command: seeding steps, idempotency lookups, command-bus calls |
| `lib/args.ts` | `parseSeedArgs`, `resolveOrganizationScope` — pure, unit-tested |
| `data/renovation-catalog.ts` | The catalog data and its types; no behavior |
| `__tests__/args.test.ts` | Argument parsing and scope resolution, including the fail-closed paths |

Changing the catalog itself means editing `data/renovation-catalog.ts` only. New services are picked up by the next run; services removed from the file are **not** deleted from the database.

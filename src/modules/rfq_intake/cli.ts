import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ensureRfqPipeline, RFQ_PIPELINE_STAGES } from './lib/pipeline'
import { ensureRfqProcessDefinition } from './lib/processDefinition'
import type { Scope } from './lib/pipeline'

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    if (arg.includes('=')) {
      const [key, value] = arg.slice(2).split('=')
      out[key] = value
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[arg.slice(2)] = next
      i++
    }
  }
  return out
}

/**
 * Every organization in this database, for the common case where the caller has no
 * uuid to hand — a developer on a local checkout, or an operator on a single-tenant
 * environment. `--tenant`/`--org` still narrow it when a database holds several.
 *
 * Reads through the ORM rather than asking for ids, so it reports what is actually
 * there instead of failing on a typo'd uuid.
 */
async function resolveScopes(
  em: EntityManager,
  tenantId: string,
  organizationId: string,
): Promise<Scope[]> {
  if (tenantId && organizationId) return [{ tenantId, organizationId }]

  const { Organization } = await import('@open-mercato/core/modules/directory/data/entities')
  const organizations = await em.find(
    Organization,
    { deletedAt: null },
    { populate: ['tenant'] as const },
  )
  return organizations
    .map((organization) => ({
      tenantId: String((organization as { tenant: { id: string } }).tenant.id),
      organizationId: String(organization.id),
    }))
    .filter((scope) => (!tenantId || scope.tenantId === tenantId)
      && (!organizationId || scope.organizationId === organizationId))
}

function reportEmptyScope(command: string): void {
  console.error(
    `❌ No organization matched. Run \`yarn mercato rfq_intake ${command}\` with no flags to` +
    ' target every organization, or check the ids you passed.',
  )
}

/**
 * The same seeding `setup.ts` performs at `mercato init`, for a tenant that already
 * exists. Idempotent, so re-running it after a stage was renamed or deleted tops the
 * funnel back up without touching the deals sitting in it.
 */
const seedPipeline: ModuleCli = {
  command: 'seed-pipeline',
  async run(argv) {
    const args = parseArgs(argv)
    const tenantId = args.tenant ?? args.tenantId ?? ''
    const organizationId = args.org ?? args.orgId ?? args.organizationId ?? ''

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const scopes = await resolveScopes(em, tenantId, organizationId)
    if (scopes.length === 0) return reportEmptyScope('seed-pipeline')

    for (const scope of scopes) {
      const result = await ensureRfqPipeline(em, scope)
      console.log(
        result.created ? '✅ RFQ pipeline created' : '✅ RFQ pipeline already present; stages topped up',
        `(${RFQ_PIPELINE_STAGES.length} stages, default for organization ${scope.organizationId})`,
      )
    }
  },
}

/**
 * The orchestrator half of the same seeding, for a tenant that already exists.
 *
 * Separate from `seed-pipeline` because the two touch unrelated records: one is CRM
 * structure, the other is the Agent Orchestrator entry point. A single command would
 * have to lie in its name about one of them.
 */
const seedProcess: ModuleCli = {
  command: 'seed-process',
  async run(argv) {
    const args = parseArgs(argv)
    const tenantId = args.tenant ?? args.tenantId ?? ''
    const organizationId = args.org ?? args.orgId ?? args.organizationId ?? ''

    // Read off `argv`, not `parseArgs`: that parser only records `--key value` pairs,
    // so a valueless flag never lands in its output.
    //
    // `--force` lets the repo overwrite the name, description and triggers of a row that
    // already exists. Opt-in, because it also discards an edit made in the Studio.
    const force = argv.includes('--force')

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const scopes = await resolveScopes(em, tenantId, organizationId)
    if (scopes.length === 0) return reportEmptyScope('seed-process')

    for (const scope of scopes) {
      const result = await ensureRfqProcessDefinition(em, container, scope, { force })
      const outcome = result.created
        ? '✅ RFQ process definition created'
        : result.updated
          ? '✅ RFQ process definition reconciled with the repo'
          : force
            ? '✅ RFQ process definition already matches the repo'
            : '✅ RFQ process definition already present (pass --force to reconcile it)'
      console.log(outcome, `(${result.processDefinitionId})`)
    }
  },
}

const cli: ModuleCli[] = [seedPipeline, seedProcess]

export default cli

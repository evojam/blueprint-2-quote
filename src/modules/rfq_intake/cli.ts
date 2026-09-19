import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ensureRfqPipeline, RFQ_PIPELINE_STAGES } from './lib/pipeline'

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
    if (!tenantId || !organizationId) {
      console.error('Usage: mercato rfq_intake seed-pipeline --tenant <tenantId> --org <organizationId>')
      return
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const result = await ensureRfqPipeline(em, { tenantId, organizationId })

    console.log(
      result.created ? '✅ RFQ pipeline created' : '✅ RFQ pipeline already present; stages topped up',
      `(${RFQ_PIPELINE_STAGES.length} stages, default for organization ${organizationId})`,
    )
  },
}

const cli: ModuleCli[] = [seedPipeline]

export default cli

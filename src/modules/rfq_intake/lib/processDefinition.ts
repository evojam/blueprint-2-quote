import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { ProcessDefinition } from '@open-mercato/enterprise/modules/agent_orchestrator/data/entities'
import type { ProcessTrigger } from '@open-mercato/enterprise/modules/agent_orchestrator/data/validators'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { RFQ_ANALYSIS_WORKFLOW_ID } from '../workflows'
import type { Scope } from './pipeline'

const logger = createLogger('rfq_intake').child({ component: 'process-definition' })

/**
 * The Agent Orchestrator list reads this entity type through the query index —
 * `agent_orchestrator/api/processes/route.ts` declares `indexer: { entityType }` and
 * `makeCrudRoute` discharges it through `markOrmEntityChange`. A row written with the
 * ORM alone stays invisible on the page, so the same entity type has to reach the
 * data engine below.
 */
const PROCESS_DEFINITION_ENTITY_TYPE = 'agent_orchestrator:process_definition'

export type EnsuredProcessDefinition = {
  processDefinitionId: string
  created: boolean
  /** True when `force` found a row whose code-owned fields had drifted and rewrote them. */
  updated: boolean
}

export type EnsureOptions = {
  /**
   * Reconcile an existing row against the code instead of leaving it alone.
   *
   * Off by default because the Studio is a legitimate editor: a name or a trigger an
   * operator changed there must survive `mercato init` and every routine re-seed. On
   * means the repo wins for the fields below — which is what you want after changing
   * them here, and what you must NOT run blind against an environment somebody has
   * been editing by hand.
   */
  force?: boolean
}

/** The fields the repo owns under `force`. Everything else stays the operator's. */
function codeOwnedFields(): { name: string; description: string; triggers: ProcessTrigger[] } {
  return {
    name: 'RFQ document analysis',
    description: 'Reads the RFQ PDF and matches its brief against the catalog.',
    triggers: [{ kind: 'manual', requireFeatures: [] }],
  }
}

/**
 * Publishes the RFQ analysis chain as an Agent Orchestrator process.
 *
 * `registerCodeWorkflows` puts `rfq_intake.analysis` in the workflow registry, which
 * is what the Workflows pages read. "Definicje procesów" reads a different thing: a
 * scoped `process_definitions` row that merely POINTS at a workflow id. Nothing
 * derives one from the registry, which is why the page stays empty until this runs.
 *
 * Only a `manual` trigger is declared. The live entry point is the workflow's own
 * embedded event trigger on `rfq_intake.rfq.created` (`workflows.ts`); repeating that
 * event here would start the chain twice per RFQ. The manual trigger exists so the
 * process can be hand-started — `startProcessExecutionCommand` 403s on a definition
 * that declares none.
 *
 * HACK(hackathon): no milestones. A milestone only lights up when a step declares
 * `milestone: '<key>'`, and no step in `workflows.ts` does. Seeding a vocabulary
 * nothing emits would render a permanently empty progress strip — add both halves
 * together when the demo needs the business-facing stages.
 *
 * Idempotent on the (scope, workflowId) pair rather than on a synthesised id, so a
 * definition an operator renamed or re-pointed in the Studio survives the next run.
 */
export async function ensureRfqProcessDefinition(
  em: EntityManager,
  container: AwilixContainer,
  scope: Scope,
  options: EnsureOptions = {},
): Promise<EnsuredProcessDefinition> {
  const fields = codeOwnedFields()
  const existing = await em.findOne(ProcessDefinition, {
    ...scope,
    workflowId: RFQ_ANALYSIS_WORKFLOW_ID,
    deletedAt: null,
  })

  if (existing && !options.force) {
    return { processDefinitionId: existing.id, created: false, updated: false }
  }

  if (existing) {
    const drifted =
      existing.name !== fields.name ||
      (existing.description ?? null) !== fields.description ||
      JSON.stringify(existing.triggers ?? []) !== JSON.stringify(fields.triggers)
    if (!drifted) {
      return { processDefinitionId: existing.id, created: false, updated: false }
    }

    existing.name = fields.name
    existing.description = fields.description
    existing.triggers = fields.triggers
    em.persist(existing)
    await em.flush()
    await indexChange(container, existing, scope, 'updated')

    logger.info('RFQ process definition reconciled with the repo', {
      processDefinitionId: existing.id,
      ...scope,
    })
    return { processDefinitionId: existing.id, created: false, updated: true }
  }

  const definition = em.create(ProcessDefinition, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    workflowId: RFQ_ANALYSIS_WORKFLOW_ID,
    milestones: [],
    enabled: true,
    ...fields,
  })
  em.persist(definition)
  await em.flush()
  await indexChange(container, definition, scope, 'created')

  logger.info('RFQ process definition ensured', { processDefinitionId: definition.id, ...scope })
  return { processDefinitionId: definition.id, created: true, updated: false }
}

async function indexChange(
  container: AwilixContainer,
  definition: ProcessDefinition,
  scope: Scope,
  action: 'created' | 'updated',
): Promise<void> {
  const dataEngine = container.resolve<DataEngine>('dataEngine')
  dataEngine.markOrmEntityChange({
    action,
    entity: definition,
    identifiers: {
      id: String(definition.id),
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    },
    indexer: { entityType: PROCESS_DEFINITION_ENTITY_TYPE },
  })
  await dataEngine.flushOrmEntityChanges()
}

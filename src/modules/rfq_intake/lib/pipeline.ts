import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CustomerPipeline,
  CustomerPipelineStage,
} from '@open-mercato/core/modules/customers/data/entities'
import { normalizePipelineStageLabel } from '@open-mercato/core/modules/customers/lib/closureStage'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('rfq_intake').child({ component: 'pipeline' })

export type Scope = { tenantId: string; organizationId: string }

/** Identifies our pipeline among the tenant's rows. Labels move; this must not. */
export const RFQ_PIPELINE_NAME = 'RFQ'

/**
 * The RFQ funnel, defined here rather than clicked together in the Studio so that the
 * stage a step moves a case to is reviewable in a diff.
 *
 * `key` is the stable handle the workflow and the inbox action use; `label` is the row
 * text an operator reads and may rename without breaking anything, because every
 * lookup goes through the position, not the label.
 *
 * The two closing labels are English on purpose. `TERMINAL_PIPELINE_STAGE_LABELS`
 * (`customers/lib/closureStage.ts:17`) recognises a terminal stage by matching its
 * label against a fixed English set, so `Zaakceptowana` would leave a deal closed with
 * `status: 'win'` sitting in whatever stage it was in. Ugly beats silently broken.
 */
export const RFQ_PIPELINE_STAGES = [
  { key: 'new', label: 'Nowe zgłoszenie' },
  { key: 'quoting', label: 'Wycena w toku' },
  { key: 'review', label: 'Do sprawdzenia' },
  { key: 'sent', label: 'Oferta wysłana' },
  { key: 'won', label: 'Closed Won' },
  { key: 'lost', label: 'Closed Lost' },
] as const

export type RfqStageKey = (typeof RFQ_PIPELINE_STAGES)[number]['key']

export const RFQ_STAGE_KEYS = RFQ_PIPELINE_STAGES.map((stage) => stage.key) as RfqStageKey[]

function stageIndex(key: RfqStageKey): number {
  return RFQ_PIPELINE_STAGES.findIndex((stage) => stage.key === key)
}

async function loadPipelines(em: EntityManager, scope: Scope): Promise<CustomerPipeline[]> {
  return findWithDecryption(em, CustomerPipeline, { ...scope }, {}, scope)
}

async function loadStages(
  em: EntityManager,
  scope: Scope,
  pipelineId: string,
): Promise<CustomerPipelineStage[]> {
  return findWithDecryption(
    em,
    CustomerPipelineStage,
    { ...scope, pipelineId },
    { orderBy: { order: 'ASC' } },
    scope,
  )
}

/**
 * Names are matched in memory rather than in the query because pipeline and stage
 * labels are encryption candidates — a `where: { name }` would compare ciphertext.
 * The same reason core's own closure lookup loads the stages and filters them in JS.
 */
function matchesName(value: string, expected: string): boolean {
  return normalizePipelineStageLabel(value) === normalizePipelineStageLabel(expected)
}

export type EnsuredPipeline = {
  pipelineId: string
  stageIds: Record<RfqStageKey, string>
  created: boolean
}

/**
 * Creates the RFQ funnel if it is absent, tops up any stage that is missing, and makes
 * it the tenant's default so a deal opened without an explicit stage still lands here.
 *
 * Idempotent: safe to run on every `mercato init` and from the CLI on a tenant that
 * already has it. Stages are never renamed or deleted — an operator who renamed one in
 * the UI keeps their wording, and a stage that is gone is recreated at its position.
 */
export async function ensureRfqPipeline(em: EntityManager, scope: Scope): Promise<EnsuredPipeline> {
  const pipelines = await loadPipelines(em, scope)
  let pipeline = pipelines.find((candidate) => matchesName(candidate.name, RFQ_PIPELINE_NAME)) ?? null
  const created = pipeline === null

  if (!pipeline) {
    pipeline = em.create(CustomerPipeline, {
      ...scope,
      name: RFQ_PIPELINE_NAME,
      isDefault: true,
    })
    em.persist(pipeline)
    await em.flush()
  }

  // Ours is the default; anything else in this organization is demoted. Without this a
  // pre-existing "Default Pipeline" from `customers/setup.ts` keeps the flag and the
  // funnel an operator sees first is not the one the process drives.
  for (const other of pipelines) {
    if (other.id !== pipeline.id && other.isDefault) {
      other.isDefault = false
      em.persist(other)
    }
  }
  if (!pipeline.isDefault) {
    pipeline.isDefault = true
    em.persist(pipeline)
  }

  const existing = await loadStages(em, scope, pipeline.id)
  // Keyed rather than indexed because the ids are only readable after the flush: the
  // primary key is `defaultRaw: gen_random_uuid()`, so a freshly created row carries
  // no id until the insert comes back.
  const rows = new Map<RfqStageKey, CustomerPipelineStage>()

  for (const [index, stage] of RFQ_PIPELINE_STAGES.entries()) {
    const found =
      existing.find((candidate) => candidate.order === index) ??
      existing.find((candidate) => matchesName(candidate.label, stage.label)) ??
      null
    if (found) {
      rows.set(stage.key, found)
      continue
    }
    const row = em.create(CustomerPipelineStage, {
      ...scope,
      pipelineId: pipeline.id,
      label: stage.label,
      order: index,
    })
    em.persist(row)
    rows.set(stage.key, row)
  }

  await em.flush()

  const stageIds = {} as Record<RfqStageKey, string>
  for (const [key, row] of rows) stageIds[key] = row.id
  logger.info('RFQ pipeline ensured', { pipelineId: pipeline.id, created })
  return { pipelineId: pipeline.id, stageIds, created }
}

/**
 * The id of one RFQ stage, or `null` when the funnel has not been seeded yet.
 *
 * Read-only on purpose: a command running inside an accepted action or a workflow step
 * must not quietly create CRM structure. Seeding is `mercato rfq_intake seed-pipeline`
 * or `mercato init`, and a missing funnel is reported, not papered over.
 */
export async function resolveRfqStageId(
  em: EntityManager,
  scope: Scope,
  key: RfqStageKey,
): Promise<string | null> {
  const pipelines = await loadPipelines(em, scope)
  const pipeline = pipelines.find((candidate) => matchesName(candidate.name, RFQ_PIPELINE_NAME))
  if (!pipeline) return null
  const stages = await loadStages(em, scope, pipeline.id)
  const index = stageIndex(key)
  const stage =
    stages.find((candidate) => candidate.order === index) ??
    stages.find((candidate) => matchesName(candidate.label, RFQ_PIPELINE_STAGES[index].label))
  return stage?.id ?? null
}

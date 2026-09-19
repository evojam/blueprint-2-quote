import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const findWithDecryption = jest.fn<(...args: any[]) => Promise<any[]>>()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: any[]) => findWithDecryption(...args),
}))

import {
  CustomerPipeline,
  CustomerPipelineStage,
} from '@open-mercato/core/modules/customers/data/entities'
import { ensureRfqPipeline, resolveRfqStageId, RFQ_PIPELINE_STAGES } from '../lib/pipeline'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

type Row = Record<string, any>

/**
 * A fake EntityManager over two in-memory tables. `findWithDecryption` is mocked to
 * read them, because the real one decrypts labels that the test never encrypts.
 */
function makeEm(pipelines: Row[], stages: Row[]) {
  let seq = 0
  const persisted: Row[] = []
  const em = {
    create(entity: unknown, data: Row) {
      const row = { id: `generated-${++seq}`, ...data }
      if (entity === CustomerPipeline) pipelines.push(row)
      else stages.push(row)
      return row
    },
    persist(row: Row) {
      persisted.push(row)
    },
    async flush() {},
  }
  findWithDecryption.mockImplementation(async (_em, entity, where: Row) => {
    if (entity === CustomerPipeline) return pipelines
    return stages.filter((stage) => stage.pipelineId === where.pipelineId)
  })
  return { em: em as never, persisted }
}

describe('ensureRfqPipeline', () => {
  beforeEach(() => {
    findWithDecryption.mockReset()
  })

  it('creates the funnel with every stage, in order', async () => {
    const pipelines: Row[] = []
    const stages: Row[] = []
    const { em } = makeEm(pipelines, stages)

    const result = await ensureRfqPipeline(em, scope)

    expect(result.created).toBe(true)
    expect(pipelines).toHaveLength(1)
    expect(pipelines[0].isDefault).toBe(true)
    expect(stages.map((stage) => stage.label)).toEqual(RFQ_PIPELINE_STAGES.map((stage) => stage.label))
    expect(stages.map((stage) => stage.order)).toEqual([0, 1, 2, 3, 4, 5])
    expect(Object.keys(result.stageIds)).toHaveLength(RFQ_PIPELINE_STAGES.length)
  })

  it('names the closing stages in English so closure detection recognises them', () => {
    // `TERMINAL_PIPELINE_STAGE_LABELS` matches a fixed English set; Polish labels there
    // would leave a deal closed with `status: 'win'` in whatever stage it sat in.
    const labels = RFQ_PIPELINE_STAGES.map((stage) => stage.label.toLowerCase())
    expect(labels).toContain('closed won')
    expect(labels).toContain('closed lost')
  })

  it('demotes the pipeline customers seeded, so the funnel an operator opens is ours', async () => {
    const core = { id: 'core-1', ...scope, name: 'Default Pipeline', isDefault: true }
    const pipelines: Row[] = [core]
    const { em } = makeEm(pipelines, [])

    await ensureRfqPipeline(em, scope)

    expect(core.isDefault).toBe(false)
    expect(pipelines.find((row) => row.name === 'RFQ')?.isDefault).toBe(true)
  })

  it('is a no-op on a second run', async () => {
    const pipelines: Row[] = []
    const stages: Row[] = []
    const { em } = makeEm(pipelines, stages)

    const first = await ensureRfqPipeline(em, scope)
    const second = await ensureRfqPipeline(em, scope)

    expect(second.created).toBe(false)
    expect(pipelines).toHaveLength(1)
    expect(stages).toHaveLength(RFQ_PIPELINE_STAGES.length)
    expect(second.stageIds).toEqual(first.stageIds)
  })

  it('keeps a renamed stage and recreates only the one that is gone', async () => {
    const pipelines: Row[] = []
    const stages: Row[] = []
    const { em } = makeEm(pipelines, stages)
    await ensureRfqPipeline(em, scope)

    const renamed = stages[0]
    renamed.label = 'Świeże zapytanie'
    const dropped = stages.splice(2, 1)[0]

    const result = await ensureRfqPipeline(em, scope)

    expect(renamed.label).toBe('Świeże zapytanie')
    expect(result.stageIds.new).toBe(renamed.id)
    expect(result.stageIds.review).not.toBe(dropped.id)
    expect(stages).toHaveLength(RFQ_PIPELINE_STAGES.length)
  })
})

describe('resolveRfqStageId', () => {
  beforeEach(() => {
    findWithDecryption.mockReset()
  })

  it('answers null when nobody seeded the funnel, rather than inventing one', async () => {
    const { em } = makeEm([], [])
    await expect(resolveRfqStageId(em, scope, 'new')).resolves.toBeNull()
  })

  it('finds the stage by position, so a renamed label still resolves', async () => {
    const pipelines: Row[] = []
    const stages: Row[] = []
    const { em } = makeEm(pipelines, stages)
    await ensureRfqPipeline(em, scope)
    stages[1].label = 'W trakcie wyceny'

    await expect(resolveRfqStageId(em, scope, 'quoting')).resolves.toBe(stages[1].id)
  })
})

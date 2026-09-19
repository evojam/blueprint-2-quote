import { beforeEach, describe, expect, it, jest } from '@jest/globals'

import { ProcessDefinition } from '@open-mercato/enterprise/modules/agent_orchestrator/data/entities'
import { ensureRfqProcessDefinition } from '../lib/processDefinition'
import { RFQ_ANALYSIS_WORKFLOW_ID } from '../workflows'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

type Row = Record<string, any>

/**
 * A fake EntityManager over one in-memory table. Ids appear on flush, not on create:
 * the primary key is `defaultRaw: gen_random_uuid()`, so a caller that reads `row.id`
 * before the insert comes back would hand the indexer an undefined identifier.
 */
function makeEm(rows: Row[]) {
  let seq = 0
  const pending: Row[] = []
  return {
    async findOne(_entity: unknown, where: Row) {
      return (
        rows.find(
          (row) =>
            row.tenantId === where.tenantId &&
            row.organizationId === where.organizationId &&
            row.workflowId === where.workflowId &&
            (row.deletedAt ?? null) === null,
        ) ?? null
      )
    },
    create(_entity: unknown, data: Row) {
      const row: Row = { ...data }
      rows.push(row)
      pending.push(row)
      return row
    },
    persist(_row: Row) {},
    async flush() {
      for (const row of pending.splice(0)) row.id = `generated-${++seq}`
    },
  } as never
}

function makeContainer() {
  const markOrmEntityChange = jest.fn()
  const flushOrmEntityChanges = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const container = {
    resolve: () => ({ markOrmEntityChange, flushOrmEntityChanges }),
  } as never
  return { container, markOrmEntityChange, flushOrmEntityChanges }
}

describe('ensureRfqProcessDefinition', () => {
  let rows: Row[]

  beforeEach(() => {
    rows = []
  })

  it('creates the definition bound to the code workflow, with a manual entry point', async () => {
    const { container } = makeContainer()

    const result = await ensureRfqProcessDefinition(makeEm(rows), container, scope)

    expect(result.created).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      ...scope,
      workflowId: RFQ_ANALYSIS_WORKFLOW_ID,
      enabled: true,
    })
    expect(rows[0].description).toBe('Reads the RFQ PDF and matches its brief against the catalog.')
    // Without a manual trigger `startProcessExecutionCommand` 403s every hand-start.
    expect(rows[0].triggers).toEqual([{ kind: 'manual', requireFeatures: [] }])
  })

  /**
   * The orchestrator list reads this entity through the query index, so a row that is
   * persisted but never indexed is a row nobody sees — which is the whole bug this
   * seed exists to fix.
   */
  it('discharges the query-index obligation with the id the flush assigned', async () => {
    const { container, markOrmEntityChange, flushOrmEntityChanges } = makeContainer()

    await ensureRfqProcessDefinition(makeEm(rows), container, scope)

    expect(markOrmEntityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'created',
        identifiers: { id: 'generated-1', ...scope },
        indexer: { entityType: 'agent_orchestrator:process_definition' },
      }),
    )
    expect(flushOrmEntityChanges).toHaveBeenCalled()
  })

  it('is a no-op when the organization already has one, and does not re-index it', async () => {
    rows.push({ id: 'existing', ...scope, workflowId: RFQ_ANALYSIS_WORKFLOW_ID, deletedAt: null })
    const { container, markOrmEntityChange } = makeContainer()

    const result = await ensureRfqProcessDefinition(makeEm(rows), container, scope)

    expect(result).toEqual({ processDefinitionId: 'existing', created: false, updated: false })
    expect(rows).toHaveLength(1)
    expect(markOrmEntityChange).not.toHaveBeenCalled()
  })

  /**
   * `--force` is what makes a repo change reach a tenant that already has the row —
   * nothing else does, because no deploy step reseeds `process_definitions`.
   */
  it('rewrites the code-owned fields of a drifted row under force, and re-indexes it', async () => {
    rows.push({
      id: 'existing',
      ...scope,
      workflowId: RFQ_ANALYSIS_WORKFLOW_ID,
      deletedAt: null,
      name: 'Renamed in the Studio',
      description: 'stale',
      triggers: [],
      milestones: [{ key: 'kept', label: 'Kept', order: 0 }],
    })
    const { container, markOrmEntityChange } = makeContainer()

    const result = await ensureRfqProcessDefinition(makeEm(rows), container, scope, { force: true })

    expect(result).toEqual({ processDefinitionId: 'existing', created: false, updated: true })
    expect(rows[0].name).toBe('RFQ document analysis')
    expect(rows[0].triggers).toEqual([{ kind: 'manual', requireFeatures: [] }])
    // Operator-owned fields are not the repo's to overwrite.
    expect(rows[0].milestones).toEqual([{ key: 'kept', label: 'Kept', order: 0 }])
    expect(markOrmEntityChange).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'updated', identifiers: { id: 'existing', ...scope } }),
    )
  })

  it('writes nothing under force when the row already matches the repo', async () => {
    rows.push({
      id: 'existing',
      ...scope,
      workflowId: RFQ_ANALYSIS_WORKFLOW_ID,
      deletedAt: null,
      name: 'RFQ document analysis',
      description: 'Reads the RFQ PDF and matches its brief against the catalog.',
      triggers: [{ kind: 'manual', requireFeatures: [] }],
    })
    const { container, markOrmEntityChange } = makeContainer()

    const result = await ensureRfqProcessDefinition(makeEm(rows), container, scope, { force: true })

    expect(result.updated).toBe(false)
    expect(markOrmEntityChange).not.toHaveBeenCalled()
  })

  it('does not reuse another organization’s definition', async () => {
    rows.push({
      id: 'other-org',
      tenantId: scope.tenantId,
      organizationId: '33333333-3333-4333-8333-333333333333',
      workflowId: RFQ_ANALYSIS_WORKFLOW_ID,
      deletedAt: null,
    })
    const { container } = makeContainer()

    const result = await ensureRfqProcessDefinition(makeEm(rows), container, scope)

    expect(result.created).toBe(true)
    expect(rows).toHaveLength(2)
  })
})

describe('the seeded definition', () => {
  it('points at a workflow id the registry actually defines', () => {
    // A process whose `workflowId` drifts from `workflows.ts` starts nothing.
    expect(RFQ_ANALYSIS_WORKFLOW_ID).toBe('rfq_intake.analysis')
    expect(ProcessDefinition).toBeDefined()
  })
})

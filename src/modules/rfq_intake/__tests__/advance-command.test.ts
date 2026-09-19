import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const resolveRfqStageId = jest.fn<(...args: any[]) => Promise<string | null>>()

jest.mock('../lib/pipeline', () => {
  const actual = jest.requireActual('../lib/pipeline') as Record<string, unknown>
  return {
    ...actual,
    resolveRfqStageId: (...args: any[]) => resolveRfqStageId(...args),
  }
})

import { advanceDealStageCommand } from '../commands/pipeline'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}
const dealId = '33333333-3333-4333-8333-333333333333'

function makeCtx() {
  const calls: Array<{ id: string; input: any }> = []
  const ctx = {
    container: {
      resolve(name: string) {
        if (name === 'em') return { fork: () => ({}) }
        if (name === 'commandBus') {
          return {
            execute: async (id: string, options: any) => {
              calls.push({ id, input: options.input })
              return { result: { dealId }, logEntry: null }
            },
          }
        }
        throw new Error(`unexpected resolve ${name}`)
      },
    },
  }
  return { ctx: ctx as never, calls }
}

describe('rfq_intake.deal.advance', () => {
  beforeEach(() => {
    resolveRfqStageId.mockReset()
  })

  it('moves the case through the installed deal command, so the transition is recorded', async () => {
    resolveRfqStageId.mockResolvedValue('stage-quoting')
    const { ctx, calls } = makeCtx()

    const result = await advanceDealStageCommand.execute({ ...scope, dealId, stage: 'quoting' }, ctx)

    expect(result).toEqual({ moved: true, stageId: 'stage-quoting' })
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('customers.deals.update')
    expect(calls[0].input).toEqual({ ...scope, id: dealId, pipelineStageId: 'stage-quoting' })
  })

  it('leaves the case alone when the funnel is not seeded, instead of failing the run', async () => {
    resolveRfqStageId.mockResolvedValue(null)
    const { ctx, calls } = makeCtx()

    const result = await advanceDealStageCommand.execute({ ...scope, dealId, stage: 'review' }, ctx)

    // The analysis is the valuable part of the run; an unseeded pipeline must not lose it.
    expect(result).toEqual({ moved: false, stageId: null })
    expect(calls).toHaveLength(0)
  })

  it('rejects a stage the funnel does not define', async () => {
    const { ctx } = makeCtx()
    await expect(
      advanceDealStageCommand.execute({ ...scope, dealId, stage: 'shipped' } as never, ctx),
    ).rejects.toThrow()
  })
})

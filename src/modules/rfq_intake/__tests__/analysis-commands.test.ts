import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const getArtifactBytes = jest.fn<(...args: any[]) => Promise<Buffer | null>>()

// The agent id is a one-line constant, but importing it for real drags the whole
// ai-assistant LLM bootstrap (ESM) into a CommonJS test run. Production code keeps
// the single source of the id; the test stubs the module.
jest.mock('@/modules/property_documents/ai-agents', () => ({
  CATALOG_MATCHER_AGENT_ID: 'property_documents.catalog_matcher',
}))
jest.mock('@open-mercato/enterprise/modules/agent_orchestrator/lib/runtime/artifactFileStore', () => ({
  getArtifactBytes: (...args: any[]) => getArtifactBytes(...args),
}))
jest.mock('@open-mercato/enterprise/modules/agent_orchestrator/data/entities', () => ({
  AgentRun: class AgentRun {},
  AgentRunArtifact: class AgentRunArtifact {},
}))
jest.mock('@open-mercato/shared/lib/commands', () => ({
  registerCommand: jest.fn(),
}))

import { analyzePlansCommand, matchRequirementsCommand } from '../commands/analysis'

const INPUT = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  dealId: '33333333-3333-4333-8333-333333333333',
  workflowInstanceId: '44444444-4444-4444-8444-444444444444',
  stepId: 'measure_plans',
}

type Artifact = { id: string; fileName: string; storageKey: string }

function buildCtx(options: {
  artifacts: Artifact[]
  manifests: Record<string, unknown>
  agentRun?: (agentId: string, input: unknown) => Promise<unknown>
  promote?: () => Promise<{ attachmentId: string }>
}) {
  const agentCalls: Array<{ agentId: string; input: any }> = []
  const promoted: string[] = []

  const em = {
    fork: () => em,
    findOne: async (_entity: unknown, where: any) => {
      if ('agentId' in where) return { id: 'run-1' }
      const artifact = options.artifacts.find((entry) => entry.fileName === where.fileName)
      return artifact ?? null
    },
    find: async () => options.artifacts,
  }

  const container = {
    resolve: (name: string) => {
      if (name === 'em') return em
      if (name === 'agentRuntime') {
        return {
          run: async (agentId: string, input: unknown) => {
            agentCalls.push({ agentId, input })
            return options.agentRun ? options.agentRun(agentId, input) : { kind: 'research', data: {} }
          },
        }
      }
      if (name === 'commandBus') {
        return {
          // The real bus takes `{ input, ctx }` and answers `{ result, logEntry }`;
          // mocking the bare-payload shape would hide a caller that got it wrong.
          execute: async (id: string, callOptions: any) => {
            if (id !== 'agent_orchestrator.artifact.promote') throw new Error(`unexpected command ${id}`)
            const payload = callOptions.input
            promoted.push(payload.fileName)
            const result = options.promote ? options.promote() : { attachmentId: `att-${payload.fileName}` }
            return { result, logEntry: null }
          },
        }
      }
      throw new Error(`unexpected resolve ${name}`)
    },
  }

  getArtifactBytes.mockImplementation(async (_container: any, _scope: any, storageKey: string) => {
    const artifact = options.artifacts.find((entry) => entry.storageKey === storageKey)
    if (!artifact) return null
    const manifest = options.manifests[artifact.fileName]
    return manifest === undefined ? null : Buffer.from(JSON.stringify(manifest), 'utf8')
  })

  return { ctx: { container, auth: { sub: 'user-1' } } as never, agentCalls, promoted }
}

const PLAN_ARTIFACTS: Artifact[] = [
  { id: 'a-manifest', fileName: 'floor-plans.json', storageKey: 'k-manifest' },
  { id: 'a-1', fileName: 'plan-1.png', storageKey: 'k1' },
  { id: 'a-2', fileName: 'plan-2.png', storageKey: 'k2' },
  { id: 'a-3', fileName: 'plan-3.png', storageKey: 'k3' },
]

const THREE_PLANS = {
  'floor-plans.json': {
    plans: [
      { sourcePage: 2, title: 'Architectural', artifactPath: 'out/plan-1.png' },
      { sourcePage: 3, title: 'Electrical', artifactPath: 'out/plan-2.png' },
      { sourcePage: 4, title: 'Plumbing', artifactPath: 'out/plan-3.png' },
    ],
  },
}

describe('rfq_intake.plans.analyze', () => {
  beforeEach(() => {
    getArtifactBytes.mockReset()
  })

  it('promotes and measures every plan, not just the first', async () => {
    const { ctx, agentCalls, promoted } = buildCtx({ artifacts: PLAN_ARTIFACTS, manifests: THREE_PLANS })

    const result = await analyzePlansCommand.execute(INPUT, ctx)

    expect(result).toMatchObject({ analysed: 3, failed: 0 })
    expect(promoted).toEqual(['plan-1.png', 'plan-2.png', 'plan-3.png'])
    expect(agentCalls).toHaveLength(3)
    expect(agentCalls[0].agentId).toBe('property_documents.room_dimensions')
    // room_dimensions accepts exactly one image, staged under a stable name.
    expect(agentCalls[0].input.__files.attachments).toEqual([
      { attachmentId: 'att-plan-1.png', as: 'floor-plan.png' },
    ])
  })

  it('keeps the other plans when one fails', async () => {
    const { ctx, agentCalls } = buildCtx({
      artifacts: PLAN_ARTIFACTS,
      manifests: THREE_PLANS,
      agentRun: async (_agentId, input: any) => {
        if (input.__files.attachments[0].attachmentId === 'att-plan-2.png') throw new Error('vision failed')
        return { kind: 'research', data: {} }
      },
    })

    const result = await analyzePlansCommand.execute(INPUT, ctx)

    expect(result).toMatchObject({ analysed: 2, failed: 1 })
    expect(agentCalls).toHaveLength(3)
  })

  it('is a no-op when the brief carried no plans', async () => {
    const { ctx, agentCalls } = buildCtx({
      artifacts: [{ id: 'a-manifest', fileName: 'floor-plans.json', storageKey: 'k-manifest' }],
      manifests: { 'floor-plans.json': { plans: [] } },
    })

    const result = await analyzePlansCommand.execute(INPUT, ctx)

    expect(result).toEqual({ analysed: 0, failed: 0, rooms: [] })
    expect(agentCalls).toHaveLength(0)
  })
})

describe('rfq_intake.requirements.match', () => {
  beforeEach(() => {
    getArtifactBytes.mockReset()
  })

  const BRIEF_ARTIFACTS: Artifact[] = [{ id: 'a-brief', fileName: 'brief.json', storageKey: 'kb' }]
  const FIVE_REQUIREMENTS = {
    'brief.json': {
      requirements: [
        { category: 'walls', text: 'malowanie ścian w salonie' },
        { category: 'floors', text: 'układanie paneli' },
        { category: 'electrics', text: 'wymiana instalacji elektrycznej' },
        { category: 'other', text: 'wywóz gruzu' },
        { category: 'other', text: 'coś, czego katalog nie zna' },
      ],
    },
  }

  it('calls the matcher once per requirement and reports the unmatched one', async () => {
    const { ctx, agentCalls } = buildCtx({
      artifacts: BRIEF_ARTIFACTS,
      manifests: FIVE_REQUIREMENTS,
      agentRun: async (_agentId, input: any) =>
        input.text.startsWith('coś')
          ? { kind: 'research', data: { matches: [], unmatchedTerms: [input.text] } }
          : { kind: 'research', data: { matches: [{ catalogProductId: 'p-1' }] } },
    })

    const result = await matchRequirementsCommand.execute(INPUT, ctx)

    // Every service has to reach the quote: five requirements, five calls.
    expect(agentCalls).toHaveLength(5)
    expect(agentCalls.every((call) => call.agentId === 'property_documents.catalog_matcher')).toBe(true)
    expect(result.matched).toBe(4)
    expect(result.unmatched).toEqual(['coś, czego katalog nie zna'])
  })

  it('reports a failed requirement instead of dropping it', async () => {
    const { ctx } = buildCtx({
      artifacts: BRIEF_ARTIFACTS,
      manifests: FIVE_REQUIREMENTS,
      agentRun: async (_agentId, input: any) => {
        if (input.text === 'wywóz gruzu') throw new Error('catalog search unavailable')
        return { kind: 'research', data: { matches: [{ catalogProductId: 'p-1' }] } }
      },
    })

    const result = await matchRequirementsCommand.execute(INPUT, ctx)

    expect(result.failed).toBe(1)
    expect(result.unmatched).toContain('wywóz gruzu')
  })
})

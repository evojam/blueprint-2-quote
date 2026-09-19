import { createHash } from 'node:crypto'
import type * as Zod from 'zod'
import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const getArtifactBytes = jest.fn<
  (container: unknown, scope: unknown, storageKey: string) => Promise<Buffer | null>
>()

jest.mock('@/modules/property_documents/ai-tools', () => ({
  PDF_AGENT_ID: 'property_documents.pdf_intake',
}))
jest.mock('@/modules/property_documents/ai-agents', () => {
  const { z } = jest.requireActual<typeof Zod>('zod')
  return {
    CATALOG_MATCHER_AGENT_ID: 'property_documents.catalog_matcher',
    catalogMatcherGroupedResultSchema: z
      .object({
        kind: z.literal('research'),
        data: z
          .object({
            contractVersion: z.literal(2),
            needs: z.array(z.unknown()),
            warnings: z.array(z.string()),
          })
          .strict(),
      })
      .strict(),
  }
})
jest.mock('@open-mercato/enterprise/modules/agent_orchestrator/lib/runtime/artifactFileStore', () => ({
  getArtifactBytes: (...args: [unknown, unknown, string]) => getArtifactBytes(...args),
}))
jest.mock('@open-mercato/enterprise/modules/agent_orchestrator/data/entities', () => ({
  AgentRun: class AgentRun {},
  AgentRunArtifact: class AgentRunArtifact {},
}))
jest.mock('@open-mercato/shared/lib/commands', () => ({
  registerCommand: jest.fn(),
}))

import {
  loadPdfIntakeBrief,
  matchRequirementsCommand,
} from '../commands/analysis'

const INPUT = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  workflowInstanceId: '44444444-4444-4444-8444-444444444444',
  stepId: 'match_catalog' as const,
}
const RUN_ID = '55555555-5555-4555-8555-555555555555'
const MATCHER_RUN_ID = '66666666-6666-4666-8666-666666666666'
const GROUPED_RESULT = {
  kind: 'research',
  data: {
    contractVersion: 2,
    needs: [],
    warnings: [],
  },
}

type Artifact = {
  id: string
  tenantId: string
  organizationId: string
  runId: string
  fileName: string
  mimeType: string
  fileSize: number
  sha256: string
  storageKey: string
  deletedAt: null
}

type MatcherRun = {
  id: string
  tenantId: string
  organizationId: string
  workflowInstanceId: string
  stepId: string
  agentId: string
  status: string
  output: unknown
  deletedAt: null
}

type Fixture = {
  briefArtifact: Artifact
  briefBytes: Buffer
  intakeRun: {
    id: string
    tenantId: string
    organizationId: string
    agentId: string
    workflowInstanceId: string
    stepId: string
    status: string
    resultKind: string
    output: {
      kind: string
      artifacts: Array<{ fileName: string; mimeType: string }>
      summary: string
    }
    deletedAt: null
  }
  matcherRuns: MatcherRun[]
  runtimeResult: unknown
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function makeArtifact(bytes: Buffer): Artifact {
  return {
    id: 'artifact-brief',
    tenantId: INPUT.tenantId,
    organizationId: INPUT.organizationId,
    runId: RUN_ID,
    fileName: 'brief.json',
    mimeType: 'application/json',
    fileSize: bytes.length,
    sha256: sha256(bytes),
    storageKey: 'storage/brief.json',
    deletedAt: null,
  }
}

function makeFixture(): Fixture {
  const briefBytes = Buffer.from(`${JSON.stringify({ brief: 'Exact raw text\f' })}\n`)
  return {
    briefArtifact: makeArtifact(briefBytes),
    briefBytes,
    intakeRun: {
      id: RUN_ID,
      tenantId: INPUT.tenantId,
      organizationId: INPUT.organizationId,
      agentId: 'property_documents.pdf_intake',
      workflowInstanceId: INPUT.workflowInstanceId,
      stepId: 'extract_pdf',
      status: 'ok',
      resultKind: 'artifact',
      output: {
        kind: 'artifact',
        artifacts: [
          { fileName: 'brief.json', mimeType: 'application/json' },
          { fileName: 'pdf-pages.json', mimeType: 'application/json' },
        ],
        summary: 'Extracted the raw PDF text and rendered every page.',
      },
      deletedAt: null,
    },
    matcherRuns: [],
    runtimeResult: GROUPED_RESULT,
  }
}

function makeMatcherRun(overrides: Partial<MatcherRun> = {}): MatcherRun {
  return {
    id: MATCHER_RUN_ID,
    tenantId: INPUT.tenantId,
    organizationId: INPUT.organizationId,
    workflowInstanceId: INPUT.workflowInstanceId,
    stepId: 'match_catalog',
    agentId: 'property_documents.catalog_matcher',
    status: 'ok',
    output: GROUPED_RESULT,
    deletedAt: null,
    ...overrides,
  }
}

function buildCtx(fixture: Fixture = makeFixture()) {
  let artifactWhere: Record<string, unknown> | null = null
  let matcherWhere: Record<string, unknown> | null = null
  const agentRuntime = {
    run: jest.fn(async () => fixture.runtimeResult),
  }
  const em = {
    fork: () => em,
    findOne: async (_entity: unknown, where: Record<string, unknown>) => {
      if ('agentId' in where) return fixture.intakeRun
      artifactWhere = where
      return fixture.briefArtifact
    },
    find: async (_entity: unknown, where: Record<string, unknown>) => {
      matcherWhere = where
      return fixture.matcherRuns.filter(
        (run) =>
          run.tenantId === where.tenantId &&
          run.organizationId === where.organizationId &&
          run.workflowInstanceId === where.workflowInstanceId &&
          run.stepId === where.stepId &&
          run.agentId === where.agentId &&
          run.status === where.status &&
          run.deletedAt === where.deletedAt,
      )
    },
  }
  const container = {
    resolve: (name: string) => {
      if (name === 'em') return em
      if (name === 'agentRuntime') return agentRuntime
      throw new Error(`unexpected resolve ${name}`)
    },
  }
  getArtifactBytes.mockImplementation(async (_container, _scope, storageKey) =>
    storageKey === fixture.briefArtifact.storageKey ? fixture.briefBytes : null,
  )
  return {
    ctx: {
      container,
      auth: {
        sub: 'user-1',
        tenantId: INPUT.tenantId,
        orgId: INPUT.organizationId,
      },
      selectedOrganizationId: INPUT.organizationId,
    } as never,
    agentRuntime,
    get artifactWhere() {
      return artifactWhere
    },
    get matcherWhere() {
      return matcherWhere
    },
  }
}

describe('loadPdfIntakeBrief', () => {
  beforeEach(() => {
    getArtifactBytes.mockReset()
  })

  it('returns only the exact raw brief after scoped validation', async () => {
    const harness = buildCtx()
    await expect(loadPdfIntakeBrief((harness.ctx.container.resolve('em') as never), harness.ctx, INPUT)).resolves.toEqual({
      runId: RUN_ID,
      brief: 'Exact raw text\f',
    })
    expect(harness.artifactWhere).toEqual({
      tenantId: INPUT.tenantId,
      organizationId: INPUT.organizationId,
      runId: RUN_ID,
      fileName: 'brief.json',
      deletedAt: null,
    })
    expect(getArtifactBytes).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['foreign artifact scope', (fixture: Fixture) => { fixture.briefArtifact.tenantId = '99999999-9999-4999-8999-999999999999' }, 'artifact scope mismatch'],
    ['wrong brief MIME', (fixture: Fixture) => { fixture.briefArtifact.mimeType = 'application/octet-stream' }, 'invalid artifact metadata'],
    ['SHA mismatch', (fixture: Fixture) => { fixture.briefArtifact.sha256 = 'a'.repeat(64) }, 'invalid artifact metadata'],
    ['malformed brief JSON', (fixture: Fixture) => { fixture.briefBytes = Buffer.from('{') }, 'invalid brief.json'],
    ['empty brief', (fixture: Fixture) => { fixture.briefBytes = Buffer.from(JSON.stringify({ brief: '' })) }, 'invalid brief.json'],
    ['oversized brief', (fixture: Fixture) => { fixture.briefBytes = Buffer.from(JSON.stringify({ brief: 'a'.repeat(65_537) })) }, 'invalid brief.json'],
  ])('rejects %s before runtime handoff', async (_name, mutate, message) => {
    const fixture = makeFixture()
    mutate(fixture)
    if (fixture.briefBytes.length !== fixture.briefArtifact.fileSize && message !== 'invalid artifact metadata') {
      fixture.briefArtifact = makeArtifact(fixture.briefBytes)
    }
    const harness = buildCtx(fixture)

    await expect(matchRequirementsCommand.execute(INPUT, harness.ctx)).rejects.toThrow(message)
    expect(harness.agentRuntime.run).not.toHaveBeenCalled()
  })
})

describe('matchRequirementsCommand', () => {
  beforeEach(() => {
    getArtifactBytes.mockReset()
  })

  it('hands the verified raw brief to the matcher with workflow scope', async () => {
    const harness = buildCtx()

    await expect(matchRequirementsCommand.execute(INPUT, harness.ctx)).resolves.toEqual(GROUPED_RESULT)
    expect(harness.agentRuntime.run).toHaveBeenCalledWith(
      'property_documents.catalog_matcher',
      {
        mode: 'grouped',
        text: 'Exact raw text\f',
        maxNeeds: 40,
        limitPerNeed: 5,
      },
      expect.objectContaining({
        tenantId: INPUT.tenantId,
        organizationId: INPUT.organizationId,
        workflowInstanceId: INPUT.workflowInstanceId,
        stepId: 'match_catalog',
        invocationId: expect.any(String),
      }),
    )
  })

  it('reuses only a prior grouped-v2 success', async () => {
    const fixture = makeFixture()
    fixture.matcherRuns = [makeMatcherRun()]
    const harness = buildCtx(fixture)

    await expect(matchRequirementsCommand.execute(INPUT, harness.ctx)).resolves.toEqual(GROUPED_RESULT)
    expect(harness.agentRuntime.run).not.toHaveBeenCalled()
    expect(harness.matcherWhere).toMatchObject({
      tenantId: INPUT.tenantId,
      organizationId: INPUT.organizationId,
      workflowInstanceId: INPUT.workflowInstanceId,
      stepId: 'match_catalog',
      agentId: 'property_documents.catalog_matcher',
      status: 'ok',
      deletedAt: null,
    })
  })

  it.each([
    ['legacy result', makeMatcherRun({ output: { kind: 'research', data: { matches: [], unmatchedTerms: [] } } })],
    ['error result', makeMatcherRun({ status: 'error' })],
  ])('does not reuse a prior %s', async (_name, matcherRun) => {
    const fixture = makeFixture()
    fixture.matcherRuns = [matcherRun]
    const harness = buildCtx(fixture)

    await expect(matchRequirementsCommand.execute(INPUT, harness.ctx)).resolves.toEqual(GROUPED_RESULT)
    expect(harness.agentRuntime.run).toHaveBeenCalledTimes(1)
  })
})

import { createHash } from 'node:crypto'
import { describe, expect, it, jest } from '@jest/globals'
import { z } from 'zod'

const getArtifactBytes = jest.fn<
  (container: unknown, scope: unknown, storageKey: string) => Promise<Buffer | null>
>()

jest.mock('@/modules/property_documents/ai-tools', () => ({
  PDF_AGENT_ID: 'property_documents.pdf_intake',
  ROOM_MEASUREMENTS_AGENT_ID: 'property_documents.room_measurements',
}))
jest.mock('@/modules/property_documents/ai-agents', () => ({
  CATALOG_MATCHER_AGENT_ID: 'property_documents.catalog_matcher',
  catalogMatcherGroupedResultSchema: z.unknown(),
  parseCatalogMatcherGroupedResult: (value: unknown) => value,
}))
jest.mock('@open-mercato/enterprise/modules/agent_orchestrator/data/entities', () => ({
  AgentRun: class AgentRun {},
  AgentRunArtifact: class AgentRunArtifact {},
}))
jest.mock('@open-mercato/enterprise/modules/agent_orchestrator/lib/runtime/artifactFileStore', () => ({
  getArtifactBytes: (...args: [unknown, unknown, string]) => getArtifactBytes(...args),
}))
jest.mock('@open-mercato/shared/lib/commands', () => ({ registerCommand: jest.fn() }))

import { measureRoomsCommand } from '../commands/analysis'

const INPUT = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  workflowInstanceId: '33333333-3333-4333-8333-333333333333',
  dealId: '44444444-4444-4444-8444-444444444444',
  stepId: 'measure_rooms' as const,
}
const RUN_ID = '55555555-5555-4555-8555-555555555555'

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
type Deferred = {
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}
type PromotionCall = {
  commandId: string
  input: {
    artifactId: string
    entityId: string
    recordId: string
    fileName: string
    tenantId: string
    organizationId: string
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function artifact(fileName: string, mimeType = 'image/png'): Artifact {
  const bytes = Buffer.from(fileName)
  return {
    id: `artifact-${fileName}`,
    tenantId: INPUT.tenantId,
    organizationId: INPUT.organizationId,
    runId: RUN_ID,
    fileName,
    mimeType,
    fileSize: bytes.length,
    sha256: sha256(bytes),
    storageKey: `storage/${fileName}`,
    deletedAt: null,
  }
}

function deferred(): Deferred {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  return { promise, resolve, reject }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function buildHarness(overrides: { artifacts?: Artifact[]; inventory?: unknown } = {}) {
  const pageFiles = ['pdf-page-0001.png', 'pdf-page-0002.png', 'pdf-page-0003.png']
  const inventoryBytes = Buffer.from(
    JSON.stringify(overrides.inventory ?? { pageCount: pageFiles.length, files: pageFiles }),
  )
  const inventoryArtifact = {
    ...artifact('pdf-pages.json', 'application/json'),
    fileSize: inventoryBytes.length,
    sha256: sha256(inventoryBytes),
    storageKey: 'storage/pdf-pages.json',
  }
  const artifacts = overrides.artifacts ?? pageFiles.map((fileName) => artifact(fileName))
  const waits = new Map<string, Deferred>()
  const agentRuntime = {
    run: jest.fn((agentId: string, input: unknown, context: { invocationId: string }) => {
      expect(agentId).toBe('property_documents.room_measurements')
      expect(input).toEqual(
        expect.objectContaining({
          __files: { attachments: [expect.objectContaining({ attachmentId: expect.any(String) })] },
        }),
      )
      const wait = deferred()
      waits.set(context.invocationId, wait)
      return wait.promise
    }),
  }
  const promotionCalls: PromotionCall[] = []
  const commandBus = {
    async execute<TInput, TResult>(
      commandId: string,
      options: { input: TInput },
    ): Promise<{ result: TResult }> {
      const input = options.input as unknown
      if (
        commandId !== 'agent_orchestrator.artifact.promote' ||
        !input ||
        typeof input !== 'object' ||
        !('artifactId' in input) ||
        !('entityId' in input) ||
        !('recordId' in input) ||
        !('fileName' in input) ||
        !('tenantId' in input) ||
        !('organizationId' in input)
      ) {
        throw new Error(`unexpected command ${commandId}`)
      }
      const promotion = {
        artifactId: String(input.artifactId),
        entityId: String(input.entityId),
        recordId: String(input.recordId),
        fileName: String(input.fileName),
        tenantId: String(input.tenantId),
        organizationId: String(input.organizationId),
      }
      promotionCalls.push({ commandId, input: promotion })
      // The generic command bus result is erased at this test-only boundary.
      return { result: { attachmentId: `attachment-${promotion.artifactId}` } as unknown as TResult }
    },
  }
  const intakeRun = {
    id: RUN_ID,
    tenantId: INPUT.tenantId,
    organizationId: INPUT.organizationId,
    workflowInstanceId: INPUT.workflowInstanceId,
    stepId: 'extract_pdf',
    agentId: 'property_documents.pdf_intake',
    status: 'ok',
    resultKind: 'artifact',
    output: {
      kind: 'artifact',
      artifacts: [
        { fileName: 'brief.json', mimeType: 'application/json' },
        { fileName: 'pdf-pages.json', mimeType: 'application/json' },
      ],
    },
    deletedAt: null,
  }
  const em = {
    fork: () => em,
    findOne: async (_entity: unknown, where: Record<string, unknown>) => {
      if ('agentId' in where) return intakeRun
      if (where.fileName === 'pdf-pages.json') return inventoryArtifact
      return null
    },
    find: async () => artifacts,
  }
  getArtifactBytes.mockImplementation(async (_container, _scope, storageKey) =>
    storageKey === inventoryArtifact.storageKey ? inventoryBytes : null,
  )
  const ctx = {
    auth: { sub: 'user-1', tenantId: INPUT.tenantId, orgId: INPUT.organizationId },
    selectedOrganizationId: INPUT.organizationId,
    container: {
      resolve: (name: string) => {
        if (name === 'em') return em
        if (name === 'agentRuntime') return agentRuntime
        if (name === 'commandBus') return commandBus
        throw new Error(`unexpected resolve ${name}`)
      },
    },
  } as never

  return { ctx, agentRuntime, promotionCalls, waits }
}

describe('measureRoomsCommand', () => {
  it('serializes page promotion and room-measurement runs', async () => {
    const harness = buildHarness()
    const pending = measureRoomsCommand.execute(INPUT, harness.ctx)

    await nextTurn()
    expect(harness.promotionCalls).toHaveLength(1)
    expect(harness.agentRuntime.run).toHaveBeenCalledTimes(1)
    expect(harness.promotionCalls[0]).toEqual({
      commandId: 'agent_orchestrator.artifact.promote',
      input: {
        tenantId: INPUT.tenantId,
        organizationId: INPUT.organizationId,
        artifactId: 'artifact-pdf-page-0001.png',
        entityId: 'customers:customer_deal',
        recordId: INPUT.dealId,
        fileName: 'pdf-page-0001.png',
      },
    })
    expect(harness.agentRuntime.run).toHaveBeenNthCalledWith(
      1,
      'property_documents.room_measurements',
      {
        __files: {
          attachments: [
            {
              attachmentId: 'attachment-artifact-pdf-page-0001.png',
              as: 'pdf-page-0001.png',
            },
          ],
        },
      },
      expect.objectContaining({
        tenantId: INPUT.tenantId,
        organizationId: INPUT.organizationId,
        workflowInstanceId: INPUT.workflowInstanceId,
        stepId: 'measure_rooms',
        invocationId: 'room-measurement:artifact-pdf-page-0001.png',
      }),
    )

    harness.waits.get('room-measurement:artifact-pdf-page-0001.png')!.resolve({ kind: 'research', data: {} })
    await nextTurn()
    expect(harness.promotionCalls).toHaveLength(2)
    expect(harness.agentRuntime.run).toHaveBeenCalledTimes(2)

    harness.waits.get('room-measurement:artifact-pdf-page-0002.png')!.resolve({ kind: 'research', data: {} })
    await nextTurn()
    expect(harness.promotionCalls).toHaveLength(3)
    expect(harness.agentRuntime.run).toHaveBeenCalledTimes(3)

    harness.waits.get('room-measurement:artifact-pdf-page-0003.png')!.resolve({ kind: 'research', data: {} })
    await expect(pending).resolves.toEqual({
      intakeRunId: RUN_ID,
      totalPages: 3,
      succeeded: 3,
      failed: [],
    })
  })

  it('continues with the next page after one room measurement run fails', async () => {
    const harness = buildHarness()
    const pending = measureRoomsCommand.execute(INPUT, harness.ctx)

    await nextTurn()
    harness.waits.get('room-measurement:artifact-pdf-page-0001.png')!.resolve({ kind: 'research', data: {} })
    await nextTurn()
    harness.waits.get('room-measurement:artifact-pdf-page-0002.png')!.reject(new Error('provider unavailable'))
    await nextTurn()
    expect(harness.agentRuntime.run).toHaveBeenCalledTimes(3)
    harness.waits.get('room-measurement:artifact-pdf-page-0003.png')!.resolve({ kind: 'research', data: {} })

    await expect(pending).resolves.toEqual({
      intakeRunId: RUN_ID,
      totalPages: 3,
      succeeded: 2,
      failed: [{ fileName: 'pdf-page-0002.png', reason: 'provider unavailable' }],
    })
  })

  it('rejects a non-PNG manifest artifact before promotion or agent handoff', async () => {
    const harness = buildHarness({
      artifacts: [
        artifact('pdf-page-0001.png'),
        artifact('pdf-page-0002.png', 'application/pdf'),
        artifact('pdf-page-0003.png'),
      ],
    })

    await expect(measureRoomsCommand.execute(INPUT, harness.ctx)).rejects.toThrow(
      'invalid rendered page artifact',
    )
    expect(harness.promotionCalls).toEqual([])
    expect(harness.agentRuntime.run).not.toHaveBeenCalled()
  })
})


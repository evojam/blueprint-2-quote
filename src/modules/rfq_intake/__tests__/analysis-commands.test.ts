import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const getArtifactBytes = jest.fn<
  (container: unknown, scope: unknown, storageKey: string) => Promise<Buffer | null>
>()

jest.mock('@/modules/property_documents/ai-tools', () => ({
  PDF_AGENT_ID: 'property_documents.pdf_intake',
}))
jest.mock('@/modules/property_documents/ai-agents', () => ({
  CATALOG_MATCHER_AGENT_ID: 'property_documents.catalog_matcher',
}))
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
  analyzePlansCommand,
  loadPdfIntakeArtifactSet,
  matchRequirementsCommand,
} from '../commands/analysis'

const INPUT = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  dealId: '33333333-3333-4333-8333-333333333333',
  workflowInstanceId: '44444444-4444-4444-8444-444444444444',
  stepId: 'measure_plans',
}
const RUN_ID = '55555555-5555-4555-8555-555555555555'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

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

type Fixture = {
  artifacts: Artifact[]
  bytesByFileName: Partial<Record<string, Buffer>>
  run: {
    id: string
    tenantId: string
    organizationId: string
    agentId: string
    workflowInstanceId: string
    status: string
    resultKind: string
    output: {
      kind: string
      artifacts: Array<{ fileName: string; mimeType: string }>
      summary: string
    }
    deletedAt: null
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function artifact(fileName: string, bytes: Buffer): Artifact {
  return {
    id: `artifact-${fileName}`,
    tenantId: INPUT.tenantId,
    organizationId: INPUT.organizationId,
    runId: RUN_ID,
    fileName,
    mimeType: fileName.endsWith('.png') ? 'image/png' : 'application/json',
    fileSize: bytes.length,
    sha256: sha256(bytes),
    storageKey: `storage/${fileName}`,
    deletedAt: null,
  }
}

function makeFixture(): Fixture {
  const bytesByFileName: Partial<Record<string, Buffer>> = {
    'brief.json': Buffer.from(`${JSON.stringify({ brief: 'Exact raw text\f' })}\n`),
    'pdf-pages.json': Buffer.from(
      `${JSON.stringify({
        pageCount: 2,
        files: ['pdf-page-0001.png', 'pdf-page-0002.png'],
      })}\n`,
    ),
    'pdf-page-0001.png': PNG,
    'pdf-page-0002.png': PNG,
  }
  const artifacts = Object.entries(bytesByFileName).map(([fileName, bytes]) => {
    if (!bytes) throw new Error(`missing fixture bytes for ${fileName}`)
    return artifact(fileName, bytes)
  })
  const run = {
    id: RUN_ID,
    tenantId: INPUT.tenantId,
    organizationId: INPUT.organizationId,
    agentId: 'property_documents.pdf_intake',
    workflowInstanceId: INPUT.workflowInstanceId,
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
  }
  return { artifacts, bytesByFileName, run }
}

function buildCtx(fixture: Fixture = makeFixture()) {
  let artifactWhere: Record<string, unknown> | null = null
  const em = {
    fork: () => em,
    findOne: async (_entity: unknown, where: Record<string, unknown>) =>
      'agentId' in where ? fixture.run : null,
    find: async (_entity: unknown, where: Record<string, unknown>) => {
      artifactWhere = where
      return fixture.artifacts
    },
  }
  const container = {
    resolve: (name: string) => {
      if (name === 'em') return em
      throw new Error(`unexpected resolve ${name}`)
    },
  }
  getArtifactBytes.mockImplementation(async (_container, _scope, storageKey) => {
    const row = fixture.artifacts.find((entry) => entry.storageKey === storageKey)
    return row ? fixture.bytesByFileName[row.fileName] ?? null : null
  })
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
    em: em as never,
    get artifactWhere() {
      return artifactWhere
    },
  }
}

async function load(fixture: Fixture = makeFixture()) {
  const harness = buildCtx(fixture)
  const result = await loadPdfIntakeArtifactSet(harness.em, harness.ctx, INPUT)
  return { ...harness, result }
}

describe('loadPdfIntakeArtifactSet', () => {
  beforeEach(() => {
    getArtifactBytes.mockReset()
  })

  it('returns exact raw brief text and ordered page artifact identities after scoped validation', async () => {
    const loaded = await load()

    expect(loaded.result).toEqual({
      runId: RUN_ID,
      brief: 'Exact raw text\f',
      pages: [
        {
          sourcePage: 1,
          artifactId: 'artifact-pdf-page-0001.png',
          fileName: 'pdf-page-0001.png',
        },
        {
          sourcePage: 2,
          artifactId: 'artifact-pdf-page-0002.png',
          fileName: 'pdf-page-0002.png',
        },
      ],
    })
    expect(loaded.artifactWhere).toEqual({
      tenantId: INPUT.tenantId,
      organizationId: INPUT.organizationId,
      runId: RUN_ID,
      deletedAt: null,
    })
  })

  it('rejects a missing captured artifact', async () => {
    const fixture = makeFixture()
    fixture.artifacts.pop()
    await expect(load(fixture)).rejects.toThrow('artifact set mismatch')
  })

  it('rejects an extra captured artifact', async () => {
    const fixture = makeFixture()
    const bytes = Buffer.from('{}')
    fixture.bytesByFileName['unexpected.json'] = bytes
    fixture.artifacts.push(artifact('unexpected.json', bytes))
    await expect(load(fixture)).rejects.toThrow('artifact set mismatch')
  })

  it('rejects unreadable captured bytes', async () => {
    const fixture = makeFixture()
    delete fixture.bytesByFileName['pdf-page-0002.png']
    await expect(load(fixture)).rejects.toThrow('unreadable artifact')
  })

  it('rejects mistyped captured metadata', async () => {
    const fixture = makeFixture()
    fixture.artifacts.find((row) => row.fileName === 'pdf-page-0001.png')!.mimeType =
      'application/octet-stream'
    await expect(load(fixture)).rejects.toThrow('invalid artifact metadata')
  })

  it('rejects a malformed or non-contiguous page inventory', async () => {
    const fixture = makeFixture()
    const bytes = Buffer.from(
      JSON.stringify({ pageCount: 2, files: ['pdf-page-0001.png', 'pdf-page-0003.png'] }),
    )
    fixture.bytesByFileName['pdf-pages.json'] = bytes
    Object.assign(
      fixture.artifacts.find((row) => row.fileName === 'pdf-pages.json')!,
      artifact('pdf-pages.json', bytes),
    )
    await expect(load(fixture)).rejects.toThrow('invalid pdf-pages.json')
  })

  it('rejects bytes that do not have a PNG signature', async () => {
    const fixture = makeFixture()
    const bytes = Buffer.from('not a png')
    fixture.bytesByFileName['pdf-page-0001.png'] = bytes
    Object.assign(
      fixture.artifacts.find((row) => row.fileName === 'pdf-page-0001.png')!,
      artifact('pdf-page-0001.png', bytes),
    )
    await expect(load(fixture)).rejects.toThrow('invalid PNG artifact')
  })

  it('rejects a foreign or run-mismatched row even if persistence returns it', async () => {
    const fixture = makeFixture()
    fixture.artifacts[0]!.runId = '66666666-6666-4666-8666-666666666666'
    await expect(load(fixture)).rejects.toThrow('artifact scope mismatch')
  })

  it('rejects an AgentResult that references anything except the two control files', async () => {
    const fixture = makeFixture()
    fixture.run.output.artifacts[1] = {
      fileName: 'pdf-page-0001.png',
      mimeType: 'image/png',
    }
    await expect(load(fixture)).rejects.toThrow('invalid AgentResult')
  })
})

describe('deferred RFQ intake consumers', () => {
  beforeEach(() => {
    getArtifactBytes.mockReset()
  })

  it.each([
    ['rfq_intake.plans.analyze', analyzePlansCommand],
    ['rfq_intake.requirements.match', matchRequirementsCommand],
  ])('%s validates the captured set and stops before semantic work', async (_id, command) => {
    const { ctx } = buildCtx()

    await expect(command.execute(INPUT, ctx)).rejects.toThrow(
      '[internal] PDF_INTAKE_DOWNSTREAM_DEFERRED',
    )
    expect(getArtifactBytes).toHaveBeenCalledTimes(4)
  })
})

import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const emitRfqIntakeEvent = jest.fn<(...args: any[]) => Promise<void>>()
const startRfqAnalysisProcess = jest.fn<(...args: any[]) => Promise<any>>()
const findOneWithDecryption = jest.fn<(...args: any[]) => Promise<any>>()
const resolveResendApiKey = jest.fn<(...args: any[]) => Promise<any>>()
const fetchInboundPdfs = jest.fn<(...args: any[]) => Promise<any>>()
const storeInboundPdfs = jest.fn<(...args: any[]) => Promise<any>>()

jest.mock('../events', () => ({
  emitRfqIntakeEvent: (...args: any[]) => emitRfqIntakeEvent(...args),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: any[]) => findOneWithDecryption(...args),
}))
jest.mock('../lib/startProcess', () => ({
  startRfqAnalysisProcess: (...args: any[]) => startRfqAnalysisProcess(...args),
}))
jest.mock('../lib/inboundAttachments', () => ({
  resolveResendApiKey: (...args: any[]) => resolveResendApiKey(...args),
  fetchInboundPdfs: (...args: any[]) => fetchInboundPdfs(...args),
  storeInboundPdfs: (...args: any[]) => storeInboundPdfs(...args),
}))

import handler, { type ActionExecutedPayload } from '../subscribers/start-rfq-analysis'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const DEAL = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'

// The handler only ever resolves `em` and immediately forks it; nothing in these
// paths touches the fork, because every read goes through the mocked finder.
const ctx = { resolve: () => ({ fork: () => ({}) }) } as unknown as Parameters<typeof handler>[1]

function executedAction(overrides: Partial<ActionExecutedPayload> = {}): ActionExecutedPayload {
  return {
    actionType: 'create_quote',
    createdEntityType: 'customer_deal',
    createdEntityId: DEAL,
    proposalId: 'proposal-1',
    executedByUserId: USER,
    tenantId: TENANT,
    organizationId: ORG,
    ...overrides,
  }
}

describe('start-rfq-analysis', () => {
  beforeEach(() => {
    emitRfqIntakeEvent.mockReset()
    startRfqAnalysisProcess.mockReset()
    startRfqAnalysisProcess.mockResolvedValue({ started: true })
    findOneWithDecryption.mockReset()
    // Proposal first, then the e-mail behind it.
    findOneWithDecryption
      .mockResolvedValueOnce({ id: 'proposal-1', inboxEmailId: 'email-1' })
      .mockResolvedValueOnce({ id: 'email-1', attachmentIds: ['attachment-1'] })
    resolveResendApiKey.mockReset()
    resolveResendApiKey.mockResolvedValue({ apiKey: 'test-key', source: 'environment' })
    fetchInboundPdfs.mockReset()
    fetchInboundPdfs.mockResolvedValue([])
    storeInboundPdfs.mockReset()
    storeInboundPdfs.mockResolvedValue([])
  })

  /**
   * The acting user is what the whole chain runs as. `loadCodeTriggers` reads
   * exactly `payload.userId`; without it the instance gets `initiatedBy:
   * 'trigger:<id>'`, and a code workflow has no `grantedFeatures` and no
   * `createdBy` to recover an identity from — so INVOKE_AGENT and UPDATE_ENTITY
   * both refuse and the chain dies on its first step.
   */
  it('carries the inbox actor onto the event as userId', async () => {
    await handler(executedAction(), ctx)

    expect(emitRfqIntakeEvent).toHaveBeenCalledTimes(1)
    const [eventId, payload] = emitRfqIntakeEvent.mock.calls[0] as [string, any]
    expect(eventId).toBe('rfq_intake.rfq.created')
    expect(payload.userId).toBe(USER)
    expect(payload).toMatchObject({ dealId: DEAL, tenantId: TENANT, organizationId: ORG })
  })

  /**
   * Starting through the process is what puts the run in the orchestrator's execution
   * history AND what gives it an acting user — `parseTriggeredByUser` yields one only
   * for a `manual` entry. Starting the workflow directly would do neither.
   */
  it('starts the orchestrator process as the acting user, with the document attached', async () => {
    await handler(executedAction(), ctx)

    expect(startRfqAnalysisProcess).toHaveBeenCalledTimes(1)
    const [, , scope, userId, input] = startRfqAnalysisProcess.mock.calls[0] as any[]
    expect(scope).toEqual({ tenantId: TENANT, organizationId: ORG })
    expect(userId).toBe(USER)
    expect(input).toMatchObject({ dealId: DEAL, proposalId: 'proposal-1', emailId: 'email-1' })
    // Without `__files` the agent has no document to read.
    expect(input.__files.attachments).toEqual([{ attachmentId: 'attachment-1' }])
  })

  it('reports a case whose process could not start instead of failing silently', async () => {
    startRfqAnalysisProcess.mockResolvedValue({ started: false, reason: 'no RFQ process definition' })

    await expect(handler(executedAction(), ctx)).resolves.toBeUndefined()
    expect(startRfqAnalysisProcess).toHaveBeenCalledTimes(1)
  })

  it('does not start a run it knows cannot write, when the actor is missing', async () => {
    await handler(executedAction({ executedByUserId: null }), ctx)

    expect(emitRfqIntakeEvent).not.toHaveBeenCalled()
    expect(startRfqAnalysisProcess).not.toHaveBeenCalled()
  })

  it('does not start a run when the scope is incomplete', async () => {
    await handler(executedAction({ organizationId: null }), ctx)

    expect(emitRfqIntakeEvent).not.toHaveBeenCalled()
  })

  it('opens the case without an analysis when the RFQ has no attachments', async () => {
    findOneWithDecryption.mockReset()
    findOneWithDecryption
      .mockResolvedValueOnce({ id: 'proposal-1', inboxEmailId: 'email-1' })
      .mockResolvedValueOnce({ id: 'email-1', attachmentIds: [] })

    await handler(executedAction(), ctx)

    expect(emitRfqIntakeEvent).not.toHaveBeenCalled()
    expect(startRfqAnalysisProcess).not.toHaveBeenCalled()
  })

  // The lazy pull: nothing writes `attachment_ids` on the way in, so an empty list is
  // the normal case and the RFQ's PDFs are fetched here, at the moment a human accepted it.
  it('pulls the attachments when the e-mail has none linked, then starts the analysis', async () => {
    findOneWithDecryption.mockReset()
    findOneWithDecryption
      .mockResolvedValueOnce({ id: 'proposal-1', inboxEmailId: 'email-1' })
      .mockResolvedValueOnce({ id: 'email-1', attachmentIds: [], messageId: '<abc@mail>' })
    fetchInboundPdfs.mockResolvedValue([{ fileName: 'rzut.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') }])
    storeInboundPdfs.mockResolvedValue(['attachment-new'])

    await handler(executedAction(), ctx)

    expect(fetchInboundPdfs).toHaveBeenCalledWith({ apiKey: 'test-key', messageId: '<abc@mail>' })
    // The files belong to the CASE: the deal's Files tab lists attachments by
    // entityId/recordId, so an id stored against the e-mail row would never show there.
    expect(storeInboundPdfs).toHaveBeenCalledWith(expect.objectContaining({ dealId: DEAL }))
    // The `em` stub has no `findOne`, so writing the link back throws. That is
    // deliberate here: the attachments are already in storage and usable, so a failed
    // link must not discard them — the analysis still has to start.
    expect(startRfqAnalysisProcess).toHaveBeenCalled()
    const event = emitRfqIntakeEvent.mock.calls[0]?.[1] as { __files: { attachments: Array<{ attachmentId: string }> } }
    expect(event.__files.attachments).toEqual([{ attachmentId: 'attachment-new' }])
  })

  // Idempotence: a second acceptance of the same RFQ must not go back to the provider.
  it('does not touch the provider when attachments are already linked', async () => {
    await handler(executedAction(), ctx)

    expect(resolveResendApiKey).not.toHaveBeenCalled()
    expect(fetchInboundPdfs).not.toHaveBeenCalled()
    expect(startRfqAnalysisProcess).toHaveBeenCalled()
  })

  // A provider outage, an unconfigured integration or a genuinely attachment-free
  // enquiry all land here, and all keep today's behavior: the case is open, no analysis.
  it('keeps the case open when the pull yields nothing', async () => {
    findOneWithDecryption.mockReset()
    findOneWithDecryption
      .mockResolvedValueOnce({ id: 'proposal-1', inboxEmailId: 'email-1' })
      .mockResolvedValueOnce({ id: 'email-1', attachmentIds: [], messageId: '<abc@mail>' })
    fetchInboundPdfs.mockResolvedValue([])

    await handler(executedAction(), ctx)

    expect(fetchInboundPdfs).toHaveBeenCalled()
    expect(emitRfqIntakeEvent).not.toHaveBeenCalled()
    expect(startRfqAnalysisProcess).not.toHaveBeenCalled()
  })

  it('ignores an executed action that is not an RFQ case', async () => {
    await handler(executedAction({ createdEntityType: 'sales_quote' }), ctx)

    expect(emitRfqIntakeEvent).not.toHaveBeenCalled()
    expect(findOneWithDecryption).not.toHaveBeenCalled()
  })
})

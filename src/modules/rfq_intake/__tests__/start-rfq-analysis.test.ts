import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const emitRfqIntakeEvent = jest.fn<(...args: any[]) => Promise<void>>()
const startRfqAnalysisProcess = jest.fn<(...args: any[]) => Promise<any>>()
const findOneWithDecryption = jest.fn<(...args: any[]) => Promise<any>>()
const findWithDecryption = jest.fn<(...args: any[]) => Promise<any[]>>()

jest.mock('../events', () => ({
  emitRfqIntakeEvent: (...args: any[]) => emitRfqIntakeEvent(...args),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: any[]) => findOneWithDecryption(...args),
  findWithDecryption: (...args: any[]) => findWithDecryption(...args),
}))
jest.mock('../lib/startProcess', () => ({
  startRfqAnalysisProcess: (...args: any[]) => startRfqAnalysisProcess(...args),
}))

import handler, { type ActionExecutedPayload } from '../subscribers/start-rfq-analysis'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const DEAL = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'

// The handler only ever resolves `em` and immediately forks it; nothing in these
// paths touches the fork, because every read goes through the mocked finder.
const ctx = { resolve: () => ({ fork: () => ({}) }) } as unknown as Parameters<typeof handler>[1]

const CUSTOMER = '55555555-5555-4555-8555-555555555555'
const CHANNEL = '66666666-6666-4666-8666-666666666666'

function executedAction(overrides: Partial<ActionExecutedPayload> = {}): ActionExecutedPayload {
  return {
    actionId: 'action-1',
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
    // Proposal, then the e-mail behind it, then the executed action row the CRM
    // facets are read from.
    findOneWithDecryption
      .mockResolvedValueOnce({ id: 'proposal-1', inboxEmailId: 'email-1' })
      .mockResolvedValueOnce({ id: 'email-1', attachmentIds: ['attachment-1'] })
      .mockResolvedValueOnce({
        id: 'action-1',
        payload: { customerEntityId: CUSTOMER, channelId: CHANNEL },
      })
    findWithDecryption.mockReset()
    findWithDecryption.mockResolvedValue([{ id: 'attachment-1', mimeType: 'application/pdf' }])
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
    // Flat start context: the agent step builds the runtime's `__files` envelope from
    // `attachmentId` itself, so nothing here carries transport shape. Every key the
    // workflow interpolates must be present — interpolation is strict.
    expect(input).toEqual({
      dealId: DEAL,
      proposalId: 'proposal-1',
      emailId: 'email-1',
      attachmentId: 'attachment-1',
      customerId: CUSTOMER,
      channelId: CHANNEL,
    })
  })

  /**
   * `pdf_intake` refuses anything but exactly one staged file, so a logo in the
   * signature must not travel with the brief.
   */
  it('picks the first PDF and leaves every other attachment behind', async () => {
    findOneWithDecryption.mockReset()
    findOneWithDecryption
      .mockResolvedValueOnce({ id: 'proposal-1', inboxEmailId: 'email-1' })
      .mockResolvedValueOnce({ id: 'email-1', attachmentIds: ['logo-1', 'brief-1', 'brief-2'] })
      .mockResolvedValueOnce({ id: 'action-1', payload: {} })
    // Deliberately out of e-mail order: `$in` guarantees none, so the pick must come
    // from the e-mail's own list.
    findWithDecryption.mockResolvedValue([
      { id: 'brief-2', mimeType: 'application/pdf' },
      { id: 'logo-1', mimeType: 'image/png' },
      { id: 'brief-1', mimeType: 'application/pdf' },
    ])

    await handler(executedAction(), ctx)

    const [, , , , input] = startRfqAnalysisProcess.mock.calls[0] as any[]
    expect(input.attachmentId).toBe('brief-1')
  })

  it('carries a null customer and channel rather than dropping the keys', async () => {
    findOneWithDecryption.mockReset()
    findOneWithDecryption
      .mockResolvedValueOnce({ id: 'proposal-1', inboxEmailId: 'email-1' })
      .mockResolvedValueOnce({ id: 'email-1', attachmentIds: ['attachment-1'] })
      .mockResolvedValueOnce({ id: 'action-1', payload: {} })

    await handler(executedAction(), ctx)

    const [, , , , input] = startRfqAnalysisProcess.mock.calls[0] as any[]
    // Present with a null value: strict interpolation fails on a missing KEY, not on
    // a null one, so the step must still be able to resolve both tokens.
    expect(input).toMatchObject({ customerId: null, channelId: null })
    expect('customerId' in input).toBe(true)
    expect('channelId' in input).toBe(true)
  })

  it('opens the case without an analysis when no attachment is a PDF', async () => {
    findWithDecryption.mockResolvedValue([{ id: 'attachment-1', mimeType: 'image/png' }])

    await handler(executedAction(), ctx)

    expect(emitRfqIntakeEvent).not.toHaveBeenCalled()
    expect(startRfqAnalysisProcess).not.toHaveBeenCalled()
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

  it('ignores an executed action that is not an RFQ case', async () => {
    await handler(executedAction({ createdEntityType: 'sales_quote' }), ctx)

    expect(emitRfqIntakeEvent).not.toHaveBeenCalled()
    expect(findOneWithDecryption).not.toHaveBeenCalled()
  })
})

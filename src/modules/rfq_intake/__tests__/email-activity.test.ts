import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { interactionCreateSchema } from '@open-mercato/core/modules/customers/data/validators'

const executeCommand = jest.fn<(...args: any[]) => Promise<any>>()
const findOneWithDecryption = jest.fn<(...args: any[]) => Promise<any>>()

jest.mock('@open-mercato/core/modules/inbox_ops/lib/executionHelpers', () => ({
  asHelperContext: (ctx: unknown) => ctx,
  executeCommand: (...args: any[]) => executeCommand(...args),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: any[]) => findOneWithDecryption(...args),
}))

import { logInboundEmailActivity } from '../lib/emailActivity'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const DEAL = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const PERSON = '55555555-5555-4555-8555-555555555555'

const ctx = {
  tenantId: TENANT,
  organizationId: ORG,
  userId: USER,
  em: {},
  container: {},
} as never

const RECEIVED_AT = new Date('2026-09-18T09:30:00.000Z')

function inboxRows(overrides: Record<string, unknown> = {}): void {
  findOneWithDecryption
    .mockResolvedValueOnce({ id: 'proposal-1', inboxEmailId: 'email-1' })
    .mockResolvedValueOnce({
      id: 'email-1',
      subject: 'Zapytanie o wycenę remontu',
      forwardedByAddress: 'marek@evojam.com',
      forwardedByName: 'Marek Grochala',
      toAddress: 'oferty@evojam.com',
      cleanedText: 'W załączeniu przesyłam rzuty.',
      receivedAt: RECEIVED_AT,
      ...overrides,
    })
}

describe('logInboundEmailActivity', () => {
  beforeEach(() => {
    executeCommand.mockReset()
    executeCommand.mockResolvedValue({ interactionId: 'interaction-1' })
    findOneWithDecryption.mockReset()
  })

  it('logs the e-mail on the deal as a completed email interaction', async () => {
    inboxRows()

    const id = await logInboundEmailActivity(ctx, {
      proposalId: 'proposal-1',
      dealId: DEAL,
      customerEntityId: PERSON,
    })

    expect(id).toBe('interaction-1')
    const [, commandId, payload] = executeCommand.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(commandId).toBe('customers.interactions.create')
    expect(payload).toMatchObject({
      // Both ids matter: `entityId` is the timeline's parent, `dealId` is what puts the
      // row on THIS case rather than only on the person's history.
      entityId: PERSON,
      dealId: DEAL,
      interactionType: 'email',
      status: 'done',
      occurredAt: RECEIVED_AT,
      // `private` would hide the row from everyone but its author, with no admin bypass.
      visibility: 'shared',
    })
    expect(payload.body).toContain('marek@evojam.com')
    expect(payload.body).toContain('W załączeniu przesyłam rzuty.')
  })

  // The payload used to be written against the deprecated activity bridge's field names.
  // Parse the real schema so the contract cannot drift silently.
  it('sends a payload the installed interaction command accepts', async () => {
    inboxRows()

    await logInboundEmailActivity(ctx, {
      proposalId: 'proposal-1',
      dealId: DEAL,
      customerEntityId: PERSON,
    })

    const payload = (executeCommand.mock.calls[0] as unknown[])[2]
    expect(() => interactionCreateSchema.parse(payload)).not.toThrow()
  })

  // Best effort: the case is the deliverable, a timeline row is not worth losing it over.
  it('returns null instead of throwing when the command fails', async () => {
    inboxRows()
    executeCommand.mockRejectedValue(new Error('nope'))

    await expect(
      logInboundEmailActivity(ctx, { proposalId: 'proposal-1', dealId: DEAL, customerEntityId: PERSON }),
    ).resolves.toBeNull()
  })

  it('skips the activity when the e-mail behind the proposal is not visible', async () => {
    findOneWithDecryption
      .mockResolvedValueOnce({ id: 'proposal-1', inboxEmailId: 'email-1' })
      .mockResolvedValueOnce(null)

    const id = await logInboundEmailActivity(ctx, {
      proposalId: 'proposal-1',
      dealId: DEAL,
      customerEntityId: PERSON,
    })

    expect(id).toBeNull()
    expect(executeCommand).not.toHaveBeenCalled()
  })
})

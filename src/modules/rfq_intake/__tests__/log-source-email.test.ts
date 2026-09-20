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

import { logSourceEmailActivity } from '../lib/logSourceEmail'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const DEAL = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const CONTACT = '55555555-5555-4555-8555-555555555555'

const ctx = {
  tenantId: TENANT,
  organizationId: ORG,
  userId: USER,
  em: {},
  container: {},
} as never

const input = { proposalId: 'proposal-1', dealId: DEAL, contactEntityId: CONTACT }

function interactionPayload(): Record<string, unknown> {
  const call = executeCommand.mock.calls.find((entry) => entry[1] === 'customers.interactions.create')
  if (!call) throw new Error('customers.interactions.create was never executed')
  return call[2] as Record<string, unknown>
}

/** Proposal first, then the e-mail behind it — the order the function reads them in. */
function found(email: Record<string, unknown> | null): void {
  findOneWithDecryption
    .mockResolvedValueOnce({ id: 'proposal-1', inboxEmailId: 'email-1', summary: 'Enquiry summary' })
    .mockResolvedValueOnce(email)
}

describe('logSourceEmailActivity', () => {
  beforeEach(() => {
    executeCommand.mockReset()
    executeCommand.mockResolvedValue({ interactionId: 'interaction-1' })
    findOneWithDecryption.mockReset()
  })

  it('logs the e-mail on both the deal and the contact', async () => {
    const receivedAt = new Date('2026-09-18T09:30:00.000Z')
    found({ subject: 'Wycena remontu', cleanedText: 'Dzień dobry, proszę o wycenę.', receivedAt })

    const result = await logSourceEmailActivity(ctx, input)

    expect(result).toBe('interaction-1')
    // Both ids: `dealId` is what the deal's timeline queries by, `entityId` is what it
    // refuses to render a row without.
    expect(interactionPayload()).toMatchObject({
      entityId: CONTACT,
      dealId: DEAL,
      interactionType: 'email',
      title: 'Wycena remontu',
      body: 'Dzień dobry, proszę o wycenę.',
      status: 'done',
      occurredAt: receivedAt,
      authorUserId: USER,
      source: 'inbox_ops:rfq',
    })
  })

  // The sibling contact path was written against invented field names once already; parse
  // the installed schema so this command's contract cannot drift silently either.
  it('sends a payload the installed interaction command accepts', async () => {
    found({ subject: 'Wycena remontu', cleanedText: 'Treść zapytania.', receivedAt: new Date() })

    await logSourceEmailActivity(ctx, input)

    expect(() => interactionCreateSchema.parse(interactionPayload())).not.toThrow()
  })

  it('falls back to the raw text, then to the proposal summary', async () => {
    found({ subject: null, cleanedText: '  ', rawText: 'Raw body' })
    await logSourceEmailActivity(ctx, input)
    expect(interactionPayload()).toMatchObject({ title: 'RFQ', body: 'Raw body' })

    executeCommand.mockClear()
    found(null)
    await logSourceEmailActivity(ctx, input)
    expect(interactionPayload()).toMatchObject({ body: 'Enquiry summary' })
  })

  it('truncates a body the command would reject', async () => {
    found({ subject: 'Long', cleanedText: 'x'.repeat(12000) })

    await logSourceEmailActivity(ctx, input)

    const body = interactionPayload().body as string
    expect(body).toHaveLength(10000)
    expect(body.endsWith('[…]')).toBe(true)
    expect(() => interactionCreateSchema.parse(interactionPayload())).not.toThrow()
  })

  it('writes nothing when the proposal is out of scope', async () => {
    findOneWithDecryption.mockResolvedValueOnce(null)

    await expect(logSourceEmailActivity(ctx, input)).resolves.toBeNull()
    expect(executeCommand).not.toHaveBeenCalled()
  })

  // Best effort: the case and its analysis are the point of the action, so a failed audit
  // copy of the e-mail must never throw back into the acceptance.
  it('swallows a failing command', async () => {
    found({ subject: 'Wycena', cleanedText: 'Treść' })
    executeCommand.mockRejectedValue(new Error('command bus unavailable'))

    await expect(logSourceEmailActivity(ctx, input)).resolves.toBeNull()
  })
})

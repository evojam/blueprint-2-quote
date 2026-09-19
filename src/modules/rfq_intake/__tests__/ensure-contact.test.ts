import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const executeCommand = jest.fn<(...args: any[]) => Promise<any>>()
const resolveCustomerEntityIdByEmail = jest.fn<(...args: any[]) => Promise<string | null>>()
const findOneWithDecryption = jest.fn<(...args: any[]) => Promise<any>>()

jest.mock('@open-mercato/core/modules/inbox_ops/lib/executionHelpers', () => ({
  asHelperContext: (ctx: unknown) => ctx,
  executeCommand: (...args: any[]) => executeCommand(...args),
  resolveCustomerEntityIdByEmail: (...args: any[]) => resolveCustomerEntityIdByEmail(...args),
  resolveEntityClass: () => class CustomerEntity {},
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: any[]) => findOneWithDecryption(...args),
}))

import { ensureContact } from '../lib/ensureContact'

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  em: {},
  container: {},
} as never

function commandIds(): string[] {
  return executeCommand.mock.calls.map((call) => call[1] as string)
}

describe('ensureContact', () => {
  beforeEach(() => {
    executeCommand.mockReset()
    resolveCustomerEntityIdByEmail.mockReset()
    findOneWithDecryption.mockReset()
  })

  it('creates the person when the sender is unknown', async () => {
    resolveCustomerEntityIdByEmail.mockResolvedValue(null)
    executeCommand.mockResolvedValue({ entityId: 'person-1' })

    const result = await ensureContact(ctx, { email: 'Anna@Example.com', name: 'Anna Kowalska' })

    expect(result).toEqual({ customerEntityId: 'person-1', companyEntityId: null, created: true })
    expect(commandIds()).toEqual(['customers.people.create'])
    // Normalized, so a second RFQ from "ANNA@example.com" resolves the same row.
    expect(executeCommand.mock.calls[0][2]).toMatchObject({ email: 'anna@example.com' })
  })

  it('ensures the company as well when the thread names one', async () => {
    resolveCustomerEntityIdByEmail.mockResolvedValue(null)
    executeCommand.mockImplementation(async (_ctx: any, id: string) =>
      id === 'customers.companies.create' ? { entityId: 'company-1' } : { entityId: 'person-1' },
    )

    const result = await ensureContact(ctx, {
      email: 'anna@example.com',
      name: 'Anna',
      companyName: 'Kowalska Remonty',
    })

    expect(result?.companyEntityId).toBe('company-1')
    expect(commandIds()).toEqual(['customers.companies.create', 'customers.people.create'])
  })

  it('fills only empty fields on an existing person', async () => {
    resolveCustomerEntityIdByEmail.mockResolvedValue('person-9')
    findOneWithDecryption.mockResolvedValue({
      id: 'person-9',
      displayName: 'Anna Kowalska',
      primaryPhone: null,
    })
    executeCommand.mockResolvedValue({})

    const result = await ensureContact(ctx, {
      email: 'anna@example.com',
      name: 'A. KOWALSKA (sent from my iPhone)',
      phone: '+48 600 100 200',
    })

    expect(result).toEqual({ customerEntityId: 'person-9', companyEntityId: null, created: false })
    expect(commandIds()).toEqual(['customers.people.update'])
    const patch = executeCommand.mock.calls[0][2] as Record<string, unknown>
    // The signature-derived name must not overwrite what a human already curated.
    expect(patch).not.toHaveProperty('name')
    expect(patch).toMatchObject({ phone: '+48 600 100 200' })
  })

  it('writes nothing when the existing person already has every field', async () => {
    resolveCustomerEntityIdByEmail.mockResolvedValue('person-9')
    findOneWithDecryption.mockResolvedValue({
      id: 'person-9',
      displayName: 'Anna Kowalska',
      primaryPhone: '+48 600 100 200',
    })

    await ensureContact(ctx, { email: 'anna@example.com', name: 'Anna K', phone: '+48 111 222 333' })

    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('returns null without an e-mail, because nothing can be resolved idempotently', async () => {
    const result = await ensureContact(ctx, { name: 'Anna' })
    expect(result).toBeNull()
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('keeps the contact when ensuring the company fails', async () => {
    resolveCustomerEntityIdByEmail.mockResolvedValue(null)
    executeCommand.mockImplementation(async (_ctx: any, id: string) => {
      if (id === 'customers.companies.create') throw new Error('company service down')
      return { entityId: 'person-1' }
    })

    const result = await ensureContact(ctx, {
      email: 'anna@example.com',
      name: 'Anna',
      companyName: 'Kowalska Remonty',
    })

    expect(result).toEqual({ customerEntityId: 'person-1', companyEntityId: null, created: true })
  })
})

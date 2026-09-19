import { describe, expect, it } from '@jest/globals'
import { parseSeedArgs, resolveOrganizationScope } from '../lib/args'

const ORG_ID = '11111111-2222-3333-4444-555555555555'
const TENANT_ID = '99999999-8888-7777-6666-555555555555'

describe('parseSeedArgs', () => {
  it('reads the organization id from a separate value', () => {
    expect(parseSeedArgs(['--org', ORG_ID])).toEqual({
      organizationId: ORG_ID,
      dryRun: false,
    })
  })

  it('reads the organization id from an inline value together with the dry-run flag', () => {
    expect(parseSeedArgs([`--org=${ORG_ID}`, '--dry-run'])).toEqual({
      organizationId: ORG_ID,
      dryRun: true,
    })
  })

  it('rejects a missing organization id', () => {
    expect(() => parseSeedArgs(['--dry-run'])).toThrow('--org is required')
  })

  it('rejects a non-uuid organization id', () => {
    expect(() => parseSeedArgs(['--org', 'Acme Corp'])).toThrow('--org must be a UUID')
  })

  it('rejects a flag swallowing the next flag as its value', () => {
    expect(() => parseSeedArgs(['--org', '--dry-run'])).toThrow('Missing value for --org')
  })

  it('rejects unknown arguments', () => {
    expect(() => parseSeedArgs(['--org', ORG_ID, '--tenant', TENANT_ID])).toThrow('Unknown argument "--tenant"')
  })
})

describe('resolveOrganizationScope', () => {
  it('derives the tenant from the organization record', () => {
    expect(
      resolveOrganizationScope(ORG_ID, { id: ORG_ID, name: 'Acme Corp', tenant: { id: TENANT_ID } }),
    ).toEqual({ organizationId: ORG_ID, tenantId: TENANT_ID })
  })

  it('fails closed when the organization is missing', () => {
    expect(() => resolveOrganizationScope(ORG_ID, null)).toThrow(`Organization ${ORG_ID} not found.`)
  })

  it('fails closed when the organization is soft-deleted', () => {
    expect(() =>
      resolveOrganizationScope(ORG_ID, { id: ORG_ID, deletedAt: new Date(), tenant: { id: TENANT_ID } }),
    ).toThrow(`Organization ${ORG_ID} is deleted.`)
  })

  it('fails closed when the organization has no tenant', () => {
    expect(() => resolveOrganizationScope(ORG_ID, { id: ORG_ID, tenant: null })).toThrow(
      `Organization ${ORG_ID} has no tenant.`,
    )
  })
})

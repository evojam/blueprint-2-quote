export const USAGE =
  'Usage: mercato catalog_seed seed-renovation-catalog --org <organizationId> [--dry-run] [--backfill-vat]'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type SeedArgs = {
  organizationId: string
  dryRun: boolean
  backfillVat: boolean
}

export type OrganizationRecord = {
  id: string
  name?: string | null
  deletedAt?: Date | null
  tenant?: { id: string } | null
}

export type OrganizationScope = {
  organizationId: string
  tenantId: string
}

export function parseSeedArgs(argv: string[]): SeedArgs {
  let organizationId: string | null = null
  let dryRun = false
  let backfillVat = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--dry-run' || arg === '--dryRun') {
      dryRun = true
      continue
    }
    if (arg === '--backfill-vat' || arg === '--backfillVat') {
      backfillVat = true
      continue
    }
    const [flag, inlineValue] = arg.split('=')
    if (flag === '--org' || flag === '--organizationId' || flag === '--orgId') {
      const value = inlineValue ?? argv[i + 1]
      if (inlineValue === undefined) i += 1
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${flag}. ${USAGE}`)
      }
      organizationId = value
      continue
    }
    throw new Error(`Unknown argument "${arg}". ${USAGE}`)
  }

  if (!organizationId) {
    throw new Error(`--org is required. ${USAGE}`)
  }
  if (!UUID_PATTERN.test(organizationId)) {
    throw new Error(`--org must be a UUID, got "${organizationId}". ${USAGE}`)
  }

  return { organizationId, dryRun, backfillVat }
}

export function resolveOrganizationScope(
  organizationId: string,
  organization: OrganizationRecord | null,
): OrganizationScope {
  if (!organization) {
    throw new Error(`Organization ${organizationId} not found.`)
  }
  if (organization.deletedAt) {
    throw new Error(`Organization ${organizationId} is deleted.`)
  }
  const tenantId = organization.tenant?.id
  if (!tenantId) {
    throw new Error(`Organization ${organizationId} has no tenant.`)
  }
  return { organizationId: organization.id, tenantId }
}

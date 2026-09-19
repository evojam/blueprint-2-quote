import type { InboxActionExecutionContext } from '@open-mercato/shared/modules/inbox-actions'
import {
  asHelperContext,
  executeCommand,
  resolveCustomerEntityIdByEmail,
  resolveEntityClass,
} from '@open-mercato/core/modules/inbox_ops/lib/executionHelpers'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('rfq_intake').child({ component: 'ensure-contact' })

export type ContactHints = {
  email?: string | null
  name?: string | null
  phone?: string | null
  companyName?: string | null
}

export type EnsuredContact = {
  customerEntityId: string
  companyEntityId: string | null
  created: boolean
}

type MutableEntity = {
  id: string
  displayName?: string | null
  primaryEmail?: string | null
  primaryPhone?: string | null
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Guarantees the sender exists as a CRM person before the RFQ case is opened.
 *
 * The extraction worker already PROPOSES `create_contact` / `link_contact` beside
 * the quote action, but those are separate rows an operator can reject and that can
 * fail on their own. REQ-005 asks for a guarantee, so the work happens here, inside
 * the accepted action, and is idempotent by e-mail: when the worker's own contact
 * action already ran, this is a no-op that returns the existing id.
 *
 * An existing person is enriched in EMPTY fields only. A costing clerk's manual
 * correction outranks a name or phone the LLM lifted from a signature, and the next
 * RFQ from the same address must not silently undo it.
 */
export async function ensureContact(
  ctx: InboxActionExecutionContext,
  hints: ContactHints,
): Promise<EnsuredContact | null> {
  const hCtx = asHelperContext(ctx)
  const email = trimmed(hints.email)?.toLowerCase() ?? null
  const name = trimmed(hints.name)
  const phone = trimmed(hints.phone)
  const companyName = trimmed(hints.companyName)

  if (!email) {
    logger.warn('RFQ action carries no customer e-mail; cannot guarantee a contact', {
      organizationId: ctx.organizationId,
    })
    return null
  }

  const companyEntityId = companyName ? await ensureCompany(ctx, companyName) : null

  const existingId = await resolveCustomerEntityIdByEmail(hCtx, email)
  if (existingId) {
    await enrichEmptyFields(ctx, existingId, { name, phone })
    return { customerEntityId: existingId, companyEntityId, created: false }
  }

  const result = await executeCommand<Record<string, unknown>, { entityId?: string; id?: string }>(
    hCtx,
    'customers.people.create',
    {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      name: name ?? email,
      email,
      ...(phone ? { phone } : {}),
      ...(companyName ? { companyName } : {}),
      source: 'inbox_ops',
    },
  )
  const createdId = result?.entityId ?? result?.id
  if (!createdId) return null
  return { customerEntityId: createdId, companyEntityId, created: true }
}

async function ensureCompany(
  ctx: InboxActionExecutionContext,
  companyName: string,
): Promise<string | null> {
  const hCtx = asHelperContext(ctx)
  try {
    const result = await executeCommand<Record<string, unknown>, { entityId?: string; id?: string }>(
      hCtx,
      'customers.companies.create',
      {
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        name: companyName,
        source: 'inbox_ops',
      },
    )
    return result?.entityId ?? result?.id ?? null
  } catch (error) {
    // A company is context, not the guarantee. Losing it must not cost us the case.
    logger.warn('Failed to ensure company for RFQ', { err: error, companyName })
    return null
  }
}

/**
 * Fills only what is empty. Reads the row directly rather than through the update
 * command so a field that already holds a value is never part of the patch.
 */
async function enrichEmptyFields(
  ctx: InboxActionExecutionContext,
  customerEntityId: string,
  values: { name: string | null; phone: string | null },
): Promise<void> {
  if (!values.name && !values.phone) return
  const hCtx = asHelperContext(ctx)
  const CustomerEntityClass = resolveEntityClass(hCtx, 'CustomerEntity')
  if (!CustomerEntityClass) return

  const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
  const entity = (await findOneWithDecryption(
    hCtx.em,
    CustomerEntityClass,
    { id: customerEntityId, ...scope, deletedAt: null },
    undefined,
    scope,
  )) as MutableEntity | null
  if (!entity) return

  const patch: Record<string, unknown> = {}
  if (values.name && !trimmed(entity.displayName)) patch.name = values.name
  if (values.phone && !trimmed(entity.primaryPhone)) patch.phone = values.phone
  if (Object.keys(patch).length === 0) return

  try {
    await executeCommand(hCtx, 'customers.people.update', {
      id: customerEntityId,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      ...patch,
    })
  } catch (error) {
    // Enrichment is a nicety; the guarantee is that the contact EXISTS.
    logger.warn('Failed to enrich existing contact', { err: error, customerEntityId })
  }
}

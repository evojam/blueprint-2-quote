import type { EntityManager } from '@mikro-orm/postgresql'
import type { InboxActionExecutionContext } from '@open-mercato/shared/modules/inbox-actions'
import { InboxEmail, InboxProposal } from '@open-mercato/core/modules/inbox_ops/data/entities'
import { asHelperContext, executeCommand } from '@open-mercato/core/modules/inbox_ops/lib/executionHelpers'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('rfq_intake').child({ component: 'log-source-email' })

/** Marks the activity as written by the RFQ intake, alongside `RFQ_DEAL_SOURCE`. */
export const RFQ_EMAIL_ACTIVITY_SOURCE = 'inbox_ops:rfq'

/** `interactionCreateSchema` caps the body at 10000 chars (customers/data/validators.ts:496). */
const BODY_LIMIT = 10000
/** …and the title at 500. */
const TITLE_LIMIT = 500
const TRUNCATION_MARK = '\n\n[…]'

export type LogSourceEmailInput = {
  proposalId: string
  dealId: string
  /** The person or company row that owns the timeline the deal renders. */
  contactEntityId: string
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function clampBody(text: string): string {
  if (text.length <= BODY_LIMIT) return text
  return `${text.slice(0, BODY_LIMIT - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`
}

/**
 * Logs the enquiry e-mail as an `email` activity on the freshly opened RFQ case.
 *
 * The deal's activity timeline reads `/api/customers/interactions?dealId=…` but renders
 * only rows that also carry an `entityId` (`customers/backend/customers/deals/[id]/page.tsx:507`
 * — "Activities on a deal still need a customer record for timeline ownership"), so BOTH
 * ids go on the row. `ensureContact` has already guaranteed the contact by the time the
 * caller gets here.
 *
 * Best effort, like `ensureContact`'s company lookup: the case and its analysis are the
 * point of the action, and losing the audit copy of the e-mail must not cost the operator
 * the acceptance. Returns the interaction id, or null when nothing was written.
 *
 * HACK(hackathon): the row carries no hard link back to the channel message.
 * `CustomerInteraction` has `external_message_id` (with a dedupe unique index on it), but
 * `customers.interactions.create` does not accept the field — it is absent from
 * `interactionCreateSchema` — so the e-mail's text in `body` is the whole record. What
 * breaks: no "open the original message" affordance, and no schema-level dedupe if this
 * ever runs twice for one proposal. It does not today: a retry of the action creates a
 * new deal too, so there is no row to collide with.
 */
export async function logSourceEmailActivity(
  ctx: InboxActionExecutionContext,
  input: LogSourceEmailInput,
): Promise<string | null> {
  const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
  try {
    const em = ctx.em as EntityManager
    const proposal = await findOneWithDecryption(
      em,
      InboxProposal,
      { id: input.proposalId, ...scope, deletedAt: null },
      undefined,
      scope,
    )
    if (!proposal) {
      logger.warn('Proposal behind the RFQ action is not visible in this scope; no e-mail logged', {
        proposalId: input.proposalId,
      })
      return null
    }

    const email = await findOneWithDecryption(
      em,
      InboxEmail,
      { id: proposal.inboxEmailId, ...scope, deletedAt: null },
      undefined,
      scope,
    )

    // The proposal's summary is the honest fallback: it is what the extraction read, and
    // an activity naming the enquiry beats none. Inventing a body is not an option.
    const body = trimmed(email?.cleanedText) ?? trimmed(email?.rawText) ?? trimmed(proposal.summary)
    if (!body) {
      logger.warn('Source e-mail carries no readable text; no activity logged', {
        dealId: input.dealId,
        emailId: proposal.inboxEmailId,
      })
      return null
    }

    const title = trimmed(email?.subject) ?? 'RFQ'
    const result = await executeCommand<Record<string, unknown>, { interactionId?: string }>(
      asHelperContext(ctx),
      'customers.interactions.create',
      {
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        entityId: input.contactEntityId,
        dealId: input.dealId,
        interactionType: 'email',
        title: title.slice(0, TITLE_LIMIT),
        body: clampBody(body),
        // The enquiry already happened; it belongs in the history, not in the planned
        // strip the deal renders above it.
        status: 'done',
        ...(email?.receivedAt ? { occurredAt: email.receivedAt } : {}),
        authorUserId: ctx.userId,
        source: RFQ_EMAIL_ACTIVITY_SOURCE,
      },
    )

    const interactionId = trimmed(result?.interactionId)
    if (!interactionId) {
      logger.warn('Interaction command returned no id; the e-mail may not be on the case', {
        dealId: input.dealId,
      })
      return null
    }

    logger.info('Source e-mail logged as an activity on the RFQ case', {
      dealId: input.dealId,
      interactionId,
      emailId: proposal.inboxEmailId,
    })
    return interactionId
  } catch (error) {
    logger.warn('Could not log the source e-mail on the RFQ case; the case is unaffected', {
      dealId: input.dealId,
      proposalId: input.proposalId,
      err: error,
    })
    return null
  }
}

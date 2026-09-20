import type { EntityManager } from '@mikro-orm/postgresql'
import type { InboxActionExecutionContext } from '@open-mercato/shared/modules/inbox-actions'
import { InboxEmail, InboxProposal } from '@open-mercato/core/modules/inbox_ops/data/entities'
import { asHelperContext, executeCommand } from '@open-mercato/core/modules/inbox_ops/lib/executionHelpers'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('rfq_intake').child({ component: 'email-activity' })

/** `body` is capped at 10000 by `interactionCreateSchema`; leave room for the header. */
const MAX_BODY = 9_000

export type EmailActivityInput = {
  proposalId: string
  dealId: string
  /** The `customer_entities` row the timeline hangs off — an interaction has no other parent. */
  customerEntityId: string
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function buildBody(email: InboxEmail): string {
  const sender = trimmed(email.forwardedByName)
    ? `${email.forwardedByName} <${email.forwardedByAddress}>`
    : email.forwardedByAddress
  // HACK(hackathon): the header labels are hardcoded Polish. Like the deal body in
  // `inbox-actions.ts`, this is DATA written once into a record, not a rendered string,
  // so there is no request locale to resolve a key against at write time.
  // What breaks: a non-Polish operator reads Polish labels around correct values.
  const header = [`Od: ${sender}`, `Do: ${email.toAddress}`].join('\n')
  const text = trimmed(email.cleanedText) ?? trimmed(email.rawText) ?? ''
  return [header, text.slice(0, MAX_BODY)].filter(Boolean).join('\n\n')
}

/**
 * Logs the e-mail that opened an RFQ case as an `email` activity on that case.
 *
 * The deal comes FROM a message, so its timeline should start with that message rather
 * than with whatever a clerk types next: the enquiry's wording is the brief every later
 * question is answered against.
 *
 * Written through `customers.interactions.create` — the canonical command;
 * `customers.activities.create` is the deprecated bridge that forwards to it. The
 * timeline's parent is a CUSTOMER entity, not the deal (`requireTimelineParentEntity`,
 * `customers/commands/interactions.ts:385`), and the deal detail page renders exactly
 * the rows whose `entityId` is one of the deal's linked people/companies filtered by
 * `dealId` — so both ids are required for the row to appear on the case.
 *
 * `visibility: 'shared'` is deliberate: `buildEmailVisibilityMikroFilter` hides an
 * `email` interaction marked `private` from everyone but its author, with no admin
 * bypass. An RFQ arriving at the shared intake address is team correspondence.
 *
 * Best effort: a missing e-mail row or a rejected command is logged and swallowed. The
 * case itself is the deliverable, and losing it over a timeline entry is the worse
 * outcome — the same rule `ensureContact` follows.
 */
export async function logInboundEmailActivity(
  ctx: InboxActionExecutionContext,
  input: EmailActivityInput,
): Promise<string | null> {
  const hCtx = asHelperContext(ctx)
  const em = ctx.em as EntityManager
  const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }

  try {
    const proposal = await findOneWithDecryption(
      em,
      InboxProposal,
      { id: input.proposalId, ...scope, deletedAt: null },
      undefined,
      scope,
    )
    if (!proposal) {
      logger.warn('Proposal behind the RFQ action is not visible; no e-mail activity logged', {
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
    if (!email) {
      logger.warn('E-mail behind the RFQ action is not visible; no activity logged', {
        proposalId: input.proposalId,
        emailId: proposal.inboxEmailId,
      })
      return null
    }

    const result = await executeCommand<Record<string, unknown>, { interactionId?: string; id?: string }>(
      hCtx,
      'customers.interactions.create',
      {
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        entityId: input.customerEntityId,
        dealId: input.dealId,
        interactionType: 'email',
        title: (trimmed(email.subject) ?? 'RFQ').slice(0, 500),
        body: buildBody(email),
        // It already happened, so it belongs in the history, not in the planned list:
        // `status: 'done'` plus `occurredAt` is the pair the timeline reads.
        status: 'done',
        occurredAt: email.receivedAt,
        visibility: 'shared',
        authorUserId: ctx.userId,
        source: 'inbox_ops:rfq',
      },
    )

    const interactionId = result?.interactionId ?? result?.id ?? null
    logger.info('Logged the inbound e-mail on the RFQ case', {
      dealId: input.dealId,
      emailId: proposal.inboxEmailId,
      interactionId,
    })
    return interactionId
  } catch (error) {
    logger.warn('Could not log the inbound e-mail as an activity; the case stays open', {
      dealId: input.dealId,
      proposalId: input.proposalId,
      err: error,
    })
    return null
  }
}

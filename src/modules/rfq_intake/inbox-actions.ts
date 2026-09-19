import type { InboxActionDefinition, InboxActionExecutionContext } from '@open-mercato/shared/modules/inbox-actions'
import { z } from 'zod'
import { orderPayloadSchema } from '@open-mercato/core/modules/inbox_ops/data/validators'
import {
  asHelperContext,
  executeCommand,
  ExecutionError,
} from '@open-mercato/core/modules/inbox_ops/lib/executionHelpers'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ensureContact } from './lib/ensureContact'
import { resolveRfqStageId } from './lib/pipeline'

const logger = createLogger('rfq_intake').child({ component: 'inbox-action' })

/**
 * HACK(hackathon): this action opens a CRM case, not a quote, but it is registered
 * under the `create_quote` TYPE.
 *
 * `extractedActionSchema` (`inbox_ops/data/validators.ts:183`) is a closed `z.enum`
 * used as the LLM's structured-output schema, so a `create_rfq` type would register
 * and execute but could never be PROPOSED from an e-mail. `create_quote` is the
 * closest thing the model can emit for "a customer is asking us to price something".
 *
 * What breaks: the stored `action_type` stops describing the behavior, so anyone
 * reading `inbox_proposal_actions` raw is misled. The label, the description and the
 * spec carry the meaning instead. Opening the enum upstream is the real fix.
 *
 * HACK(hackathon): the ACL gate cannot be moved either — the execution engine reads
 * the required feature from the installed `REQUIRED_FEATURES_MAP` by action type
 * (`executionEngine.ts:568`), not from this definition. `sales.quotes.manage` stays
 * enforced; `customers.deals.manage` is what the command below needs. An operator
 * must hold both.
 */
const RFQ_DEAL_SOURCE = 'inbox_ops:rfq'

/**
 * The RFQ payload: `orderPayloadSchema` with the quote-document fields relaxed and
 * two contact fields added.
 *
 * An RFQ e-mail is often a PDF and one sentence — no prices, no currency, sometimes
 * no nameable line items at all. The installed schema requires `currencyCode` and at
 * least one line item because it was written for a quote DOCUMENT; demanding them
 * here would make the model invent both. The engine validates against THIS schema
 * (`executionEngine.ts:397` uses `definition.payloadSchema`), so relaxing it is a
 * local decision.
 *
 * HACK(hackathon): the action-EDIT route still validates against the installed
 * `orderPayloadSchema` (`api/proposals/[id]/actions/[actionId]/route.ts:60`), so
 * hand-editing an RFQ action in the UI fails until line items and a currency are
 * filled in. Extraction and execution are unaffected.
 */
const rfqPayloadSchema = orderPayloadSchema
  .partial({ currencyCode: true, lineItems: true } as never)
  .extend({
    customerPhone: z.string().trim().max(100).optional(),
    companyName: z.string().trim().max(300).optional(),
  })

type RfqPayload = z.infer<typeof rfqPayloadSchema>

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function buildDealTitle(payload: RfqPayload): string {
  const customer = firstNonEmpty(payload.customerName, payload.customerEmail)
  const base = customer ? `RFQ — ${customer}` : 'RFQ'
  return base.slice(0, 200)
}

/**
 * Describes the request in the case body without inventing domain data: the lines the
 * extraction found, plus any notes. Pricing and scope are the agent chain's job.
 */
function buildDealDescription(payload: RfqPayload): string | undefined {
  const parts: string[] = []
  if (payload.notes) parts.push(payload.notes)
  const lines = (payload.lineItems ?? [])
    .map((line) => firstNonEmpty(line.productName, line.description))
    .filter((value): value is string => Boolean(value))
  if (lines.length > 0) parts.push(lines.map((line) => `- ${line}`).join('\n'))
  const text = parts.join('\n\n').trim()
  return text.length > 0 ? text.slice(0, 4000) : undefined
}

async function executeCreateRfqAction(
  action: { id: string; proposalId: string; payload: unknown },
  ctx: InboxActionExecutionContext,
): Promise<{ createdEntityId?: string | null; createdEntityType?: string | null }> {
  const hCtx = asHelperContext(ctx)
  const payload = action.payload as RfqPayload

  const contact = await ensureContact(ctx, {
    email: payload.customerEmail,
    name: payload.customerName,
    phone: payload.customerPhone,
    companyName: payload.companyName,
  })

  // The case opens in the funnel's first stage. A missing funnel is not fatal: the RFQ
  // still gets a case, it just sits outside the kanban until someone runs
  // `mercato rfq_intake seed-pipeline`.
  const stageId = await resolveRfqStageId(
    ctx.em as EntityManager,
    { tenantId: ctx.tenantId, organizationId: ctx.organizationId },
    'new',
  )

  const result = await executeCommand<Record<string, unknown>, { entityId?: string; id?: string }>(
    hCtx,
    'customers.deals.create',
    {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      title: buildDealTitle(payload),
      description: buildDealDescription(payload),
      source: RFQ_DEAL_SOURCE,
      ...(stageId ? { pipelineStageId: stageId } : {}),
      ...(contact?.customerEntityId
        ? { primaryPersonEntityId: contact.customerEntityId, personIds: [contact.customerEntityId] }
        : {}),
      ...(contact?.companyEntityId ? { companyIds: [contact.companyEntityId] } : {}),
    },
  )

  const dealId = result?.entityId ?? result?.id
  if (!dealId) {
    throw new ExecutionError('Deal creation returned no id; the RFQ was not opened.', 500)
  }

  logger.info('RFQ case opened from inbox action', {
    dealId,
    proposalId: action.proposalId,
    contactCreated: contact?.created ?? false,
  })

  return { createdEntityId: dealId, createdEntityType: 'customer_deal' }
}

export const inboxActions: InboxActionDefinition[] = [
  {
    type: 'create_quote',
    requiredFeature: 'customers.deals.manage',
    payloadSchema: rfqPayloadSchema,
    label: 'Save RFQ and start the AI analysis',
    promptSchema: '(shared with create_order)',
    promptRules: [
      'A property or renovation enquiry that arrives with a PDF brief, floor plan, or drawing is a create_quote action, even when no prices are mentioned: accepting it opens the case and starts the document analysis.',
      'For create_quote: always carry customerEmail when the thread reveals it, plus customerPhone and companyName when the signature or body gives them. They are used to guarantee the CRM contact before the case is opened.',
      'For create_quote: customerName must be the sender\'s full personal name as written in the signature or the From header (both given and family name, e.g. "Marek Grochala"), not a greeting, not a role, and not the company. Fall back to the company name only when the thread names no person at all.',
      'For a create_quote that is a property or renovation enquiry: do not invent currencyCode, prices, or line items that the thread does not state. An enquiry whose detail lives in an attached PDF may carry no line items at all.',
    ],
    execute: executeCreateRfqAction,
  },
]

export default inboxActions

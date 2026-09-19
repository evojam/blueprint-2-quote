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
 * `customerName` is relaxed for the same reason: a thread whose sender signs off with
 * nothing but an address ("marek@evojam.com") has no personal name to extract, and the
 * prompt rule below forbids inventing one. Requiring it failed the whole action with
 * "customerName: expected string, received undefined" instead of opening the case.
 * Both consumers already cope: `buildDealTitle` falls back to the e-mail, and
 * `ensureContact` derives a person name from the address when the hint is missing.
 *
 * HACK(hackathon): one action type, two validation sources — and overriding the action
 * replaces only one of them. Execution uses THIS schema (`executionEngine.ts:397`); the
 * action-EDIT route uses the installed `orderPayloadSchema` through
 * `validateActionPayloadForType`, whose `ACTION_PAYLOAD_SCHEMAS` map
 * (`data/validators.ts:285`) is module-private and cannot be extended from here.
 * Reproduced against `@open-mercato/core@0.8.0`: editing an RFQ action fails with
 * "currencyCode: expected string, received undefined; lineItems: expected array,
 * received undefined".
 *
 * What breaks: hand-editing an RFQ action in the UI. Extraction and execution are
 * unaffected, and after the normalizer below there is no longer a reason to edit — so
 * this is a dead end an operator can still walk into, not a blocked demo path.
 *
 * Not worked around on purpose. An API interceptor cannot reach it (the route is
 * hand-written, with no interceptor bridge), a mutation guard runs after the check and
 * can only permit or refuse, and stamping placeholder line items to satisfy a schema
 * this action does not need would write fiction into the record. The remaining local
 * option — overriding the route via `src/modules.ts` `entry.overrides` — means forking
 * ~120 lines of installed logic (optimistic lock, guards, events, cache invalidation)
 * and owning the drift.
 *
 * The real fix is upstream and benefits every consumer: the edit route should consult
 * the registered definition's schema, as `executeByType` already does, and fall back to
 * the map. Reported as open-mercato/open-mercato#6279; drop this note and the
 * `customerName` relaxation's edit-path caveat once it ships. See
 * `.ai/lessons/inbox-action-override-owns-only-execution-schema.md`.
 */
const rfqPayloadSchema = orderPayloadSchema
  .partial({ currencyCode: true, lineItems: true, customerName: true } as never)
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return firstNonEmpty(value)
  if (typeof value === 'number') return String(value)
  return null
}

/**
 * Maps what the model actually emits onto the schema.
 *
 * Observed on the demo environment (proposals 9cc9514b / fa3ec747, sonnet via litellm):
 * the model answered with a shape of its own invention —
 * `{ customer: { name, email }, scope: [...], area_m2, floors, location,
 * ceiling_height_cm }` — so `customerName` arrived undefined and the whole action
 * failed validation, while every fact the enquiry carried was silently dropped.
 *
 * Two reasons it drifted, both now addressed: the definition inherited no
 * `normalizePayload` when it took the type over from `sales` (the installed one has
 * `normalizeOrderPayload`), and its `promptSchema` was the `(shared with create_order)`
 * placeholder, which `extractionPrompt.ts:27` filters OUT of the prompt — so the model
 * was shown the quote-DOCUMENT schema and left to guess how an RFQ fits it.
 *
 * This is the belt to the prompt's braces: a better prompt reduces the drift, it does
 * not remove it. Nothing here invents data — it only moves what the model did extract
 * to where the schema expects it, and folds the rest into `notes` so the case body
 * carries the scope and the scale instead of losing them.
 */
async function normalizeRfqPayload(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Match on the key's letters and digits alone. Enumerating spellings does not hold:
  // the first observed run emitted `ceiling_height_cm`, a later one `ceilingHeight_cm`,
  // and a list that covers snake and camel still misses the mixed form. Collapsing the
  // separators makes all three the same key and removes the guessing.
  const byShape = new Map<string, unknown>()
  for (const [key, value] of Object.entries(payload)) {
    byShape.set(key.toLowerCase().replace(/[^a-z0-9]/g, ''), value)
  }
  const pick = (...names: string[]): unknown => {
    for (const name of names) {
      const value = byShape.get(name.toLowerCase().replace(/[^a-z0-9]/g, ''))
      if (value != null) return value
    }
    return undefined
  }

  const customer = asRecord(payload.customer) ?? {}

  // `customerName` is listed first so a snake/mixed spelling of the canonical key
  // (`customer_name`) is found before the looser aliases. `??=` is lazy, so a value that
  // already arrived on the canonical key is never reconsidered.
  payload.customerName ??= asText(customer.name)
    ?? asText(pick('customerName', 'customerFullName', 'contactName', 'name'))
    ?? undefined
  payload.customerEmail ??= asText(customer.email)
    ?? asText(pick('customerEmail', 'email'))
    ?? undefined
  payload.customerPhone ??= asText(customer.phone)
    ?? asText(pick('customerPhone', 'phone'))
    ?? undefined
  payload.companyName ??= asText(customer.company)
    ?? asText(pick('companyName', 'company'))
    ?? undefined

  // The enquiry's substance, in the model's own words. `buildDealDescription` reads
  // `notes`, so without this the costing clerk opens a case with an empty body.
  //
  // HACK(hackathon): the labels are hardcoded Polish. `notes` is DATA written once into
  // the deal body, not a rendered string, so there is no request locale to translate
  // against — a key would still have to be resolved to one language at write time.
  // What breaks: a non-Polish operator reads Polish labels around correct values.
  const facts: string[] = []
  const rawScope = pick('scope')
  const scope = Array.isArray(rawScope)
    ? rawScope.map(asText).filter((entry): entry is string => Boolean(entry))
    : [asText(rawScope)].filter((entry): entry is string => Boolean(entry))
  if (scope.length > 0) facts.push(`Zakres: ${scope.join(', ')}`)
  const location = asText(pick('location'))
  if (location) facts.push(`Lokalizacja: ${location}`)
  const area = asText(pick('area_m2', 'areaM2', 'area'))
  if (area) facts.push(`Powierzchnia: ${area} m2`)
  const floors = asText(pick('floors'))
  if (floors) facts.push(`Kondygnacje: ${floors}`)
  const ceiling = asText(pick('ceiling_height_cm', 'ceilingHeight', 'ceilingHeightCm'))
  if (ceiling) facts.push(`Wysokość pomieszczeń: ${ceiling} cm`)

  if (facts.length > 0) {
    const existing = asText(payload.notes)
    payload.notes = [existing, facts.join('\n')].filter(Boolean).join('\n\n')
  }

  // Keys the schema does not know, matched by the same shape rule so a new spelling of
  // one we already fold into `notes` does not survive as a stray. `orderPayloadSchema`
  // is not strict, so leaving them would be harmless — dropping them keeps the stored
  // payload readable instead.
  const dropped = new Set(
    ['customer', 'scope', 'location', 'area_m2', 'areaM2', 'area', 'floors',
      'ceiling_height_cm', 'ceilingHeight', 'ceilingHeightCm', 'email', 'phone', 'company']
      .map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, '')),
  )
  for (const key of Object.keys(payload)) {
    if (dropped.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) delete payload[key]
  }

  return payload
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

  const result = await executeCommand<
    Record<string, unknown>,
    { dealId?: string; entityId?: string; id?: string }
  >(
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

  // `customers.deals.create` returns `{ dealId }` (commands/deals.ts:640); the other two
  // keys are only a guard in case the command's result shape changes.
  const dealId = result?.dealId ?? result?.entityId ?? result?.id
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
    // NOT the inherited `(shared with create_order)` placeholder: `extractionPrompt.ts:27`
    // filters that exact string out, so create_quote reached the model with no field list
    // of its own and it answered with an invented shape (`customer: {name}`, `area_m2`,
    // `scope`). Spelling the payload out here is what stops the drift at the source;
    // `normalizeRfqPayload` catches what still slips through.
    promptSchema: `create_quote payload (a property or renovation RFQ — a CASE, not a priced document):
{ customerName: string (the sender's full personal name), customerEmail?: string, customerPhone?: string, companyName?: string, customerEntityId?: uuid, currencyCode?: string (3-letter ISO), lineItems?: [{ productName: string (REQUIRED), quantity: string, unitPrice?: string, kind?: "product"|"service", description?: string }], notes?: string }
Use THESE key names exactly. Do not nest the contact under a "customer" object, and do not invent keys such as "scope", "area_m2", "floors" or "location" — the enquiry's scope, area, storey count, ceiling heights and location all belong in "notes" as plain text.`,
    promptRules: [
      'A property or renovation enquiry that arrives with a PDF brief, floor plan, or drawing is a create_quote action, even when no prices are mentioned: accepting it opens the case and starts the document analysis.',
      'For create_quote: always carry customerEmail when the thread reveals it, plus customerPhone and companyName when the signature or body gives them. They are used to guarantee the CRM contact before the case is opened.',
      'For create_quote: customerName must be the sender\'s full personal name as written in the signature or the From header (both given and family name, e.g. "Marek Grochala"), not a greeting, not a role, and not the company. Fall back to the company name only when the thread names no person at all, and omit the field entirely when the thread reveals no name — never invent one from the e-mail address.',
      'For a create_quote that is a property or renovation enquiry: do not invent prices or line items that the thread does not state. An enquiry whose detail lives in an attached PDF may carry no line items at all.',
      // HACK(hackathon): currencyCode is unused by this action — the RFQ case carries no
      // money. It is emitted only to silence the installed `no_currency_resolved`
      // discrepancy, which fires on EVERY create_quote because `SalesChannel` has no
      // `currencyCode` column for `enrichOrderPayload` (payloadEnrichment.ts:77) to read.
      // What breaks: a non-PLN enquiry gets PLN stamped on a field nobody reads. The real
      // fix is upstream — either give the channel a default currency or stop raising the
      // warning for quotes without line items.
      'For create_quote: set currencyCode to "PLN" unless the thread names a different currency.',
    ],
    normalizePayload: normalizeRfqPayload,
    execute: executeCreateRfqAction,
  },
]

export default inboxActions

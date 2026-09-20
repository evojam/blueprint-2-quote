import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { ApiRouteOverridesMap } from '@open-mercato/shared/modules/overrides'

/**
 * Everything that reaches the database or the container is imported lazily, inside the
 * call. Two reasons, and both bite:
 *
 * - `src/bootstrap-common.ts` imports this module at boot only to read the override map;
 *   pulling the sales route, the DI container and MikroORM into that frame costs startup
 *   for a handler that may never run.
 * - a module-level `createRequestContainer` import drags `@mikro-orm/postgresql` and its
 *   ESM-only `kysely` dependency into Jest's CommonJS runtime, and the whole test file
 *   fails to load before a single case runs.
 */

const logger = createLogger('rfq_intake').child({ component: 'quote-send-override' })

/**
 * Moves an RFQ case to `Oferta wysłana` when its quote is sent to the customer.
 *
 * `sales/api/quotes/send/route.ts:190-196` sets `quote.status = 'sent'` directly inside
 * `em.transactional`. It is not a command, it emits no event, and it is not a
 * `makeCrudRoute` route — so none of the four UMES seams reaches it:
 *
 * - no `sales.quote.sent` in `sales/events.ts`, and the route emits no
 *   `sales.quote.updated` either, so there is nothing to subscribe to;
 * - no command, so no command interceptor;
 * - API interceptors run inside `makeCrudRoute`, and the `[...slug]` dispatcher does not
 *   apply them to a hand-written route;
 * - the route builds `runMutationGuards([legacyGuard], …)` — only the
 *   `crudMutationGuardService` bridge. It never calls `getAllMutationGuardInstances()`,
 *   unlike `staff/api/guards.ts:105` or the eudr routes, so a `data/guards.ts` guard in
 *   this app never fires here.
 *
 * Replacing the route therefore is the seam. Spec:
 * `.ai/specs/2026-09-20-quote-sent-advances-funnel.md`.
 *
 * HACK(hackathon): this wrapper exists only until `sales` grows a seam of its own — one
 * line adding `getAllMutationGuardInstances()` to that route (it already builds the guard
 * input with `resourceKind: 'sales.quote'`, `operation: 'update'` and already runs
 * `afterSuccess` post-commit), or a `sales.quote.sent` event. What breaks if it is
 * forgotten: an upstream change to the send route's signature or metadata is masked here
 * rather than surfacing. `__tests__/quote-send-override.test.ts` pins the route key
 * against the generated API surface so a rename cannot disarm it silently.
 *
 * Registered through `applyApiRouteOverrides` in `src/bootstrap-common.ts`, NOT through
 * `entry.overrides.routes.api` in `src/modules.ts`: `ClientBootstrap.tsx:66` imports
 * `@/modules` in the browser, so naming a server handler there pulls the installed sales
 * route and `server-only` into the client graph and breaks `yarn build`. Same reason
 * already recorded on `src/lib/publicQuoteAcceptOrigin.ts`.
 */
export async function sendQuoteAndAdvanceCase(req: Request): Promise<Response> {
  // Read once, then hand each consumer its own request: a `Request` body is a stream and
  // can only be read a single time, and the installed route parses it with `req.json()`.
  const bodyText = await req.text()

  const route = await import('@open-mercato/core/modules/sales/api/quotes/send/route')
  const response = await route.POST(rebuild(req, bodyText))

  // Not sent: nothing happened that the funnel should reflect. Includes every guard the
  // installed route applies — auth, scope, cancelled quotes, a missing customer e-mail.
  if (!response.ok) return response

  try {
    await advanceSentCase(req, bodyText)
  } catch (err) {
    // The customer has the e-mail and the quote is persisted as `sent`. Turning that into
    // an error response would tell the operator the send failed when it did not, and the
    // UI would invite them to send it again.
    logger.error('Quote was sent but its case could not be advanced', { err })
  }

  return response
}

/**
 * Resolves scope the way the installed route does, then applies the funnel move.
 *
 * Scope is re-derived from the authenticated request rather than read off the body: the
 * body is caller-supplied, and `withScopedPayload` in the installed route exists for the
 * same reason. Missing scope fails closed — it must never widen a lookup.
 */
async function advanceSentCase(req: Request, bodyText: string): Promise<void> {
  const quoteId = readQuoteId(bodyText)
  if (!quoteId) {
    // The installed route answered 2xx, so its own `quoteSendSchema` accepted this body.
    // Reaching here means the payload shape moved upstream — loud, because the funnel
    // would otherwise just stop moving with no other signal.
    logger.warn('Sent quote payload carries no readable quoteId; leaving the funnel alone')
    return
  }

  const [{ createRequestContainer }, { getAuthFromRequest }, { advanceCaseForSentQuote }] =
    await Promise.all([
      import('@open-mercato/shared/lib/di/container'),
      import('@open-mercato/shared/lib/auth/server'),
      import('./quoteSentFunnel'),
    ])

  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(rebuild(req, bodyText))
  const tenantId = auth?.tenantId ?? null
  // `auth` is re-tested rather than inferred from `tenantId`: it carries `orgId` below,
  // and narrowing one field does not narrow the object it came from.
  if (!auth || !tenantId) {
    logger.warn('Sent quote carries no tenant scope; leaving the funnel alone', { quoteId })
    return
  }

  const { resolveOrganizationScopeForRequest } = await import(
    '@open-mercato/core/modules/directory/utils/organizationScope'
  )
  const organizationScope = await resolveOrganizationScopeForRequest({
    container,
    auth,
    request: rebuild(req, bodyText),
  })
  const organizationId = organizationScope?.selectedId ?? auth.orgId ?? null
  if (!organizationId) {
    logger.warn('Sent quote carries no organization scope; leaving the funnel alone', { quoteId })
    return
  }

  const ctx: CommandRuntimeContext = {
    container,
    auth,
    organizationScope,
    selectedOrganizationId: organizationId,
    organizationIds: organizationScope?.filterIds ?? [organizationId],
    request: req,
  }

  await advanceCaseForSentQuote(ctx, { quoteId, scope: { tenantId, organizationId } })
}

/**
 * The `quoteId` the request asked to send, or `null` when the body is not the shape the
 * installed `quoteSendSchema` accepts.
 */
export function readQuoteId(bodyText: string): string | null {
  try {
    const payload = JSON.parse(bodyText) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const quoteId = (payload as { quoteId?: unknown }).quoteId
    return typeof quoteId === 'string' && quoteId.trim().length > 0 ? quoteId.trim() : null
  } catch {
    return null
  }
}

/**
 * A fresh `Request` carrying the same method, URL, headers and body.
 *
 * Every consumer downstream needs its own: the installed route reads the body, and
 * `getAuthFromRequest` and the organization-scope resolver each read headers off a request
 * whose body this wrapper has already drained.
 */
function rebuild(req: Request, bodyText: string): Request {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    ...(hasBody ? { body: bodyText } : {}),
  })
}

/**
 * The override map itself, so the route key has exactly one owner.
 *
 * No `metadata` alongside the handler, deliberately: `applyApiOverridesToManifests` merges
 * `def.metadata` into the route's own metadata only when it is present, so omitting it
 * preserves the installed `metadata.POST = { requireAuth: true, requireFeatures:
 * ['sales.quotes.manage'] }`. The dispatcher still enforces both before this handler runs.
 */
export const RFQ_QUOTE_SEND_ROUTE_OVERRIDE: ApiRouteOverridesMap = {
  'POST /api/sales/quotes/send': { handler: sendQuoteAndAdvanceCase },
}

import type { ApiRouteOverridesMap } from '@open-mercato/shared/modules/overrides'
import { getAppBaseUrl } from '@open-mercato/shared/lib/url'

/**
 * Restores the public-quote acceptance endpoint behind a TLS-terminating proxy.
 *
 * `sales/api/quotes/accept/originGuard.ts` derives its same-origin expectation from
 * `new URL(req.url).origin`. Next.js standalone builds `req.url` from the server's own
 * LISTENING identity, not from the request: it takes the scheme from `X-Forwarded-Proto`
 * but the host from `HOSTNAME`/`PORT`, and it normalises `HOSTNAME=0.0.0.0` to
 * `localhost`. `X-Forwarded-Host` is ignored.
 *
 * On this deployment (ALB :443 HTTPS -> target group HTTP:3000, `HOSTNAME=0.0.0.0`,
 * `PORT=3000`) that makes the expected origin `https://localhost:3000`, while every
 * browser sends `Origin: https://demo.hackon.dev.evojam.com`. The guard reports
 * `cross-origin` and answers 403, so NO customer can accept ANY quote. `GET` is
 * unaffected because `isSafeMethod()` skips the guard — which is why the quote page
 * renders and only the button fails.
 *
 * Measured, 2026-09-19: `GET /api/auth/locale?...` returns
 * `location: https://localhost:3000/start` (that route builds its `Location` from the
 * same `new URL(req.url).origin`), and `POST /api/sales/quotes/accept` answers 404
 * "Quote not found" — meaning the guard passed — only when `Origin` is exactly
 * `https://localhost:3000`. Full evidence: `.ai/notes/quote-accept-failure-leads.md`.
 *
 * Registered through `applyApiRouteOverrides` in `src/bootstrap-common.ts`, NOT through
 * `entry.overrides.routes.api` in `src/modules.ts`: `ClientBootstrap.tsx:66` imports
 * `@/modules` in the browser, so naming this handler there pulls the installed sales
 * route and `server-only` into the client graph and breaks `yarn build`.
 *
 * HACK(hackathon): this wrapper exists only until the upstream fix ships
 * (open-mercato/open-mercato#6283, which makes `readExpectedOrigin` resolve through
 * `getAppBaseUrl`). What breaks if it is forgotten: nothing functionally, but it keeps
 * re-wrapping a route whose own guard is already correct, and a future upstream change
 * to that route's signature or metadata would be masked here. Remove it, and the
 * `applyApiRouteOverrides` call in `src/bootstrap-common.ts`, on the next core bump that
 * carries the fix.
 *
 * This does NOT weaken the guard. It restores it: the check now compares the browser
 * origin against the application's configured public origin instead of against a listen
 * address no browser can ever send. `getAppBaseUrl` reads `NEXT_PUBLIC_APP_URL` then
 * `APP_URL` — the same single source of truth that `sales/api/quotes/send` already uses
 * to build the link inside the customer's email — and only then falls back to
 * reconstructing the origin from `X-Forwarded-*`.
 */

/**
 * Returns `req` with its URL re-based onto the application's public origin.
 *
 * Only the origin changes. Method, headers and body are carried over verbatim, so
 * everything the wrapped route reads off the request keeps working: the session cookie
 * for `getAuthFromRequest`, `x-forwarded-for` for `getClientIp`, and the JSON body for
 * `quoteAcceptSchema`.
 *
 * The body is read as text rather than streamed. A Node `Request` built from a stream
 * needs `duplex: 'half'`, and this payload is a single `{ token }` object, so buffering
 * it costs nothing and avoids that footgun.
 */
export async function withPublicOrigin(req: Request): Promise<Request> {
  const incoming = new URL(req.url)

  let publicOrigin: string
  try {
    publicOrigin = new URL(getAppBaseUrl(req)).origin
  } catch {
    // A malformed APP_URL must not take the endpoint down on top of the origin bug.
    // Falling through unchanged reproduces today's behaviour rather than a new failure.
    return req
  }

  if (publicOrigin === incoming.origin) return req

  const corrected = new URL(`${incoming.pathname}${incoming.search}`, publicOrigin)
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text()

  return new Request(corrected, {
    method: req.method,
    headers: req.headers,
    ...(body === undefined ? {} : { body }),
  })
}

/**
 * Replacement handler for `POST /api/sales/quotes/accept`.
 *
 * The installed route is imported lazily, inside the call, so importing this module does
 * not pull the whole sales accept route, its command bus and its entities into the
 * importer's frame.
 *
 * No metadata is supplied alongside this handler at the registration site, which is
 * deliberate: `applyApiOverridesToManifests` merges `def.metadata` into the route's own
 * metadata only when it is present, so omitting it preserves the installed
 * `metadata.POST = { requireAuth: false }` that makes the endpoint public.
 */
export async function acceptPublicQuote(req: Request): Promise<Response> {
  const route = await import('@open-mercato/core/modules/sales/api/quotes/accept/route')
  return route.POST(await withPublicOrigin(req))
}

/**
 * The override map itself, so the route key has exactly one owner.
 *
 * `src/bootstrap-common.ts` applies it and
 * `__tests__/publicQuoteAcceptOrigin.test.ts` asserts that every key in it names a route
 * the app really registers. Without that assertion an upstream rename would leave the
 * override matching nothing, and the only signal would be one line in the boot log that
 * nobody greps for — a silent return to 403 for every customer.
 */
export const PUBLIC_QUOTE_ACCEPT_ROUTE_OVERRIDE: ApiRouteOverridesMap = {
  'POST /api/sales/quotes/accept': { handler: acceptPublicQuote },
}

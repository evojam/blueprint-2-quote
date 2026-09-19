import { afterEach, describe, expect, it } from '@jest/globals'

import fs from 'node:fs'
import path from 'node:path'

import { validateSameOriginMutationRequest } from '@open-mercato/core/modules/sales/api/quotes/accept/originGuard'

import { PUBLIC_QUOTE_ACCEPT_ROUTE_OVERRIDE, withPublicOrigin } from '../publicQuoteAcceptOrigin'

/**
 * Guards the override that keeps `POST /api/sales/quotes/accept` reachable behind the
 * ALB. The installed origin guard compares the browser `Origin` against
 * `new URL(req.url).origin`, which Next.js standalone builds from its own listen
 * identity — `https://localhost:3000` on this deployment. See
 * `.ai/notes/quote-accept-failure-leads.md`.
 *
 * The discriminating case is the first one: with the original `req.url` the guard sees
 * `https://localhost:3000` and answers 403, and only re-basing the URL onto the
 * configured public origin makes the browser's own `Origin` match.
 */

const PUBLIC_ORIGIN = 'https://demo.hackon.dev.evojam.com'
const LISTEN_URL = 'https://localhost:3000/api/sales/quotes/accept'

describe('withPublicOrigin', () => {
  const previous = {
    nextPublic: process.env.NEXT_PUBLIC_APP_URL,
    appUrl: process.env.APP_URL,
  }

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = previous.nextPublic
    process.env.APP_URL = previous.appUrl
  })

  it('re-bases the listen-identity URL onto the configured public origin', async () => {
    process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN
    const req = new Request(LISTEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ token: 'a3f43c0b-46e2-4259-bcbd-18f0392dd02c' }),
    })

    const corrected = await withPublicOrigin(req)

    expect(new URL(corrected.url).origin).toBe(PUBLIC_ORIGIN)
    expect(new URL(corrected.url).pathname).toBe('/api/sales/quotes/accept')
  })

  it('carries method, headers and body through unchanged', async () => {
    process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN
    const body = JSON.stringify({ token: 'a3f43c0b-46e2-4259-bcbd-18f0392dd02c' })
    const req = new Request(LISTEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
        cookie: 'om_session=abc',
        'x-forwarded-for': '203.0.113.7',
      },
      body,
    })

    const corrected = await withPublicOrigin(req)

    // Asserted first, and on purpose. Without it this case passes on the UNCHANGED
    // request — the headers are trivially identical there — so it would stay green
    // against the very bug the override exists to fix. Verified by sabotage: with the
    // re-basing removed, this line is what turns the case red.
    expect(new URL(corrected.url).origin).toBe(PUBLIC_ORIGIN)
    expect(corrected.method).toBe('POST')
    // The session cookie and the client IP are what `getAuthFromRequest` and
    // `getClientIp` read; losing either would silently change auth scope or collapse
    // every caller into one rate-limit bucket.
    expect(corrected.headers.get('cookie')).toBe('om_session=abc')
    expect(corrected.headers.get('x-forwarded-for')).toBe('203.0.113.7')
    expect(await corrected.json()).toEqual({ token: 'a3f43c0b-46e2-4259-bcbd-18f0392dd02c' })
  })

  it('preserves the query string', async () => {
    process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN
    const req = new Request(`${LISTEN_URL}?trace=1`, { method: 'POST', body: '{}' })

    const corrected = await withPublicOrigin(req)

    expect(corrected.url).toBe(`${PUBLIC_ORIGIN}/api/sales/quotes/accept?trace=1`)
  })

  it('returns the request untouched when the origin already matches', async () => {
    process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN
    const req = new Request(`${PUBLIC_ORIGIN}/api/sales/quotes/accept`, { method: 'POST', body: '{}' })

    // Identity, not equality: an unnecessary copy would consume the body for no reason.
    await expect(withPublicOrigin(req)).resolves.toBe(req)
  })

  it('returns the request untouched when the app origin is unusable', async () => {
    // A malformed APP_URL must not take the endpoint down on top of the origin bug —
    // it reproduces today's behaviour instead of adding a new failure mode.
    delete process.env.NEXT_PUBLIC_APP_URL
    process.env.APP_URL = 'not-a-url'
    const req = new Request(LISTEN_URL, { method: 'POST', body: '{}' })

    await expect(withPublicOrigin(req)).resolves.toBe(req)
  })
})

/**
 * The security property, asserted against the REAL installed guard rather than a
 * restatement of it.
 *
 * The cases above only prove the URL was re-based. They say nothing about whether the
 * guard then accepts or rejects, and asserting only the accept direction is exactly what
 * let a bypass ship: an earlier version resolved the origin through `getAppBaseUrl`,
 * whose last fallback reads the attacker-controlled `x-forwarded-host`. With no
 * `APP_URL` configured, a request naming `evil.example` in both `Origin` and
 * `X-Forwarded-Host` was rebased onto `https://evil.example` and the guard returned
 * `null` — while the unwrapped request was correctly rejected as `cross-origin`.
 */
describe('withPublicOrigin, against the installed origin guard', () => {
  const previous = {
    nextPublic: process.env.NEXT_PUBLIC_APP_URL,
    appUrl: process.env.APP_URL,
  }

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = previous.nextPublic
    process.env.APP_URL = previous.appUrl
  })

  it('accepts the real browser origin', async () => {
    process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN
    const req = new Request(LISTEN_URL, {
      method: 'POST',
      headers: { origin: PUBLIC_ORIGIN },
      body: '{}',
    })

    expect(validateSameOriginMutationRequest(await withPublicOrigin(req))).toBeNull()
  })

  it('still rejects a foreign origin', async () => {
    process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN
    const req = new Request(LISTEN_URL, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: '{}',
    })

    expect(validateSameOriginMutationRequest(await withPublicOrigin(req))).not.toBeNull()
  })

  it('rejects a spoofed X-Forwarded-Host when no app origin is configured', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.APP_URL
    const req = new Request(LISTEN_URL, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
      body: '{}',
    })

    // The wrapper must hand the guard a request it still refuses. Reproduced as a real
    // bypass before this assertion existed.
    expect(validateSameOriginMutationRequest(await withPublicOrigin(req))).not.toBeNull()
  })
})

describe('PUBLIC_QUOTE_ACCEPT_ROUTE_OVERRIDE', () => {
  /**
   * The gate for the override KEY, as opposed to the handler behaviour above.
   *
   * `applyApiOverridesToManifests` does not fail on a key that matches no route — it logs
   * one warning and moves on. So an upstream rename of the accept route would silently
   * disarm this override and return every customer to 403, with the only evidence a boot
   * log line nobody reads. This reads the generated API surface instead, which
   * `yarn generate` rewrites from the installed modules on every build.
   */
  const openApi = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), '.mercato/generated/openapi.generated.json'), 'utf8'),
  ) as { paths: Record<string, Record<string, unknown>> }

  it.each(Object.keys(PUBLIC_QUOTE_ACCEPT_ROUTE_OVERRIDE))(
    'key %s names a route the app actually registers',
    (key) => {
      const [method, routePath] = key.split(' ')
      expect(openApi.paths[routePath!]).toBeDefined()
      expect(openApi.paths[routePath!]![method!.toLowerCase()]).toBeDefined()
    },
  )
})

describe('bootstrap wiring', () => {
  /**
   * Deleting the `applyApiRouteOverrides` call leaves every other case in this file
   * green, because they all exercise the helper directly. Then the override is never
   * applied and every customer is back to 403. Same guard shape as
   * `src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts:241`.
   */
  it('applies the override from bootstrap-common', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/bootstrap-common.ts'), 'utf8')

    expect(source).toContain('applyApiRouteOverrides(PUBLIC_QUOTE_ACCEPT_ROUTE_OVERRIDE)')
  })
})

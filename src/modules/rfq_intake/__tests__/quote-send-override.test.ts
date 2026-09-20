import { describe, expect, it } from '@jest/globals'

import fs from 'node:fs'
import path from 'node:path'

import { RFQ_QUOTE_SEND_ROUTE_OVERRIDE, readQuoteId } from '../lib/quoteSendOverride'

describe('readQuoteId', () => {
  it('reads the quote the request asked to send', () => {
    expect(readQuoteId(JSON.stringify({ quoteId: ' abc ', validForDays: 14 }))).toBe('abc')
  })

  it.each([
    ['a body with no quoteId', JSON.stringify({ validForDays: 14 })],
    ['a blank quoteId', JSON.stringify({ quoteId: '   ' })],
    ['a non-string quoteId', JSON.stringify({ quoteId: 42 })],
    ['an array body', JSON.stringify([{ quoteId: 'abc' }])],
    ['malformed JSON', '{'],
    ['an empty body', ''],
  ])('returns null for %s rather than throwing', (_label, body) => {
    // The wrapper runs AFTER the customer already has the e-mail, so every unreadable
    // shape has to degrade to "leave the funnel alone", never to an exception that the
    // caller would see as a failed send.
    expect(readQuoteId(body)).toBeNull()
  })
})

describe('RFQ_QUOTE_SEND_ROUTE_OVERRIDE', () => {
  /**
   * The gate for the override KEY, as opposed to the handler behaviour.
   *
   * `applyApiOverridesToManifests` does not fail on a key that matches no route — it logs
   * one warning and moves on. An upstream rename of the send route would therefore
   * silently disarm this override and the funnel would just stop moving, with the only
   * evidence a boot log line nobody reads. This reads the generated API surface instead,
   * which `yarn generate` rewrites from the installed modules on every build. Same guard
   * shape as `src/lib/__tests__/publicQuoteAcceptOrigin.test.ts`.
   */
  const openApi = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), '.mercato/generated/openapi.generated.json'), 'utf8'),
  ) as { paths: Record<string, Record<string, unknown>> }

  it.each(Object.keys(RFQ_QUOTE_SEND_ROUTE_OVERRIDE))(
    'key %s names a route the app actually registers',
    (key) => {
      const [method, routePath] = key.split(' ')
      expect(openApi.paths[routePath!]).toBeDefined()
      expect(openApi.paths[routePath!]![method!.toLowerCase()]).toBeDefined()
    },
  )

  it('supplies no metadata, so the installed auth and feature gates survive', () => {
    // `applyApiOverridesToManifests` merges `def.metadata` only when it is present.
    // Supplying any would REPLACE the installed `metadata.POST`, dropping
    // `requireFeatures: ['sales.quotes.manage']` and leaving the endpoint open to any
    // authenticated user.
    for (const definition of Object.values(RFQ_QUOTE_SEND_ROUTE_OVERRIDE)) {
      expect(definition).not.toBeNull()
      expect(definition).not.toHaveProperty('metadata')
      expect(typeof definition!.handler).toBe('function')
    }
  })
})

describe('bootstrap wiring', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/bootstrap-common.ts'), 'utf8')

  /**
   * Deleting the `applyApiRouteOverrides` call leaves every other case in this file green,
   * because they all exercise the map and the helper directly. Then the override is never
   * applied and no quote ever moves its case. Same guard shape as
   * `src/modules/rfq_intake/__tests__/rfq-intake-wiring.test.ts:241`.
   */
  it('applies the override from bootstrap-common', () => {
    expect(source).toContain('applyApiRouteOverrides(RFQ_QUOTE_SEND_ROUTE_OVERRIDE)')
  })

  /**
   * The handler calls `rfq_intake.deal.advance`, which the command bus resolves from the
   * GENERATED registry — not from `src/modules.ts`. Those two disagree whenever the
   * artifacts were built under different flags than the process runs with, which is the
   * committed state here: `modules.bootstrap.generated.ts` has no `rfq_intake` at all.
   * Gating on `enabledModules` would register the override against a runtime that cannot
   * serve it, and every send would log a caught "command not found" instead of moving a
   * case.
   */
  it('gates the override on the built registry, not on the env-driven module list', () => {
    expect(source).toContain("modules.some((entry) => entry.id === 'rfq_intake')")
    expect(source).not.toContain("enabledModules.some((entry) => entry.id === 'rfq_intake')")
  })
})

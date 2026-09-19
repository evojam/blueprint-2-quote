import { describe, expect, it } from '@jest/globals'
import { extensionPoints } from '@open-mercato/core/modules/sales/extension-points'
import { resolveExtensionPointPattern } from '@open-mercato/shared/modules/widgets/extension-points'
import { injectionTable } from '../widgets/injection-table'

const DEAL_TABS_SPOT = 'detail:customers.deal:tabs'
// A dotted, lowercase-prefixed token such as `deal_links.tab.label`.
const I18N_KEY_SHAPE = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/

const DOCUMENT_DEALS_WIDGET_ID = 'deal_links.injection.document-deals'

describe('deal detail tab placement', () => {
  it('declares one tab on the deal detail host', () => {
    const slots = injectionTable[DEAL_TABS_SPOT]
    expect(Array.isArray(slots)).toBe(true)
    expect(slots).toHaveLength(1)
  })

  /**
   * Regression oracle for the asymmetry documented in `widgets/injection-table.ts`:
   * the deal host renders `groupLabel` verbatim, while its person and sales
   * siblings pass it through `t()`. An i18n key here reaches the DOM raw.
   *
   * If a customers upgrade adds `t()` to `useDealInjectedTabs`, delete this test
   * together with the literal, in favour of the key `i18n/*.json` already carries.
   */
  it('uses display text for the tab label, not an i18n key', () => {
    const slots = injectionTable[DEAL_TABS_SPOT]
    const slot = (Array.isArray(slots) ? slots[0] : slots) as { groupLabel?: string }
    expect(slot.groupLabel).toBeTruthy()
    expect(slot.groupLabel).not.toMatch(I18N_KEY_SHAPE)
  })
})

describe('document detail tab placement', () => {
  // Built from the host's own pattern (`sales/extension-points.ts`), not a
  // literal string, so an upstream rename of the pattern breaks this test
  // rather than leaving the tab silently absent (M-6 of the final review):
  // a typo in either spot key here means the tab never appears and nothing
  // else in this suite would catch it — the framework performs no
  // spot-id validation.
  const documentDetailPattern = extensionPoints.hosts.documentDetail.pattern as string

  it.each([
    ['quote' as const, 'sales.document.detail.quote:tabs'],
    ['order' as const, 'sales.document.detail.order:tabs'],
  ])('declares one document-deals tab on the %s detail host', (kind, expectedKey) => {
    const spotKey = resolveExtensionPointPattern(documentDetailPattern, { kind, surface: 'tabs' })
    expect(spotKey).toBe(expectedKey)

    const slots = injectionTable[spotKey]
    expect(Array.isArray(slots)).toBe(true)
    expect(slots).toHaveLength(1)
    const slot = (Array.isArray(slots) ? slots[0] : slots) as { widgetId?: string }
    expect(slot.widgetId).toBe(DOCUMENT_DEALS_WIDGET_ID)
  })
})

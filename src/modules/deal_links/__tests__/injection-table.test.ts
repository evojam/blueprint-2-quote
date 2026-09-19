import { describe, expect, it } from '@jest/globals'
import { injectionTable } from '../widgets/injection-table'

const DEAL_TABS_SPOT = 'detail:customers.deal:tabs'
// A dotted, lowercase-prefixed token such as `deal_links.tab.label`.
const I18N_KEY_SHAPE = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/

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

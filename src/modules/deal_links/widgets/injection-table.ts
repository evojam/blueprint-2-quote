import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Declared as ONE plain object literal with no branching: the fact extractor can
 * only fold a statically known value, so a computed export would publish zero
 * contributions.
 */
export const injectionTable: ModuleInjectionTable = {
  // HACK(hackathon): `detail:customers.deal:tabs` is read by
  // `customers/backend/customers/deals/[id]/hooks/useDealInjectedTabs.tsx:28` but is
  // NOT declared in `customers/extension-points.ts` (which lists only dealHeader,
  // dealStatusBadges, dealFooter) nor in the module's umes-hosts facts. It has no
  // FROZEN status, so a customers upgrade may rename or drop it and this tab then
  // silently disappears — nothing else breaks.
  'detail:customers.deal:tabs': [
    {
      widgetId: 'deal_links.injection.deal-documents',
      kind: 'tab',
      groupId: 'deal-documents',
      // HACK(hackathon): display text, NOT an i18n key, because this host alone
      // renders `groupLabel` verbatim — `useDealInjectedTabs.tsx:38` resolves it as
      // `groupLabel ?? metadata.title ?? tabId` with no `t()`, and the tab bar
      // (`customers/components/detail/DealDetailTabs.tsx:108`) passes it straight to
      // the DOM. Its siblings DO translate: person detail calls
      // `t(groupLabel, groupLabel)` (`people-v2/[id]/page.tsx:312`) and sales calls
      // `t(groupLabel, metadata.title)` (`sales/backend/sales/documents/[id]/page.tsx:4016`).
      // What breaks: this label stays Polish in every locale. The translations are
      // already in `i18n/*.json` under `deal_links.tab.label`; once upstream adds
      // `t()` here, swap the literal back for that key and drop the test that guards
      // this line. The widget body is unaffected — it translates through `useT`.
      groupLabel: 'Oferty i zamówienia',
      priority: -10,
    },
  ],

  // `sales.document.detail.{kind}:tabs` IS declared — `sales/extension-points.ts:21-30`
  // publishes it with `kind: ^(order|quote)$` and `surface: ^(tabs|details)$`, and
  // `sales/backend/sales/documents/[id]/page.tsx:4002` resolves and reads it. Unlike
  // the customers spot above, this one is a published host, and it translates
  // `groupLabel` through `t()` (`page.tsx:4016`), so the label below is an i18n key
  // rather than a literal.
  'sales.document.detail.quote:tabs': [
    {
      widgetId: 'deal_links.injection.document-deals',
      kind: 'tab',
      groupId: 'document-deals',
      groupLabel: 'deal_links.documentTab.label',
      priority: -10,
    },
  ],
  'sales.document.detail.order:tabs': [
    {
      widgetId: 'deal_links.injection.document-deals',
      kind: 'tab',
      groupId: 'document-deals',
      groupLabel: 'deal_links.documentTab.label',
      priority: -10,
    },
  ],
}

export default injectionTable

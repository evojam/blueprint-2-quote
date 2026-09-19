import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import DocumentDealsWidget from './widget.client'

// No `features` gate: the host page already enforces the sales document's own view
// grant, and a widget-level gate would hide the LIST from users entitled to read it
// just because they cannot write. A missing write grant surfaces as a 403 on use.
const widget: InjectionWidgetModule<{ resourceId?: string }> = {
  metadata: {
    id: 'deal_links.injection.document-deals',
    title: 'Linked deals',
    description: 'Lists the deals linked to this quote or order, and links another.',
    enabled: true,
    requiredModules: ['customers', 'sales'],
  },
  Widget: DocumentDealsWidget,
}

export default widget

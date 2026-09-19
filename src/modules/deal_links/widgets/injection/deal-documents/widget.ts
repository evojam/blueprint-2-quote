import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import DealDocumentsWidget from './widget.client'

// No `features` gate here: the route already enforces `customers.deals.view`, and
// a widget-level gate would only make a missing grant look like a broken host.
const widget: InjectionWidgetModule<{ dealId?: string }> = {
  metadata: {
    id: 'deal_links.injection.deal-documents',
    title: 'Deal documents',
    description: 'Lists the quotes and orders linked to this deal.',
    enabled: true,
    requiredModules: ['customers'],
  },
  Widget: DealDocumentsWidget,
}

export default widget

import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'deal_links',
  title: 'Deal Links',
  version: '0.1.0',
  description: 'Links a CRM deal to the sales quote or order that answers it.',
  requires: ['customers'],
}

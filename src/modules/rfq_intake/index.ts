import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'rfq_intake',
  title: 'RFQ Intake',
  version: '0.1.0',
  description: 'Turns an accepted AI Action Inbox proposal into a CRM case and starts the property-document agent chain.',
  author: 'Evojam',
  license: 'MIT',
}

export default metadata

import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'catalog_seed',
  title: 'Catalog Seed',
  version: '0.1.0',
  description: 'Seeds the renovation service catalog into an organization through the catalog command bus.',
  requires: ['catalog', 'sales', 'dictionaries', 'directory'],
}

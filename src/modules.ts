
// Central place to enable modules and their source.
// - id: module id (plural snake_case; special cases: 'auth')
// - from: '@open-mercato/core' | '@app' | custom alias/path in future
import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'

export type ModuleEntry = { id: string; from?: '@open-mercato/core' | '@app' | string }

export const enabledModules: ModuleEntry[] = [
  { id: 'auth', from: '@open-mercato/core' },
  { id: 'api_keys', from: '@open-mercato/core' },
  { id: 'directory', from: '@open-mercato/core' },
  { id: 'configs', from: '@open-mercato/core' },
  { id: 'entities', from: '@open-mercato/core' },
  { id: 'query_index', from: '@open-mercato/core' },
  { id: 'progress', from: '@open-mercato/core' },
  { id: 'api_docs', from: '@open-mercato/core' },
  { id: 'audit_logs', from: '@open-mercato/core' },
  { id: 'notifications', from: '@open-mercato/core' },
  { id: 'dashboards', from: '@open-mercato/core' },
  { id: 'events', from: '@open-mercato/events' },
  { id: 'search', from: '@open-mercato/search' },
  // Integration Marketplace. Owns `integrationCredentialsService` and the
  // `integration_credentials` table, so it has to precede every provider that
  // stores credentials — `storage_s3` below resolves that token to authenticate
  // the S3 driver, and the agent artifact store fails closed without it.
  { id: 'integrations', from: '@open-mercato/core' },
  { id: 'attachments', from: '@open-mercato/core' },
  { id: 'customers', from: '@open-mercato/core' },
  { id: 'messages', from: '@open-mercato/core' },
  { id: 'dictionaries', from: '@open-mercato/core' },
  { id: 'feature_toggles', from: '@open-mercato/core' },
  { id: 'currencies', from: '@open-mercato/core' },
  // catalog ships product/variant/price primitives; sales owns SalesChannel +
  // SalesTaxRate, which catalog's product API and price/variant commands read at
  // runtime, and sales declares `requires: ['catalog', 'customers', 'dictionaries']`.
  { id: 'catalog', from: '@open-mercato/core' },
  { id: 'sales', from: '@open-mercato/core' },
  { id: 'business_rules', from: '@open-mercato/core' },
  { id: 'workflows', from: '@open-mercato/core' },
  { id: 'communication_channels', from: '@open-mercato/core' },
  // The Communications Hub resolves an outbound adapter by `providerKey`, and the
  // adapter only reaches the registry through this module's `register()`. The
  // `@open-mercato/channel-resend` dependency alone does nothing: without this entry
  // `yarn generate` writes a DI registry with no Resend adapter, the env preset never
  // seeds credentials, and every send throws "No ChannelAdapter registered for
  // providerKey 'resend'" at runtime with no boot-time warning. Must follow
  // `communication_channels` and `integrations` — it declares both as requirements.
  { id: 'channel_resend', from: '@open-mercato/channel-resend' },
  { id: 'ai_assistant', from: '@open-mercato/ai-assistant' },
  { id: 'inbox_ops', from: '@open-mercato/core' },
  { id: 'catalog_seed', from: '@app' },
]

// S3-backed attachment storage. Fargate has no persistent volume, so with this off
// every upload lands on the container filesystem and disappears on the next task
// restart — the attachments partition UI even offers "S3" (it only checks the env
// flag), while StorageDriverFactory silently falls back to the local driver because
// nothing ever registered an `s3` driver. Like the enterprise flags below, this is a
// BUILD-time input: `yarn generate` writes the registry from this list.
const storageS3Enabled = parseBooleanWithDefault(process.env.OM_ENABLE_STORAGE_S3, false)

if (storageS3Enabled) {
  enabledModules.push({ id: 'storage_s3', from: '@open-mercato/storage-s3' })
}

// This app does not work without the enterprise modules: `rfq_intake`,
// `property_documents` and `agent_examples` all hang off the agent orchestrator, so
// with these two off `yarn generate` writes a registry WITHOUT them and the inbox
// `create_quote` override silently reverts to the installed sales action. The
// scaffold defaults them to `false`, which is right for a stock app and wrong here —
// and it fails quietly at BUILD time, not at runtime. Default them ON and keep the
// env vars as an explicit opt-OUT. SSO and security stay off: nothing here needs them.
const enterpriseModulesEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES, true)
const enterpriseSsoEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_SSO, false)
const enterpriseSecurityEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_SECURITY, false)
const enterpriseAgentsEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_AGENTS, true)

if (enterpriseModulesEnabled) {
  enabledModules.push(
    { id: 'record_locks', from: '@open-mercato/enterprise' },
    { id: 'system_status_overlays', from: '@open-mercato/enterprise' },
  )
}

if (enterpriseModulesEnabled && enterpriseSsoEnabled) {
  enabledModules.push({ id: 'sso', from: '@open-mercato/enterprise' })
}

if (enterpriseModulesEnabled && enterpriseSecurityEnabled) {
  enabledModules.push({ id: 'security', from: '@open-mercato/enterprise' })
}

if (enterpriseModulesEnabled && enterpriseAgentsEnabled) {
  enabledModules.push({ id: 'agent_orchestrator', from: '@open-mercato/enterprise' })
  // Example app module: shows how to declare an Agent Orchestrator agent from a
  // brand-new module. Its source ships in every preset; it imports the
  // orchestrator SDK, so it is only enabled alongside it.
  enabledModules.push({ id: 'agent_examples', from: '@app' })
  enabledModules.push({ id: 'property_documents', from: '@app' })
  // RFQ intake: overrides the inbox `create_quote` action and owns the agent chain
  // that reads the RFQ document. Registered LAST on purpose — the generated inbox
  // action registry keeps the last definition for a type, so this entry has to come
  // after `sales` for the override to win. It needs the orchestrator's agentRuntime
  // and the property_documents agent ids, so it lives in this block.
  enabledModules.push({ id: 'rfq_intake', from: '@app' })
}

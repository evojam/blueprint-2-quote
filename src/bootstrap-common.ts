import './lib/i18n/register-dictionary-loader'

import type { BootstrapData } from '@open-mercato/shared/lib/bootstrap'
import { enabledModules } from '@/modules'
import { applyModuleOverridesFromEnabledModules } from '@open-mercato/shared/modules/overrides'
import '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-overrides'

import { modules } from '@/.mercato/generated/modules.bootstrap.generated'
import { entities } from '@/.mercato/generated/entities.generated'
import { diRegistrars } from '@/.mercato/generated/di.generated'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { entityFieldsRegistry } from '@/.mercato/generated/entity-fields-registry'
import '@/.mercato/generated/translations-fields.generated'
import { injectionTables } from '@/.mercato/generated/injection-tables.generated'
import { searchModuleConfigs } from '@/.mercato/generated/search.generated'
import { eventModuleConfigs } from '@/.mercato/generated/events.generated'
import { registerEventModuleConfigs } from '@open-mercato/shared/modules/events'
import { analyticsModuleConfigs } from '@/.mercato/generated/analytics.generated'
import { enricherEntries } from '@/.mercato/generated/enrichers.generated'
import { interceptorEntries } from '@/.mercato/generated/interceptors.generated'
import { guardEntries } from '@/.mercato/generated/guards.generated'
import { commandInterceptorEntries } from '@/.mercato/generated/command-interceptors.generated'
import { commandLoaderEntries } from '@/.mercato/generated/command-loaders.generated'
import { messageTypes } from '@/.mercato/generated/message-types.generated'
import { messageObjectTypes } from '@/.mercato/generated/message-objects.generated'
import { notificationTypes } from '@/.mercato/generated/notifications.generated'
import { registerMessageTypes } from '@open-mercato/core/modules/messages/lib/message-types-registry'
import { registerMessageObjectTypes } from '@open-mercato/core/modules/messages/lib/message-objects-registry'
import { registerNotificationTypes } from '@open-mercato/core/modules/notifications/lib/notification-type-registry'
import { runBootstrapRegistrations } from '@/.mercato/generated/bootstrap-registrations.generated'
import { allCodeWorkflows } from '@/.mercato/generated/workflows.generated'
import { registerCodeWorkflows } from '@open-mercato/core/modules/workflows/lib/code-registry'

applyModuleOverridesFromEnabledModules(enabledModules)
registerEventModuleConfigs(eventModuleConfigs)
registerMessageTypes(messageTypes, { replace: true })
registerMessageObjectTypes(messageObjectTypes, { replace: true })
registerNotificationTypes(notificationTypes, { replace: true })
/**
 * Code workflows shipped by installed modules that this app does not run.
 *
 * `modules.ts` overrides have no `workflows` domain, so filtering the registration
 * here is the only app-owned seam — and unlike disabling each one in the UI, it is
 * in git and applies to every environment.
 *
 * The first two are demos (`Testing`, `E-commerce`). `sales.order-approval` is a
 * deliberate product removal, not cleanup: it carries a live trigger on
 * `sales.order.created` and an injected widget on the order page. This app quotes
 * renovation work; it does not run an order approval chain.
 */
const DISABLED_CODE_WORKFLOW_IDS = new Set([
  'workflows.simple-approval',
  'workflows.checkout-demo',
  'sales.order-approval',
])

registerCodeWorkflows(
  allCodeWorkflows.filter((workflow) => !DISABLED_CODE_WORKFLOW_IDS.has(workflow.workflowId)),
)
runBootstrapRegistrations()

type ServerFoundationBootstrapData = Omit<
  BootstrapData,
  | 'dashboardWidgetEntries'
  | 'injectionWidgetEntries'
  | 'componentOverrideEntries'
  | 'notificationHandlerEntries'
>

export const serverFoundationBootstrapData: ServerFoundationBootstrapData = {
  modules,
  entities,
  diRegistrars,
  entityIds: E,
  entityFieldsRegistry,
  injectionTables,
  searchModuleConfigs,
  analyticsModuleConfigs,
  enricherEntries,
  interceptorEntries,
  guardEntries,
  commandInterceptorEntries,
  commandLoaderEntries,
}

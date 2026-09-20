import './lib/i18n/register-dictionary-loader'

import type { BootstrapData } from '@open-mercato/shared/lib/bootstrap'
import { enabledModules } from '@/modules'
import { applyApiRouteOverrides, applyModuleOverridesFromEnabledModules } from '@open-mercato/shared/modules/overrides'
import { PUBLIC_QUOTE_ACCEPT_ROUTE_OVERRIDE } from '@/lib/publicQuoteAcceptOrigin'
import { RFQ_QUOTE_SEND_ROUTE_OVERRIDE } from '@/modules/rfq_intake/lib/quoteSendOverride'
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

/**
 * Keeps `POST /api/sales/quotes/accept` reachable behind the ALB.
 *
 * The installed guard compares the browser `Origin` against `new URL(req.url).origin`,
 * which Next.js standalone builds from its own listen identity — `https://localhost:3000`
 * here. Every customer therefore gets 403 on Accept while the quote page itself renders.
 * Mechanism and measurements: `src/lib/publicQuoteAcceptOrigin.ts` and
 * `.ai/notes/quote-accept-failure-leads.md`. Upstream: open-mercato/open-mercato#6283.
 *
 * Registered HERE, programmatically, rather than as an `entry.overrides.routes.api` entry
 * in `src/modules.ts` — which is where the unified-override reference points first, and
 * which does not work in this app. `ClientBootstrap.tsx:66` does `import('@/modules')` in
 * the BROWSER to apply the widget and notification overrides, so anything `modules.ts`
 * imports is client-reachable. Naming the handler there dragged the installed sales route,
 * and `server-only` with it, into the client graph: `yarn build` failed with 48 Turbopack
 * errors whose import trace read modules.ts -> ClientBootstrap -> layout.tsx. This file is
 * imported only by `bootstrap.ts` and `bootstrap-api.ts`, both server-side.
 *
 * Ordering is load-bearing: `applyApiRouteOverrides` mutates a store that
 * `registerApiRouteManifests` reads ONCE, and a call made after manifests are registered
 * does not apply retro-actively. Module-level statements here run while `bootstrap.ts` /
 * `bootstrap-api.ts` are still resolving their imports, so this lands before
 * `createBootstrap(...)` executes.
 */
applyApiRouteOverrides(PUBLIC_QUOTE_ACCEPT_ROUTE_OVERRIDE)

/**
 * Moves an RFQ case to `Oferta wysłana` when its quote is sent to the customer.
 *
 * Same registration seam and the same reason as the accept override above: naming a
 * server handler in `src/modules.ts` pulls the installed sales route into the browser
 * graph through `ClientBootstrap`. Why the route is replaced at all rather than hooked —
 * the send route emits nothing and reaches none of the four UMES seams — is recorded on
 * `RFQ_QUOTE_SEND_ROUTE_OVERRIDE` itself.
 *
 * Gated on the BUILT registry rather than on `enabledModules` or a new environment
 * variable, and that distinction is load-bearing rather than pedantic.
 *
 * `enabledModules` is `src/modules.ts` evaluated right now, so it reports what the env
 * vars ASK for. `modules` is `.mercato/generated/modules.bootstrap.generated.ts`, which
 * is what `yarn generate` actually built — and it is the same registry the command bus
 * resolves `rfq_intake.deal.advance` from. The two disagree whenever the generated
 * artifacts were produced under different flags than the process now runs with, which is
 * exactly the committed state of this repo: the `.ts` artifacts carry `record_locks` but
 * no `rfq_intake`, while the `.mjs` ones (the CLI's) carry it.
 *
 * Gating on intent would therefore register the override on a runtime that has no such
 * command: every send would log a caught "command not found" and no case would ever move,
 * with nothing else to see. Gating on the built registry makes the override appear exactly
 * when the command it calls does.
 */
if (modules.some((entry) => entry.id === 'rfq_intake')) {
  applyApiRouteOverrides(RFQ_QUOTE_SEND_ROUTE_OVERRIDE)
}

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

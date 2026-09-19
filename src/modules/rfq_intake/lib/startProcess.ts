import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { ProcessDefinition } from '@open-mercato/enterprise/modules/agent_orchestrator/data/entities'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { RFQ_ANALYSIS_WORKFLOW_ID } from '../workflows'
import type { Scope } from './pipeline'

const logger = createLogger('rfq_intake').child({ component: 'start-process' })

type CommandBusLike = {
  execute: (
    commandId: string,
    options: { input: unknown; ctx: CommandRuntimeContext },
  ) => Promise<unknown>
}

type Resolver = <T = unknown>(name: string) => T

export type RfqAnalysisInput = {
  dealId: string
  proposalId: string
  emailId: string
  __files: { attachments: Array<{ attachmentId: string }> }
}

/**
 * Starts the RFQ analysis as an Agent Orchestrator PROCESS execution rather than as a
 * bare workflow instance.
 *
 * Two things follow from that, and the second is the reason it is not optional.
 *
 * 1. The run becomes visible where a business reader looks for it. A workflow started
 *    straight off a code trigger produces a `workflow_instances` row and nothing else,
 *    so the orchestrator's process list shows "never run" however many RFQs went
 *    through. Going through the process produces a `ProcessInstance` tied to the
 *    definition, which is what fills that column and the execution history.
 *
 * 2. It is the only entry point that carries the acting user.
 *    `process-execution-starter.ts` derives the workflow's `initiatedBy` from
 *    `parseTriggeredByUser`, which returns a user for `kind: 'manual'` and `null` for
 *    every other kind. A definition-level `event` trigger would therefore hand the
 *    workflow no actor at all — and a code workflow has no `grantedFeatures` principal
 *    to fall back on, so INVOKE_AGENT and UPDATE_ENTITY would both refuse. That is the
 *    exact failure the `userId` fix removed; routing through an event trigger would
 *    reintroduce it while looking like an improvement.
 *
 * `kind: 'manual'` is therefore accurate rather than convenient: a human accepted the
 * action in the inbox, and `ref` is that human. The event in between is transport.
 */
export async function startRfqAnalysisProcess(
  resolve: Resolver,
  em: EntityManager,
  scope: Scope,
  userId: string,
  input: RfqAnalysisInput,
): Promise<{ started: boolean; reason?: string }> {
  const definition = await em.findOne(ProcessDefinition, {
    ...scope,
    workflowId: RFQ_ANALYSIS_WORKFLOW_ID,
    deletedAt: null,
  })
  if (!definition) {
    // Seeding is `mercato init` or `mercato rfq_intake seed-process`. A missing
    // definition is a setup gap worth naming, not something to paper over by starting
    // the workflow directly — that would silently restore the invisible path.
    return { started: false, reason: 'no RFQ process definition in this organization' }
  }
  if (!definition.enabled) {
    return { started: false, reason: 'the RFQ process definition is disabled' }
  }

  const commandBus = resolve<CommandBusLike>('commandBus')
  const ctx: CommandRuntimeContext = {
    // The subscriber holds a resolver, not a container. The command only resolves
    // services from it, so a resolver plus a cradle proxy is the whole surface it
    // needs — the same shape the installed process-event-trigger subscriber builds.
    container: {
      resolve,
      cradle: new Proxy({}, { get: (_target, prop: string) => resolve(prop) }),
    } as unknown as CommandRuntimeContext['container'],
    auth: null,
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  }

  await commandBus.execute('agent_orchestrator.processes.startExecution', {
    input: {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      processDefinitionId: definition.id,
      input,
      triggeredBy: { kind: 'manual' as const, ref: userId },
      sourceEntityType: 'customer_deal',
      sourceEntityId: input.dealId,
      // One analysis per case. The subscriber is persistent, so a redelivery must not
      // buy a second run; the command returns the winner instead of starting one.
      idempotencyKey: `rfq_intake.analysis:${input.dealId}`,
    },
    ctx,
  })

  logger.info('RFQ analysis process started', {
    processDefinitionId: definition.id,
    dealId: input.dealId,
  })
  return { started: true }
}

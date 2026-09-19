import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { defineAiTool } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-tool-definition'
import type { AiToolDefinition, McpToolContext } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { AgentRun } from '@open-mercato/enterprise/modules/agent_orchestrator/data/entities'
import {
  CATALOG_MATCHER_AGENT_ID,
  catalogMatcherGroupedResultSchema,
} from '../property_documents/ai-agents'
import { ROOM_MEASUREMENTS_AGENT_ID } from '../property_documents/ai-tools'
import { roomMeasurementSetSchema } from '../property_documents/room-measurements-contract'

export const QUOTE_CONTEXT_TOOL_ID = 'rfq_intake.load_quote_context'

const inputSchema = z.object({
  dealId: z.string().uuid(),
  workflowInstanceId: z.string().uuid(),
}).strict()

const outputSchema = z.object({
  dealId: z.string().uuid(),
  roomMeasurementsRunId: z.string().uuid(),
  roomMeasurements: roomMeasurementSetSchema,
  catalogMatches: catalogMatcherGroupedResultSchema.shape.data,
}).strict()

function scope(context: McpToolContext) {
  if (!context.tenantId || !context.organizationId) throw new Error('[internal] quote context scope is unavailable')
  return { tenantId: context.tenantId, organizationId: context.organizationId }
}

export function createQuoteContextTool(): AiToolDefinition {
  return defineAiTool<unknown, z.infer<typeof outputSchema>>({
    name: QUOTE_CONTEXT_TOOL_ID,
    displayName: 'RFQ — load quote context',
    description: 'Load the scoped measurement and catalog-matching results for one RFQ workflow instance.',
    tags: ['read', 'rfq', 'quote'],
    isMutation: false,
    maxCallsPerTurn: 1,
    requiredFeatures: ['customers.deals.manage', 'sales.quotes.manage'],
    inputSchema,
    async handler(rawInput, context) {
      const input = inputSchema.parse(rawInput)
      const scoped = scope(context)
      const em = context.container.resolve('em') as EntityManager
      const [measurement, match] = await Promise.all([
        em.findOne(AgentRun, {
          ...scoped,
          workflowInstanceId: input.workflowInstanceId,
          stepId: 'measure_rooms',
          agentId: ROOM_MEASUREMENTS_AGENT_ID,
          status: 'ok',
          resultKind: 'research',
          deletedAt: null,
        }, { orderBy: { createdAt: 'DESC' } }),
        em.findOne(AgentRun, {
          ...scoped,
          workflowInstanceId: input.workflowInstanceId,
          stepId: 'match_catalog',
          agentId: CATALOG_MATCHER_AGENT_ID,
          status: 'ok',
          resultKind: 'research',
          deletedAt: null,
        }, { orderBy: { createdAt: 'DESC' } }),
      ])
      const measurements = measurement ? roomMeasurementSetSchema.safeParse((measurement.output as { data?: unknown } | null)?.data) : null
      const matches = match ? catalogMatcherGroupedResultSchema.safeParse(match.output) : null
      if (!measurement || !measurements?.success || !match || !matches?.success) {
        throw new Error('[internal] completed quote context is unavailable')
      }
      return outputSchema.parse({
        dealId: input.dealId,
        roomMeasurementsRunId: measurement.id,
        roomMeasurements: measurements.data,
        catalogMatches: matches.data.data,
      })
    },
  })
}

export const aiTools: AiToolDefinition[] = [createQuoteContextTool()]
export default aiTools

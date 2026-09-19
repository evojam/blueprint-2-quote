import { z } from 'zod'
import type { AiAgentDefinition } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-agent-definition'
import { defineAgent, type DefineAgentInput } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'
import { QUOTE_CONTEXT_TOOL_ID } from './ai-tools'

export const QUOTE_DRAFTER_AGENT_ID = 'rfq_intake.quote_drafter'

const quoteDraftResultSchema = z.object({
  kind: z.literal('proposal'),
  proposal: z.object({
    actions: z.array(z.object({
      type: z.literal('rfq_intake.quote.create'),
      payload: z.object({
        dealId: z.string().uuid(),
        roomMeasurementsRunId: z.string().uuid(),
        items: z.array(z.object({
          catalogProductId: z.string().uuid(),
          variantId: z.string().uuid().optional(),
          basis: z.enum(['floor_area', 'gross_wall_area', 'net_wall_area', 'count', 'given']),
          roomIds: z.array(z.string()).optional(),
          count: z.number().int().positive().optional(),
          given: z.object({ value: z.number().positive(), unit: z.enum(['m2', 'mb', 'szt', 'kpl']) }).optional(),
          note: z.string().max(1000).optional(),
        })).min(1).max(100),
      }).strict(),
    })).max(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(2000),
  }).strict(),
}).strict()

const definition = {
  id: QUOTE_DRAFTER_AGENT_ID,
  moduleId: 'rfq_intake',
  label: 'RFQ quote drafter',
  description: 'Proposes one scoped quote-create command from room measurements and catalog matches.',
  instructions: [
    'You draft at most one RFQ quote proposal. You never write records or call mutation tools.',
    'First call rfq_intake.load_quote_context with the supplied dealId and workflowInstanceId.',
    'Use only returned catalog product IDs and only measurement-supported quantities and room IDs.',
    'For a quote action, copy dealId and roomMeasurementsRunId from the tool result.',
    'Use floor_area, gross_wall_area, or net_wall_area only with non-empty roomIds. Use count only for a positive count. Use given only with a positive value and a supported unit.',
    'Return one rfq_intake.quote.create action only when it is safe. Otherwise return no actions and explain the limitation in rationale; never invent an item or quantity.',
  ].join(' '),
  tools: [QUOTE_CONTEXT_TOOL_ID],
  agentType: 'action',
  allowedActions: ['rfq_intake.quote.create'],
  loop: { maxSteps: 2 },
  result: { kind: 'proposal', schema: quoteDraftResultSchema },
  sampleInput: {
    dealId: '11111111-1111-4111-8111-111111111111',
    workflowInstanceId: '22222222-2222-4222-8222-222222222222',
  },
} satisfies DefineAgentInput

export const aiAgents: AiAgentDefinition[] = [defineAgent(definition)]
export default aiAgents

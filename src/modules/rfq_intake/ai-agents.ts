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
        // Nullable, never optional: `@ai-sdk/openai` sends structured outputs with
        // `strict: true`, where every property must also appear in `required`, so a
        // single `?` is a 400 before the model runs. `rfq_intake.quote.create` strips
        // the nulls back out — see `quote-create.ts`.
        items: z.array(z.object({
          catalogProductId: z.string().uuid(),
          variantId: z.string().uuid().nullable(),
          basis: z.enum(['floor_area', 'gross_wall_area', 'net_wall_area', 'count', 'given']),
          roomIds: z.array(z.string()).nullable(),
          count: z.number().int().positive().nullable(),
          given: z.object({ value: z.number().positive(), unit: z.enum(['m2', 'mb', 'szt', 'kpl']) }).strict().nullable(),
          note: z.string().max(1000).nullable(),
        }).strict()).min(1).max(100),
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
    'Use only returned catalog product IDs, room IDs, and measurement values. Treat measurements with method estimated as usable POC inputs, and retain their estimate provenance in the item note.',
    'For a quote action, copy dealId and roomMeasurementsRunId from the tool result.',
    'Use floor_area, gross_wall_area, or net_wall_area only with non-empty roomIds. Use count only for a positive count. Use given only with a positive value and a supported unit.',
    'Every basis produces one unit: floor_area, gross_wall_area and net_wall_area produce m2, count produces szt, and given produces the unit you state. catalogUnits gives each matched product the unit it is billed in.',
    'An item whose basis produces a unit other than the defaultUnit of that product is discarded by the command and contributes nothing to the quote, so never pair them: bill an m2 product by area, a szt product by count, and an mb or kpl product with given in that same unit.',
    'Skip a product whose catalogUnits entry is missing or whose defaultUnit is null, and skip one whose unit no available measurement can produce. Name every skipped product in rationale instead of forcing it into a mismatched basis.',
    'Every item field is required: set variantId, roomIds, count, given and note to null wherever the chosen basis does not use them.',
    'When no source-grounded quantity is available, use returned estimated measurements to propose the closest realistic positive quantity. Return one rfq_intake.quote.create action whenever a matching catalog item exists; never present an estimate as source-grounded.',
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

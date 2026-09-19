import { defineWorkflow, createWorkflowsModuleConfig } from '@open-mercato/shared/modules/workflows'
import { registerWorkflowSafeCommands } from '@open-mercato/core/modules/workflows/lib/workflow-safe-commands'
import { PDF_AGENT_ID } from '@/modules/property_documents/ai-tools'

/**
 * A workflow may only call a command that is declared workflow-safe. Neither entry is
 * `defaultEnabled` — upstream explicitly discourages grandfathering new commands — so
 * a tenant has to enable them once in the workflow-command settings before the chain
 * runs past `pdf_intake`.
 */
registerWorkflowSafeCommands([
  {
    commandId: 'rfq_intake.deal.advance',
    requiredFeatures: ['customers.deals.manage'],
    labelKey: 'rfq_intake.workflows.commands.deal.advance',
  },
  {
    commandId: 'rfq_intake.plans.analyze',
    requiredFeatures: ['customers.deals.manage'],
    labelKey: 'rfq_intake.workflows.commands.plans.analyze',
  },
  {
    commandId: 'rfq_intake.requirements.match',
    requiredFeatures: ['customers.deals.manage'],
    labelKey: 'rfq_intake.workflows.commands.requirements.match',
  },
])

/**
 * Exported so tests and any future seeder name the workflow once. Two literals
 * drifting apart would leave a trigger pointing at a workflow that does not exist.
 */
export const RFQ_ANALYSIS_WORKFLOW_ID = 'rfq_intake.analysis'

/**
 * RFQ analysis chain.
 *
 * Code-defined on purpose: `registerCodeWorkflows` in `src/bootstrap-common.ts` puts
 * it in the registry, so the graph is reproducible from git with no seed and no click.
 * A database row carrying the same `workflowId` shadows this definition, which is what
 * lets the process grow in the Studio later without a migration.
 *
 * It declares NO trigger of its own. The entry point is the Agent Orchestrator process
 * definition bound to this workflow, started from `lib/startProcess.ts` when an RFQ
 * action is accepted. An embedded event trigger here would start a second, parallel
 * instance for the same RFQ, and that instance would carry no acting user — see
 * `lib/startProcess.ts` for why that cannot execute a single step.
 *
 * The graph is deliberately short. The per-plan and per-requirement iteration lives in
 * the two commands below rather than in the graph, because the engine has no dynamic
 * fan-out and because the agents are single-input by design — narrow keeps each of
 * them testable in isolation.
 */
const rfqAnalysis = defineWorkflow({
  workflowId: RFQ_ANALYSIS_WORKFLOW_ID,
  workflowName: 'RFQ document analysis',
  description: 'Reads the RFQ PDF, measures every floor plan, and matches every requirement against the catalog.',
  metadata: { category: 'RFQ', tags: ['rfq', 'agents', 'property'], icon: 'file-search' },
  steps: [
    { stepId: 'start', stepName: 'Start', stepType: 'START', description: 'RFQ case opened from the inbox' },
    {
      stepId: 'mark_quoting',
      stepName: 'Mark the case as being quoted',
      stepType: 'AUTOMATED',
      description: 'Moves the CRM case to `Wycena w toku`, so the funnel shows the engine started.',
      activities: [
        {
          activityId: 'mark_quoting_activity',
          activityName: 'Mark the case as being quoted',
          activityType: 'UPDATE_ENTITY',
          async: false,
          config: {
            commandId: 'rfq_intake.deal.advance',
            input: {
              tenantId: '{{workflow.tenantId}}',
              organizationId: '{{workflow.organizationId}}',
              dealId: '{{context.dealId}}',
              stage: 'quoting',
            },
          },
        },
      ],
    },
    {
      stepId: 'extract_pdf',
      stepName: 'Read the RFQ document',
      stepType: 'AUTOMATED',
      description: 'Splits the PDF into a brief and plan-view drawings.',
      activities: [
        {
          activityId: 'invoke_pdf_intake',
          activityName: `Invoke ${PDF_AGENT_ID}`,
          // HACK(hackathon): `ActivityType` in @open-mercato/shared is stale and does
          // not list INVOKE_AGENT, although the runtime registry treats it as a
          // built-in (`workflows/data/validators.ts:152`, `invokeAgentConfigSchema`).
          // Cast until the shared union catches up.
          activityType: 'INVOKE_AGENT' as never,
          async: false,
          config: {
            agentId: PDF_AGENT_ID,
            // Empty means "the whole start context is the agent's input", which is
            // how the reserved `__files` envelope reaches the runtime intact.
            input: {},
            // `pdf_intake` is an artifact agent: it raises no proposal, so there is
            // nothing for a human to dispose of and a threshold of 0 states that
            // plainly. The review gate belongs on the pricing step, not here.
            onResult: { autoApproveThreshold: 0 },
          },
        },
      ],
    },
    {
      stepId: 'measure_plans',
      stepName: 'Measure every floor plan',
      stepType: 'AUTOMATED',
      description: 'Promotes each plan drawing to an attachment and runs the room-dimension agent over it.',
      activities: [
        {
          activityId: 'analyze_plans',
          activityName: 'Analyze floor plans',
          activityType: 'UPDATE_ENTITY',
          async: false,
          config: {
            commandId: 'rfq_intake.plans.analyze',
            input: {
              tenantId: '{{workflow.tenantId}}',
              organizationId: '{{workflow.organizationId}}',
              workflowInstanceId: '{{workflow.instanceId}}',
              dealId: '{{context.dealId}}',
              stepId: 'measure_plans',
            },
          },
        },
      ],
    },
    {
      stepId: 'match_catalog',
      stepName: 'Match requirements to the catalog',
      stepType: 'AUTOMATED',
      description: 'Runs the catalog matcher once per requirement stated in the brief.',
      activities: [
        {
          activityId: 'match_requirements',
          activityName: 'Match requirements',
          activityType: 'UPDATE_ENTITY',
          async: false,
          config: {
            commandId: 'rfq_intake.requirements.match',
            input: {
              tenantId: '{{workflow.tenantId}}',
              organizationId: '{{workflow.organizationId}}',
              workflowInstanceId: '{{workflow.instanceId}}',
              dealId: '{{context.dealId}}',
              stepId: 'match_catalog',
            },
          },
        },
      ],
    },
    {
      stepId: 'mark_review',
      stepName: 'Hand the case to a human',
      stepType: 'AUTOMATED',
      description: 'Moves the CRM case to `Do sprawdzenia`: brief, geometry and matches are ready for review.',
      activities: [
        {
          activityId: 'mark_review_activity',
          activityName: 'Hand the case to a human',
          activityType: 'UPDATE_ENTITY',
          async: false,
          config: {
            commandId: 'rfq_intake.deal.advance',
            input: {
              tenantId: '{{workflow.tenantId}}',
              organizationId: '{{workflow.organizationId}}',
              dealId: '{{context.dealId}}',
              stage: 'review',
            },
          },
        },
      ],
    },
    { stepId: 'end', stepName: 'Done', stepType: 'END' },
  ],
  transitions: [
    { transitionId: 't_start', transitionName: 'Start', fromStepId: 'start', toStepId: 'mark_quoting', trigger: 'auto' },
    { transitionId: 't_extract', transitionName: 'Extract', fromStepId: 'mark_quoting', toStepId: 'extract_pdf', trigger: 'auto' },
    { transitionId: 't_measure', transitionName: 'Measure', fromStepId: 'extract_pdf', toStepId: 'measure_plans', trigger: 'auto' },
    { transitionId: 't_match', transitionName: 'Match', fromStepId: 'measure_plans', toStepId: 'match_catalog', trigger: 'auto' },
    { transitionId: 't_review', transitionName: 'Review', fromStepId: 'match_catalog', toStepId: 'mark_review', trigger: 'auto' },
    { transitionId: 't_done', transitionName: 'Done', fromStepId: 'mark_review', toStepId: 'end', trigger: 'auto' },
  ],
})

/**
 * Strict interpolation, set on the definition data because the builder config does
 * not expose it. Lenient is the default and would let an unresolved `{{context.dealId}}`
 * through as its own literal text — a command would then be handed the string
 * "{{context.dealId}}" as a uuid. Failing the step is the better answer.
 */
const rfqAnalysisStrict = {
  ...rfqAnalysis,
  definition: { ...rfqAnalysis.definition, interpolation: 'strict' as const },
}

export const workflowsConfig = createWorkflowsModuleConfig({
  moduleId: 'rfq_intake',
  workflows: [rfqAnalysisStrict],
})

export default workflowsConfig

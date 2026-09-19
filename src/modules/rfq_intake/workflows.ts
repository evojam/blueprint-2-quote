import { defineWorkflow, createWorkflowsModuleConfig } from '@open-mercato/shared/modules/workflows'
import { registerWorkflowSafeCommands } from '@open-mercato/core/modules/workflows/lib/workflow-safe-commands'
import { PDF_AGENT_ID } from '@/modules/property_documents/ai-tools'

/**
 * The workflow may only call commands declared workflow-safe.
 */
registerWorkflowSafeCommands([
  {
    // Deliberately NOT `defaultEnabled`: upstream reserves that flag for commands that
    // were already reachable before the tenant gate existed, and a new candidate that
    // sets it hands itself the tenant's decision. The cost is real and has to be paid
    // once per environment — until it is ticked under Settings -> Konfiguracja modulow
    // -> Polecenia automatyzacji, the first step below fails the whole run with
    // `UPDATE_ENTITY command is not enabled for this tenant`.
    commandId: 'rfq_intake.deal.advance',
    requiredFeatures: ['customers.deals.manage'],
    labelKey: 'rfq_intake.workflows.commands.deal.advance',
  },
  {
    commandId: 'rfq_intake.requirements.match',
    requiredFeatures: ['customers.deals.manage'],
    labelKey: 'rfq_intake.workflows.commands.requirements.match',
  },
  {
    // Declaring it here is what puts the command in the Agent Orchestrator's action
    // vocabulary (`listWorkflowSafeCommands() ∪ activityTypes()`), so a proposed
    // action can effect it. Without this entry the action comes back `skipped`, not
    // failed — which is why the declaration has its own regression test.
    commandId: 'rfq_intake.quote.create',
    requiredFeatures: ['customers.deals.manage', 'sales.quotes.manage'],
    labelKey: 'rfq_intake.workflows.commands.quote.create',
  },
  {
    commandId: 'rfq_intake.measure-rooms',
    requiredFeatures: ['customers.deals.manage'],
    labelKey: 'rfq_intake.workflows.commands.measure-rooms',
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
 * instance for the same RFQ, and that instance would carry no acting user.
 */
const rfqAnalysis = defineWorkflow({
  workflowId: RFQ_ANALYSIS_WORKFLOW_ID,
  workflowName: 'RFQ document analysis',
  description: 'Reads the RFQ PDF, extracts room measurements, and matches the brief against the catalog.',
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
            // The stage id is a per-tenant row, so the graph can only name the stage
            // symbolically; `rfq_intake.deal.advance` resolves it at run time and
            // routes the write through `customers.deals.update` so the card keeps a
            // transition history instead of a silently mutated column.
            commandId: 'rfq_intake.deal.advance',
            input: {
              tenantId: '{{workflow.tenantId}}',
              organizationId: '{{workflow.organizationId}}',
              // `initialContext` is the process input verbatim
              // (`process-execution-starter.ts:196`), and `lib/startProcess.ts` puts
              // `dealId` there — the same path `{{context.__files}}` takes.
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
      description: 'Extracts the PDF brief and rendered page artifacts.',
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
            input: {
              __files: '{{context.__files}}',
            },
            onResult: { autoApproveThreshold: 0 },
          },
        },
      ],
    },
    {
      stepId: 'measure_rooms',
      stepName: 'Measure rendered PDF pages',
      stepType: 'AUTOMATED',
      description: 'Runs strict room measurement extraction for every rendered PDF page.',
      activities: [
        {
          activityId: 'measure_rendered_pages',
          activityName: 'Measure rendered pages',
          activityType: 'UPDATE_ENTITY',
          config: {
            commandId: 'rfq_intake.measure-rooms',
            input: {
              tenantId: '{{workflow.tenantId}}',
              organizationId: '{{workflow.organizationId}}',
              workflowInstanceId: '{{workflow.instanceId}}',
              dealId: '{{context.dealId}}',
              stepId: 'measure_rooms',
            },
          },
        },
      ],
    },
    {
      stepId: 'match_catalog',
      stepName: 'Match the brief to the catalog',
      stepType: 'AUTOMATED',
      description: 'Runs grouped catalog matching after room measurements finish.',
      activities: [
        {
          activityId: 'match_requirements',
          activityName: 'Match requirements',
          activityType: 'UPDATE_ENTITY',
          config: {
            commandId: 'rfq_intake.requirements.match',
            input: {
              tenantId: '{{workflow.tenantId}}',
              organizationId: '{{workflow.organizationId}}',
              workflowInstanceId: '{{workflow.instanceId}}',
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
      description: 'Moves the CRM case to `Do sprawdzenia`: brief, measurements and matches are ready for review.',
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
    { transitionId: 't_measure', transitionName: 'Measure', fromStepId: 'extract_pdf', toStepId: 'measure_rooms', trigger: 'auto' },
    { transitionId: 't_match', transitionName: 'Match', fromStepId: 'measure_rooms', toStepId: 'match_catalog', trigger: 'auto' },
    { transitionId: 't_review', transitionName: 'Review', fromStepId: 'match_catalog', toStepId: 'mark_review', trigger: 'auto' },
    { transitionId: 't_done', transitionName: 'Done', fromStepId: 'mark_review', toStepId: 'end', trigger: 'auto' },
  ],
})

/**
 * Strict interpolation, set on the definition data because the builder config does
 * not expose it. Lenient interpolation would let an unresolved workflow value reach
 * a command as literal text instead of failing the step.
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

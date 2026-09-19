import { defineWorkflow, createWorkflowsModuleConfig } from '@open-mercato/shared/modules/workflows'
import { registerWorkflowSafeCommands } from '@open-mercato/core/modules/workflows/lib/workflow-safe-commands'
import { PDF_AGENT_ID } from '@/modules/property_documents/ai-tools'

/**
 * The workflow may only call commands declared workflow-safe. The matcher remains
 * opt-in for each tenant through workflow-command settings.
 */
registerWorkflowSafeCommands([
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
  description: 'Reads the RFQ PDF and matches its brief against the catalog.',
  metadata: { category: 'RFQ', tags: ['rfq', 'agents', 'property'], icon: 'file-search' },
  steps: [
    { stepId: 'start', stepName: 'Start', stepType: 'START', description: 'RFQ case opened from the inbox' },
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
      stepId: 'analyze_parallel',
      stepName: 'Analyze brief and rendered pages',
      stepType: 'PARALLEL_FORK',
      description: 'Starts catalog matching and room measurements after PDF intake.',
      config: { joinStepId: 'analysis_complete' },
    },
    {
      stepId: 'match_catalog',
      stepName: 'Match the brief to the catalog',
      stepType: 'AUTOMATED',
      description: 'Runs grouped catalog matching over the extracted brief.',
      activities: [
        {
          activityId: 'match_requirements',
          activityName: 'Match requirements',
          activityType: 'UPDATE_ENTITY',
          async: true,
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
      stepId: 'measure_rooms',
      stepName: 'Measure rendered PDF pages',
      stepType: 'AUTOMATED',
      description: 'Runs strict room measurement extraction for every rendered PDF page.',
      activities: [
        {
          activityId: 'measure_rendered_pages',
          activityName: 'Measure rendered pages',
          activityType: 'UPDATE_ENTITY',
          async: true,
          config: {
            commandId: 'rfq_intake.measure-rooms',
            input: {
              tenantId: '{{workflow.tenantId}}',
              organizationId: '{{workflow.organizationId}}',
              workflowInstanceId: '{{workflow.instanceId}}',
              dealId: '{{workflow.dealId}}',
              stepId: 'measure_rooms',
            },
          },
        },
      ],
    },
    {
      stepId: 'analysis_complete',
      stepName: 'Analysis complete',
      stepType: 'PARALLEL_JOIN',
      description: 'Waits for catalog matching and page measurements.',
      config: { forkStepId: 'analyze_parallel' },
    },
    { stepId: 'end', stepName: 'Done', stepType: 'END' },
  ],
  transitions: [
    { transitionId: 't_start', transitionName: 'Start', fromStepId: 'start', toStepId: 'extract_pdf', trigger: 'auto' },
    { transitionId: 't_analyze', transitionName: 'Analyze', fromStepId: 'extract_pdf', toStepId: 'analyze_parallel', trigger: 'auto' },
    { transitionId: 't_match', transitionName: 'Match', fromStepId: 'analyze_parallel', toStepId: 'match_catalog', trigger: 'auto' },
    { transitionId: 't_measure', transitionName: 'Measure', fromStepId: 'analyze_parallel', toStepId: 'measure_rooms', trigger: 'auto' },
    { transitionId: 't_match_complete', transitionName: 'Catalog complete', fromStepId: 'match_catalog', toStepId: 'analysis_complete', trigger: 'auto' },
    { transitionId: 't_measure_complete', transitionName: 'Measurements complete', fromStepId: 'measure_rooms', toStepId: 'analysis_complete', trigger: 'auto' },
    { transitionId: 't_done', transitionName: 'Done', fromStepId: 'analysis_complete', toStepId: 'end', trigger: 'auto' },
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

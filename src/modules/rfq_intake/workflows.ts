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
      description: 'Extracts the PDF brief for catalog matching.',
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
            // The agent's input is EXACTLY this config's `input` — nothing merges the
            // workflow context into it. `invokeAgentConfigSchema` defaults the key to
            // `{}` (`activity-config-schemas.ts:155`), `interpolateActivityConfig` only
            // substitutes tokens, and the value then travels unchanged through the job
            // (`activity-executor.ts:1533`), the worker (`activity-worker-handler.ts:491`),
            // the bridge and `agentRuntime.run` to the runner. So whatever the agent is
            // to receive has to be named right here.
            //
            // `dealId` and `attachmentId` are the business input: one case, one
            // document. `__files` repeats that same id because it is NOT ours to
            // choose — it is the runtime's reserved envelope, and the only thing that
            // stages the file. `extractFileInput` (`runtime/fileInput.ts:37-45`) pulls
            // that key out, `stageAttachments` resolves it under tenant+org scope and
            // writes the bytes into the run sandbox; everything else stays business
            // data. Drop the envelope and the flat id becomes a string the model can
            // read but no file it can open, and `pdf_intake` fails with
            // `invalid_attachment_count` on zero staged files
            // (`property_documents/ai-tools.ts:345`).
            //
            // Strict interpolation, so a start context missing either id fails the
            // step instead of passing the raw token through.
            //
            // `__files` keeps its `attachments: [...]` shape because the envelope
            // schema is `.strict()` (`runtime/fileInput.ts:11-27`): a `{ attachmentId }`
            // directly under `__files` fails `safeParse`, and the failure is SILENT —
            // `extractFileInput` returns `files: null`, the run succeeds and stages
            // nothing. One entry in the array is the "exactly one document" rule.
            //
            // `currency` is a literal: this demo prices in PLN and an unresolved
            // `{{context.currency}}` would fail the step for a value we already know.
            input: {
              dealId: '{{context.dealId}}',
              customerId: '{{context.customerId}}',
              channelId: '{{context.channelId}}',
              currency: 'PLN',
              __files: { attachments: [{ attachmentId: '{{context.attachmentId}}' }] },
            },
            // `pdf_intake` is an artifact agent: it raises no proposal, so there is
            // nothing for a human to dispose of and a threshold of 0 states that
            // plainly. The review gate belongs on the pricing step, not here.
            onResult: { autoApproveThreshold: 0 },
          },
        },
      ],
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
          async: false,
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
    { stepId: 'end', stepName: 'Done', stepType: 'END' },
  ],
  transitions: [
    { transitionId: 't_start', transitionName: 'Start', fromStepId: 'start', toStepId: 'extract_pdf', trigger: 'auto' },
    { transitionId: 't_match', transitionName: 'Match', fromStepId: 'extract_pdf', toStepId: 'match_catalog', trigger: 'auto' },
    { transitionId: 't_done', transitionName: 'Done', fromStepId: 'match_catalog', toStepId: 'end', trigger: 'auto' },
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

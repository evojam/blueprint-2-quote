import { describe, expect, it, jest } from '@jest/globals'

describe('rfq_intake inbox action registry', () => {
  it('wins the create_quote type over the installed sales definition', async () => {
    const registry = await import('@/.mercato/generated/inbox-actions.generated')
    const definition = registry.getInboxAction('create_quote')

    expect(definition).toBeDefined()
    // The registry keeps the LAST definition for a type, and `rfq_intake` is
    // registered after `sales` in modules.ts. Pinning the label is how the test
    // distinguishes ours from the installed one without exporting an identity flag.
    expect(definition?.label).toBe('Save RFQ and start the AI analysis')
    expect(definition?.type).toBe('create_quote')
  })

  it('keeps the RFQ payload acceptable without prices or line items', async () => {
    const registry = await import('@/.mercato/generated/inbox-actions.generated')
    const definition = registry.getInboxAction('create_quote')!

    const parsed = definition.payloadSchema.safeParse({
      customerName: 'Anna Kowalska',
      customerEmail: 'anna@example.com',
      companyName: 'Kowalska Remonty',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('rfq_intake analysis workflow', () => {
  it('chains the three agents and triggers on the module event', async () => {
    const { workflowsConfig } = await import('../workflows')
    const workflow = workflowsConfig.workflows.find((entry) => entry.workflowId === 'rfq_intake.analysis')
    expect(workflow).toBeDefined()

    const definition = workflow!.definition as {
      interpolation?: string
      steps: Array<{ stepId: string; activities?: Array<{ activityType: string; config: Record<string, unknown> }> }>
      triggers?: Array<{ eventPattern: string; config?: { contextMapping?: Array<{ targetKey: string }> } }>
    }

    // Lenient interpolation would hand a command the literal "{{context.dealId}}".
    expect(definition.interpolation).toBe('strict')

    const activities = definition.steps.flatMap((step) => step.activities ?? [])
    expect(activities.map((activity) => activity.activityType)).toEqual([
      'INVOKE_AGENT',
      'UPDATE_ENTITY',
      'UPDATE_ENTITY',
    ])
    expect(activities[0].config.agentId).toBe('property_documents.pdf_intake')
    expect(activities[1].config.commandId).toBe('rfq_intake.plans.analyze')
    expect(activities[2].config.commandId).toBe('rfq_intake.requirements.match')

    const trigger = definition.triggers?.[0]
    expect(trigger?.eventPattern).toBe('rfq_intake.rfq.created')
    // Without `__files` in the mapping the agent gets no document to read.
    expect(trigger?.config?.contextMapping?.map((entry) => entry.targetKey)).toEqual(
      expect.arrayContaining(['dealId', '__files']),
    )
  })

  it('survives the same validation registerCodeWorkflows applies', async () => {
    const { workflowDefinitionDataSchema } = await import('@open-mercato/core/modules/workflows/data/validators')
    const { workflowsConfig } = await import('../workflows')
    const workflow = workflowsConfig.workflows.find((entry) => entry.workflowId === 'rfq_intake.analysis')!

    // registerCodeWorkflows DROPS a definition that fails this schema, silently
    // except for a log line — so an INVOKE_AGENT activity that the shared
    // `ActivityType` union does not know must still pass here.
    const result = workflowDefinitionDataSchema.safeParse(workflow.definition)
    expect(result.success).toBe(true)
  })
})

describe('rfq_intake start-rfq-analysis subscriber', () => {
  it('only routes RFQ cases, not real quotes', async () => {
    const { isRfqActionExecuted } = await import('../subscribers/start-rfq-analysis')

    expect(
      isRfqActionExecuted({
        actionType: 'create_quote',
        createdEntityType: 'customer_deal',
        createdEntityId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBe(true)

    // A quote created by some other proposal carries the same action type.
    expect(
      isRfqActionExecuted({
        actionType: 'create_quote',
        createdEntityType: 'sales_quote',
        createdEntityId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBe(false)

    expect(
      isRfqActionExecuted({
        actionType: 'create_contact',
        createdEntityType: 'customer_deal',
        createdEntityId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBe(false)
  })
})

describe('installed demo workflows', () => {
  it('are filtered out of the code workflow registration', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(require.resolve('../../../bootstrap-common.ts'), 'utf8'),
    )
    for (const id of ['workflows.simple-approval', 'workflows.checkout-demo', 'sales.order-approval']) {
      expect(source).toContain(id)
    }
    expect(source).toContain('DISABLED_CODE_WORKFLOW_IDS')
  })
})

jest.mock('@open-mercato/shared/lib/logger', () => ({
  createLogger: () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }),
}))

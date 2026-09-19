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

  // Verbatim from the demo environment (proposal fa3ec747, sonnet via litellm): the
  // model answered with a shape of its own invention, so `customerName` was undefined
  // and the action failed with "expected string, received undefined" while every fact
  // the enquiry carried was dropped on the floor.
  const DRIFTED_PAYLOAD = {
    notes: 'Brak dopasowanych pozycji w katalogu - wymagana ręczna kalkulacja kosztorysu.',
    scope: ['gładzie na ścianach i sufitach', 'malowanie farbą lateksową'],
    floors: 3,
    area_m2: 240,
    customer: { name: 'Marek Grochala', email: 'marek@evojam.com' },
    location: 'Warszawa, Wawer',
    channelId: 'bf0e0385-08f9-4f31-84a1-d65cccb0dbc0',
    customerEntityId: 'e4157956-f136-4ebd-8f6a-a908dfd4829c',
    ceiling_height_cm: '275-295',
  }

  it('lifts the contact out of the shape the model actually emits', async () => {
    const registry = await import('@/.mercato/generated/inbox-actions.generated')
    const definition = registry.getInboxAction('create_quote')!

    const normalized = await definition.normalizePayload!({ ...DRIFTED_PAYLOAD }, {} as never)

    expect(normalized.customerName).toBe('Marek Grochala')
    expect(normalized.customerEmail).toBe('marek@evojam.com')
    expect(definition.payloadSchema.safeParse(normalized).success).toBe(true)
  })

  it('keeps the enquiry facts in notes instead of dropping them', async () => {
    const registry = await import('@/.mercato/generated/inbox-actions.generated')
    const definition = registry.getInboxAction('create_quote')!

    const normalized = await definition.normalizePayload!({ ...DRIFTED_PAYLOAD }, {} as never)
    const notes = String(normalized.notes)

    expect(notes).toContain('Brak dopasowanych pozycji w katalogu')
    expect(notes).toContain('gładzie na ścianach i sufitach')
    expect(notes).toContain('Warszawa, Wawer')
    expect(notes).toContain('240 m2')
    expect(notes).toContain('275-295')
    expect(normalized.customer).toBeUndefined()
  })

  // Second live run (proposal 73f041c8), after the promptSchema fix. The contact is
  // flat now — the prompt did its job — but the model still invents keys, and it spelled
  // the ceiling height a THIRD way: `ceiling_height_cm`, then `ceilingHeightCm`, now
  // `ceilingHeight_cm`. Enumerating spellings loses this race; matching on letters and
  // digits alone does not.
  it('folds a fact in whatever spelling the model reaches for', async () => {
    const registry = await import('@/.mercato/generated/inbox-actions.generated')
    const definition = registry.getInboxAction('create_quote')!

    const normalized = await definition.normalizePayload!({
      notes: 'Wycena orientacyjna.',
      scope: ['Wykonanie gładzi na ścianach i sufitach', 'Malowanie ścian i sufitów'],
      floors: 3,
      area_m2: 240,
      location: 'Warszawa, Wawer',
      customerName: 'Artur Bańkowski',
      customerEmail: 'artur@evojam.com',
      ceilingHeight_cm: '275-295',
    }, {} as never)

    const notes = String(normalized.notes)
    expect(notes).toContain('275-295')
    expect(notes).toContain('240 m2')
    expect(notes).toContain('Warszawa, Wawer')
    // The stray key must not survive into the stored payload either.
    expect(normalized.ceilingHeight_cm).toBeUndefined()
    expect(definition.payloadSchema.safeParse(normalized).success).toBe(true)
  })

  it('never reconsiders a contact that already arrived on the canonical key', async () => {
    const registry = await import('@/.mercato/generated/inbox-actions.generated')
    const definition = registry.getInboxAction('create_quote')!

    // A decoy under a looser alias must not win over the real value.
    const normalized = await definition.normalizePayload!({
      customerName: 'Artur Bańkowski',
      customerEmail: 'artur@evojam.com',
      name: 'Rzuty inwentaryzacyjne',
      email: 'noreply@example.com',
    }, {} as never)

    expect(normalized.customerName).toBe('Artur Bańkowski')
    expect(normalized.customerEmail).toBe('artur@evojam.com')
  })

  it('finds the contact under a snake spelling of the canonical key', async () => {
    const registry = await import('@/.mercato/generated/inbox-actions.generated')
    const definition = registry.getInboxAction('create_quote')!

    const normalized = await definition.normalizePayload!({
      customer_name: 'Artur Bańkowski',
      customer_email: 'artur@evojam.com',
    }, {} as never)

    expect(normalized.customerName).toBe('Artur Bańkowski')
    expect(normalized.customerEmail).toBe('artur@evojam.com')
  })

  it('reaches the model with a schema of its own, not the filtered placeholder', async () => {
    const registry = await import('@/.mercato/generated/inbox-actions.generated')
    const definition = registry.getInboxAction('create_quote')!

    // `extractionPrompt.ts:27` drops this exact string, which is how create_quote
    // ended up in the prompt with no field list at all.
    expect(definition.promptSchema).not.toBe('(shared with create_order)')
    expect(definition.promptSchema).toContain('customerName')
  })
})

describe('rfq_intake analysis workflow', () => {
  it('walks the funnel around the measure-then-match chain and declares no trigger of its own', async () => {
    const { workflowsConfig } = await import('../workflows')
    const workflow = workflowsConfig.workflows.find((entry) => entry.workflowId === 'rfq_intake.analysis')
    expect(workflow).toBeDefined()

    const definition = workflow!.definition as {
      interpolation?: string
      steps: Array<{
        stepId: string
        stepType: string
        activities?: Array<{ activityType: string; async?: boolean; config: Record<string, unknown> }>
      }>
      transitions: Array<{ fromStepId: string; toStepId: string }>
      triggers?: Array<{ eventPattern: string; config?: { contextMapping?: Array<{ targetKey: string }> } }>
    }

    expect(definition.interpolation).toBe('strict')
    expect(definition.steps.map((step) => step.stepId)).toEqual([
      'start', 'mark_quoting', 'extract_pdf', 'measure_rooms', 'match_catalog', 'draft_quote', 'mark_review', 'end',
    ])
    expect(definition.steps.map((step) => step.stepType)).toEqual([
      'START', 'AUTOMATED', 'AUTOMATED', 'AUTOMATED', 'AUTOMATED', 'AUTOMATED', 'AUTOMATED', 'END',
    ])

    const activities = definition.steps.flatMap((step) => step.activities ?? [])
    expect(activities.map((activity) => activity.activityType)).toEqual([
      'UPDATE_ENTITY', 'INVOKE_AGENT', 'UPDATE_ENTITY', 'UPDATE_ENTITY', 'INVOKE_AGENT', 'UPDATE_ENTITY',
    ])
    expect(activities.every((activity) => activity.async !== true)).toBe(true)
    // The funnel move runs FIRST and on `{{context.dealId}}`: an operator has to see a
    // case leave `Nowe zgloszenie` the moment the engine picks it up, and the deal id
    // only reaches the graph through the process input.
    expect(activities[0]!.config).toEqual({
      commandId: 'rfq_intake.deal.advance',
      input: {
        tenantId: '{{workflow.tenantId}}',
        organizationId: '{{workflow.organizationId}}',
        dealId: '{{context.dealId}}',
        stage: 'quoting',
      },
    })
    expect(activities[1]!.config).toMatchObject({
      agentId: 'property_documents.pdf_intake',
      input: {
        __files: '{{context.__files}}',
      },
    })
    expect(activities[2]).toMatchObject({
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
    })
    expect(activities[3]).toMatchObject({
      config: {
        commandId: 'rfq_intake.requirements.match',
        input: {
          tenantId: '{{workflow.tenantId}}',
          organizationId: '{{workflow.organizationId}}',
          workflowInstanceId: '{{workflow.instanceId}}',
          stepId: 'match_catalog',
        },
      },
    })
    expect(activities[4]).toMatchObject({
      config: {
        agentId: 'rfq_intake.quote_drafter',
        input: { dealId: '{{context.dealId}}', workflowInstanceId: '{{workflow.instanceId}}' },
        onResult: { autoApproveThreshold: 0 },
      },
    })
    // The closing move, to `Do sprawdzenia`. Both funnel activities go through the same
    // command with a different `stage`, so the pair is asserted together.
    expect(activities[5]!.config).toEqual({
      commandId: 'rfq_intake.deal.advance',
      input: {
        tenantId: '{{workflow.tenantId}}',
        organizationId: '{{workflow.organizationId}}',
        dealId: '{{context.dealId}}',
        stage: 'review',
      },
    })
    expect(JSON.stringify(definition)).not.toContain('rfq_intake.plans.analyze')
    expect(definition.transitions).toEqual([
      { transitionId: 't_start', transitionName: 'Start', fromStepId: 'start', toStepId: 'mark_quoting', trigger: 'auto' },
      { transitionId: 't_extract', transitionName: 'Extract', fromStepId: 'mark_quoting', toStepId: 'extract_pdf', trigger: 'auto' },
      { transitionId: 't_measure', transitionName: 'Measure', fromStepId: 'extract_pdf', toStepId: 'measure_rooms', trigger: 'auto' },
      { transitionId: 't_match', transitionName: 'Match', fromStepId: 'measure_rooms', toStepId: 'match_catalog', trigger: 'auto' },
      { transitionId: 't_quote', transitionName: 'Draft quote', fromStepId: 'match_catalog', toStepId: 'draft_quote', trigger: 'auto' },
      { transitionId: 't_review', transitionName: 'Review', fromStepId: 'draft_quote', toStepId: 'mark_review', trigger: 'auto' },
      { transitionId: 't_done', transitionName: 'Done', fromStepId: 'mark_review', toStepId: 'end', trigger: 'auto' },
    ])
    expect(definition.triggers ?? []).toEqual([])
  })

  it('survives the same validation registerCodeWorkflows applies', async () => {
    const { workflowDefinitionDataSchema } = await import('@open-mercato/core/modules/workflows/data/validators')
    const { workflowsConfig } = await import('../workflows')
    const workflow = workflowsConfig.workflows.find((entry) => entry.workflowId === 'rfq_intake.analysis')!

    expect(workflowDefinitionDataSchema.safeParse(workflow.definition).success).toBe(true)
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

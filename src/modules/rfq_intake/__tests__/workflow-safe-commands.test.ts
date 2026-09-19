import { describe, expect, it } from '@jest/globals'

import { listWorkflowSafeCommands } from '@open-mercato/core/modules/workflows/lib/workflow-safe-commands'

import '../workflows'

/**
 * Gate 1 of the five the spec names. The Agent Orchestrator builds an agent's action
 * vocabulary from `listWorkflowSafeCommands() ∪ activityTypes()`, so a command missing
 * from this list is not an error at the call site — every proposed action carrying it
 * comes back `skipped`. A silent skip is exactly the failure that is hard to see, which
 * is why it gets a test rather than a code comment.
 */
describe('rfq_intake workflow-safe command declarations', () => {
  it('declares the quote command, because the agent vocabulary is built from that list', () => {
    const entry = listWorkflowSafeCommands().find((e) => e.commandId === 'rfq_intake.quote.create')

    expect(entry).toBeDefined()
    expect(entry?.requiredFeatures).toEqual(['customers.deals.manage', 'sales.quotes.manage'])
  })

  it('keeps the existing matcher declaration, so adding one never narrows the list', () => {
    const ids = listWorkflowSafeCommands().map((e) => e.commandId)

    expect(ids).toEqual(expect.arrayContaining(['rfq_intake.requirements.match']))
  })

  it('leaves every rfq_intake entry opt-in, so a tenant enables them deliberately', () => {
    const rfqEntries = listWorkflowSafeCommands().filter((e) => e.commandId.startsWith('rfq_intake.'))

    expect(rfqEntries).toHaveLength(3)
    // Upstream discourages grandfathering new commands: `defaultEnabled` is reserved
    // for commands that predate the tenant setting. Nothing here runs until a tenant
    // switches it on once — that is gate 2, and it fails as a silent skip.
    for (const entry of rfqEntries) {
      expect(entry.defaultEnabled ?? false).toBe(false)
    }
  })
})

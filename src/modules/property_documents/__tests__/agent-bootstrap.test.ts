import { describe, expect, it } from '@jest/globals'
import '../../../modules'
import '../di'
import { ensureAgentsLoaded, getAgentEntry } from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'

describe('property document file-agent bootstrap', () => {
  it('loads file-plane options into the runtime registry', async () => {
    await ensureAgentsLoaded()
    expect(getAgentEntry('property_documents.pdf_text_reader')?.files).toEqual({
      enabled: true,
      inputs: true,
      outputs: false,
      bash: false,
    })
    expect(getAgentEntry('property_documents.pdf_text_reader')?.sourceFiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'AGENT.md' })]),
    )
  })
})

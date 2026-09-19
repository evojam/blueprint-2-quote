import { describe, expect, it, jest } from '@jest/globals'

jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/lib/agent-registry', () => ({
  getAgent: jest.fn(() => undefined),
}))
import {
  ensureAgentsLoaded,
  getAgentEntry,
} from '@open-mercato/enterprise/modules/agent_orchestrator/lib/sdk/defineAgent'
import {
  CATALOG_MATCHER_AGENT_ID,
  catalogMatcherResultSchema,
} from '../ai-agents'
import '../ai-agents'

const match = {
  catalogProductId: '11111111-1111-4111-8111-111111111111',
  title: 'Projekt instalacji elektrycznej',
  score: 0.91,
  matchedEvidence: ['projekt instalacji', 'rozliczenie za m²'],
  reason: 'Zgodność rodzaju projektu i jednostki rozliczeniowej.',
}

const envelope = {
  kind: 'research' as const,
  data: {
    matches: [match],
    unmatchedTerms: ['120 m²'],
  },
}

describe('property_documents.catalog_matcher', () => {
  it('registers one bounded native read-only matcher', async () => {
    await ensureAgentsLoaded()

    const entry = getAgentEntry(CATALOG_MATCHER_AGENT_ID)
    expect(entry).toMatchObject({
      id: CATALOG_MATCHER_AGENT_ID,
      moduleId: 'property_documents',
      runtime: 'native',
      resultKind: 'research',
      agentType: 'researcher',
      loop: { maxSteps: 4 },
      sampleInput: {
        text: 'Wykonanie projektu instalacji elektrycznej dla lokalu 120 m²',
        limit: 5,
      },
    })
    expect(entry?.tools).toEqual([
      'catalog.search_products',
      'catalog.get_product_bundle',
    ])
    expect(entry?.files).toBeUndefined()
    expect(entry?.skills).toEqual([])
    expect(entry?.subAgents).toEqual([])
  })

  it('accepts only strict grounded score-ordered matcher results', () => {
    expect(catalogMatcherResultSchema.safeParse(envelope).success).toBe(true)

    for (const invalid of [
      { ...envelope, extra: true },
      { kind: 'research', data: { ...envelope.data, extra: true } },
      {
        ...envelope,
        data: { ...envelope.data, matches: [{ ...match, score: 0.59 }] },
      },
      {
        ...envelope,
        data: { ...envelope.data, matches: [{ ...match, matchedEvidence: [] }] },
      },
      {
        ...envelope,
        data: { ...envelope.data, matches: [match, { ...match, score: 0.8 }] },
      },
      {
        ...envelope,
        data: {
          ...envelope.data,
          matches: [
            { ...match, score: 0.8 },
            {
              ...match,
              catalogProductId: '22222222-2222-4222-8222-222222222222',
              score: 0.9,
            },
          ],
        },
      },
    ]) {
      expect(catalogMatcherResultSchema.safeParse(invalid).success).toBe(false)
    }
  })
})

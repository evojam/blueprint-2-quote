import { afterEach, describe, expect, it, jest } from '@jest/globals'
import type { LlmProvider } from '@open-mercato/shared/lib/ai/llm-provider'

const mockChat = jest.fn((modelId: string) => ({
  modelId,
  provider: 'openai.chat',
}))
const mockResponses = jest.fn((modelId: string) => ({
  modelId,
  provider: 'openai.responses',
}))
const mockOpenAI = Object.assign(
  jest.fn((modelId: string) => ({
    modelId,
    provider: 'openai.default',
  })),
  { chat: mockChat, responses: mockResponses },
)
const mockCreateOpenAI = jest.fn((options: unknown) => {
  void options
  return mockOpenAI
})

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: mockCreateOpenAI,
}))
const mockLlmProviderRegistry = {
  get: jest.fn(),
  register: jest.fn(),
}

jest.mock(
  '@open-mercato/ai-assistant/modules/ai_assistant/lib/llm-registry',
  () => ({ llmProviderRegistry: mockLlmProviderRegistry }),
)

import { createLiteLlmChatProvider } from '../litellm-provider'
const originalLiteLlmBaseUrl = process.env.LITELLM_BASE_URL

afterEach(() => {
  jest.clearAllMocks()
  if (originalLiteLlmBaseUrl === undefined) {
    delete process.env.LITELLM_BASE_URL
  } else {
    process.env.LITELLM_BASE_URL = originalLiteLlmBaseUrl
  }
})


describe('LiteLLM chat compatibility provider', () => {
  it('creates a Chat Completions model for tool-capable runs', () => {
    const baseProvider: LlmProvider = {
      id: 'litellm',
      name: 'LiteLLM',
      envKeys: ['LITELLM_API_KEY'],
      defaultModel: 'gpt-4o-mini',
      defaultModels: [],
      usesVendorPrefixedModelIds: true,
      isConfigured: () => true,
      resolveApiKey: () => 'test-key',
      getConfiguredEnvKey: () => 'LITELLM_API_KEY',
      createModel: () => ({ provider: 'openai.responses' }),
    }
    const provider = createLiteLlmChatProvider(baseProvider)
    const model = provider.createModel({
      apiKey: 'test-key',
      modelId: 'claude-opus-4-7',
      baseURL: 'https://gateway.example/v1',
    }) as { modelId: string; provider: string }

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://gateway.example/v1',
    })
    expect(mockChat).toHaveBeenCalledWith('claude-opus-4-7')

    expect(model).toMatchObject({
      modelId: 'claude-opus-4-7',
      provider: 'openai.chat',
    })
  })

  it('uses Responses for GPT Sol tool calls', () => {
    const baseProvider: LlmProvider = {
      id: 'litellm',
      name: 'LiteLLM',
      envKeys: ['LITELLM_API_KEY'],
      defaultModel: 'gpt-4o-mini',
      defaultModels: [],
      usesVendorPrefixedModelIds: true,
      isConfigured: () => true,
      resolveApiKey: () => 'test-key',
      getConfiguredEnvKey: () => 'LITELLM_API_KEY',
      createModel: () => ({ provider: 'openai.responses' }),
    }

    const model = createLiteLlmChatProvider(baseProvider).createModel({
      apiKey: 'test-key',
      modelId: 'gpt-5.6-sol',
      baseURL: 'https://gateway.example/v1',
    }) as { modelId: string; provider: string }

    expect(mockResponses).toHaveBeenCalledWith('gpt-5.6-sol')
    expect(mockChat).not.toHaveBeenCalled()
    expect(model).toMatchObject({ modelId: 'gpt-5.6-sol', provider: 'openai.responses' })
  })

  it('uses the LiteLLM default URL when the environment value is blank', () => {
    process.env.LITELLM_BASE_URL = '   '
    const baseProvider: LlmProvider = {
      id: 'litellm',
      name: 'LiteLLM',
      envKeys: ['LITELLM_API_KEY'],
      defaultModel: 'gpt-4o-mini',
      defaultModels: [],
      isConfigured: () => true,
      resolveApiKey: () => 'test-key',
      getConfiguredEnvKey: () => 'LITELLM_API_KEY',
      createModel: () => ({ provider: 'openai.responses' }),
    }

    createLiteLlmChatProvider(baseProvider).createModel({
      apiKey: 'test-key',
      modelId: 'claude-opus-4-7',
    })

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'http://localhost:4000/v1',
    })
  })
})

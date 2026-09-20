import { createOpenAI } from '@ai-sdk/openai'
import { llmProviderRegistry } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/llm-registry'
import type {
  LlmCreateModelOptions,
  LlmProvider,
} from '@open-mercato/shared/lib/ai/llm-provider'

const LITELLM_PROVIDER_ID = 'litellm'
const DEFAULT_LITELLM_BASE_URL = 'http://localhost:4000/v1'

function resolveBaseURL(options: LlmCreateModelOptions): string {
  if (options.baseURL !== undefined) return options.baseURL
  const configuredBaseURL = process.env.LITELLM_BASE_URL?.trim()
  return configuredBaseURL || DEFAULT_LITELLM_BASE_URL
}
export function createLiteLlmChatProvider(baseProvider: LlmProvider): LlmProvider {
  if (baseProvider.id !== LITELLM_PROVIDER_ID) {
    throw new Error(`[property_documents] expected provider "${LITELLM_PROVIDER_ID}"`)
  }

  return {
    ...baseProvider,
    createModel(options: LlmCreateModelOptions): unknown {
      const openai = createOpenAI({
        apiKey: options.apiKey,
        baseURL: resolveBaseURL(options),
      })
      return options.modelId === 'gpt-5.6-sol'
        ? openai.responses(options.modelId)
        : openai.chat(options.modelId)
    },
  }
}

export function registerLiteLlmChatProvider(): void {
  const baseProvider = llmProviderRegistry.get(LITELLM_PROVIDER_ID)
  if (!baseProvider) {
    throw new Error('[property_documents] built-in LiteLLM provider is not registered')
  }

  // HACK(hackathon): Open Mercato 0.8 uses Responses for LiteLLM, but this
  // gateway emits incompatible tool-call objects there. Chat Completions works;
  // without this override every native tool-calling agent fails before execution.
  llmProviderRegistry.register(createLiteLlmChatProvider(baseProvider))
}

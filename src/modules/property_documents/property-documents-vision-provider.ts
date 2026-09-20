import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV4 } from '@ai-sdk/provider'

export type PropertyDocumentsVisionModel = LanguageModelV4

export function resolvePropertyDocumentsVisionModel(): PropertyDocumentsVisionModel {
  // HACK(hackathon): the generated standalone DI sidecar does not inherit the
  // dev runner's .env values. Parse an existing local env file as a fallback
  // without mutating process-wide settings; deployed runtimes without one
  // still require process credentials.
  const processApiKey = process.env.OPENAI_API_KEY?.trim()
  const processBaseURL = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1'
  let apiKey = processApiKey
  let baseURL = processApiKey ? processBaseURL : undefined
  let fileModel: string | undefined
  if (!apiKey || !baseURL) {
    const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const envRoots = [process.cwd(), process.env.INIT_CWD, process.env.PWD, moduleRoot]
    for (const root of envRoots) {
      if (!root) continue
      const envPath = path.resolve(root, '.env')
      if (!existsSync(envPath)) continue
      const fileEnv = parseEnv(readFileSync(envPath, 'utf8'))
      const fileApiKey = fileEnv.OPENAI_API_KEY?.trim()
      const fileBaseURL = fileEnv.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1'
      if (!fileApiKey) continue
      apiKey = fileApiKey
      baseURL = fileBaseURL
      fileModel =
        fileEnv.OM_AI_PROPERTY_DOCUMENTS_VISION_MODEL?.trim() ||
        fileEnv.OM_AI_PROPERTY_DOCUMENTS_MODEL?.trim() ||
        fileEnv.OM_AI_MODEL?.trim()
      break
    }
  }
  if (!apiKey || !baseURL) {
    throw new Error('Room dimension vision requires configured OpenAI credentials')
  }
  const modelId =
    process.env.OM_AI_PROPERTY_DOCUMENTS_VISION_MODEL?.trim() ||
    fileModel ||
    process.env.OM_AI_PROPERTY_DOCUMENTS_MODEL?.trim() ||
    process.env.OM_AI_MODEL?.trim() ||
    'gpt-5.6-sol'
  return createOpenAI({ apiKey, baseURL })(modelId)
}

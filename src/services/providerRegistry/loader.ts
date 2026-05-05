import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { logError } from '../../utils/log.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { ProvidersFileSchema, type ProviderConfig } from './types.js'

/**
 * The four built-in OpenAI-compat providers.
 *
 * These are used when providers.json is absent or contains no entries.
 * User-defined providers in ~/.claude/providers.json are merged on top
 * (they replace a built-in with the same id).
 */
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'cerebras',
    kind: 'openai-compat',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    defaultModel: 'llama-3.3-70b',
    compatRule: 'cerebras',
  },
  {
    id: 'groq',
    kind: 'openai-compat',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    compatRule: 'groq',
  },
  {
    id: 'qwen',
    kind: 'openai-compat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-max',
    compatRule: 'strict-openai',
  },
  {
    id: 'deepseek',
    kind: 'openai-compat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    compatRule: 'deepseek',
  },
]

/**
 * Returns the path to the providers.json file in the Claude config directory.
 */
export function getProvidersFilePath(): string {
  return join(getClaudeConfigHomeDir(), 'providers.json')
}

/**
 * Load provider configurations.
 *
 * Strategy:
 * 1. Start with DEFAULT_PROVIDERS.
 * 2. If ~/.claude/providers.json exists, parse and validate it with Zod.
 *    - Valid entries replace defaults with matching id; new ids are appended.
 *    - Corrupt/invalid file: log warning, return defaults only.
 * 3. Empty providers.json: return defaults.
 *
 * This function never throws — corrupt files produce a warning + fallback.
 */
export function loadProviders(): ProviderConfig[] {
  const filePath = getProvidersFilePath()

  if (!existsSync(filePath)) {
    return [...DEFAULT_PROVIDERS]
  }

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err: unknown) {
    logError(
      new Error(
        `loadProviders: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
    return [...DEFAULT_PROVIDERS]
  }

  // Empty file → return defaults
  if (!raw.trim()) {
    return [...DEFAULT_PROVIDERS]
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logError(
      new Error(
        `loadProviders: ${filePath} is not valid JSON. Using default providers.`,
      ),
    )
    return [...DEFAULT_PROVIDERS]
  }

  const result = ProvidersFileSchema.safeParse(parsed)
  if (!result.success) {
    logError(
      new Error(
        `loadProviders: ${filePath} failed schema validation: ${result.error.message}. Using default providers.`,
      ),
    )
    return [...DEFAULT_PROVIDERS]
  }

  if (result.data.length === 0) {
    return [...DEFAULT_PROVIDERS]
  }

  // Merge: user entries override defaults with same id; new ids are appended.
  const merged = new Map<string, ProviderConfig>()
  for (const p of DEFAULT_PROVIDERS) {
    merged.set(p.id, p)
  }
  for (const p of result.data) {
    merged.set(p.id, p)
  }

  return Array.from(merged.values())
}

/**
 * Find a provider by id in the loaded list. Returns undefined if not found.
 */
export function findProvider(
  id: string,
  providers?: ProviderConfig[],
): ProviderConfig | undefined {
  return (providers ?? loadProviders()).find((p) => p.id === id)
}

/**
 * Write additional providers to ~/.claude/providers.json.
 *
 * Only writes providers that are NOT already in DEFAULT_PROVIDERS (or the
 * existing file). If a provider with the same id exists, it is replaced.
 *
 * Returns the final merged list that was written.
 */
export function saveProviders(providers: ProviderConfig[]): ProviderConfig[] {
  const filePath = getProvidersFilePath()
  const { writeFileSync } = require('fs') as typeof import('fs')

  // Build merged list (providers override defaults by id)
  const merged = new Map<string, ProviderConfig>()
  for (const p of DEFAULT_PROVIDERS) {
    merged.set(p.id, p)
  }
  for (const p of providers) {
    merged.set(p.id, p)
  }

  // Only persist non-default providers (defaults are always built in)
  const toWrite: ProviderConfig[] = []
  for (const [id, p] of merged) {
    const isDefault = DEFAULT_PROVIDERS.some((d) => d.id === id)
    if (!isDefault) {
      toWrite.push(p)
    } else {
      // If user overrode a default, persist the override
      const defaultEntry = DEFAULT_PROVIDERS.find((d) => d.id === id)
      if (defaultEntry && JSON.stringify(defaultEntry) !== JSON.stringify(p)) {
        toWrite.push(p)
      }
    }
  }

  writeFileSync(filePath, JSON.stringify(toWrite, null, 2), 'utf-8')
  return Array.from(merged.values())
}

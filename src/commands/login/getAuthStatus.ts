/**
 * getAuthStatus — pure function; no network calls.
 *
 * Reads process.env + the local OAuth credential file (via the already-memoized
 * getClaudeAIOAuthTokens()) to produce an AuthStatus snapshot used by
 * AuthPlaneSummary for the /login UI.
 *
 * Security contract:
 *   - ANTHROPIC_API_KEY value is NEVER returned raw; only a masked preview is exposed.
 *   - Third-party API key values are NEVER included; only boolean presence flags.
 */

import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { loadProviders } from '../../services/providerRegistry/loader.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuthStatus {
  subscription: {
    /** true when a claude.ai OAuth token is present in local storage */
    active: boolean
    /** subscription tier, or null when not logged in / API-key-only mode */
    plan: 'free' | 'pro' | 'max' | 'team' | 'enterprise' | 'unknown' | null
    /** reserved — always null for security (email not included in masked output) */
    accountEmail: null
  }
  workspaceKey: {
    /** true when ANTHROPIC_API_KEY env var is non-empty */
    set: boolean
    /** true when key begins with the expected 'sk-ant-api03-' prefix */
    prefixValid: boolean
    /**
     * Masked preview of the key, e.g. 'sk-a...67 (48 chars)', or null when unset.
     * NEVER contains the raw key value.
     */
    keyPreview: string | null
  }
  thirdParty: Array<{
    /** Provider id from the registry (e.g. 'cerebras', 'groq') */
    id: string
    /** Human-readable display name */
    name: string
    /** Name of the env var that holds the API key */
    apiKeyEnv: string
    /** true when the env var is set to a non-empty value */
    apiKeySet: boolean
    /**
     * true when CLAUDE_CODE_USE_OPENAI=1 AND OPENAI_BASE_URL matches this
     * provider's baseUrl — meaning it is the currently active OpenAI-compat route.
     */
    isActive: boolean
  }>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE_KEY_PREFIX = 'sk-ant-api03-'

/** Map display name overrides for well-known provider ids */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  cerebras: 'Cerebras',
  groq: 'Groq',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produce a masked preview of an API key value.
 * Format: first4 + '...' + last2 + ' (N chars)'
 * e.g.: 'sk-a...67 (48 chars)'
 *
 * E3 fix: keys shorter than 20 chars expose a high % of entropy per char
 * (e.g. 6/14 = 43% exposed). For short/malformed keys, show [redacted] only.
 *
 * Never returns the raw key value.
 */
function maskApiKey(key: string): string {
  const len = key.length
  // E3: short keys — show only length, no prefix
  if (len < 20) return `[redacted] (${len} chars)`
  const first4 = key.slice(0, 4)
  const last2 = key.slice(-2)
  return `${first4}...${last2} (${len} chars)`
}

/** Normalise provider id to a human-readable name */
function displayName(id: string): string {
  return PROVIDER_DISPLAY_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns a snapshot of the current auth state by reading:
 *   - process.env.ANTHROPIC_API_KEY (workspace key)
 *   - getClaudeAIOAuthTokens() from the local credential file (subscription OAuth)
 *   - loadProviders() for the third-party provider list
 *   - process.env.CLAUDE_CODE_USE_OPENAI + OPENAI_BASE_URL for active provider
 *
 * This function never throws and never makes network calls.
 */
export function getAuthStatus(): AuthStatus {
  // ---- 1. Subscription OAuth plane ----
  const oauthTokens = getClaudeAIOAuthTokens()
  const subscriptionActive =
    oauthTokens !== null && Boolean(oauthTokens.accessToken)

  let plan: AuthStatus['subscription']['plan'] = null
  if (subscriptionActive && oauthTokens) {
    const raw = oauthTokens.subscriptionType
    if (
      raw === 'free' ||
      raw === 'pro' ||
      raw === 'max' ||
      raw === 'team' ||
      raw === 'enterprise'
    ) {
      plan = raw
    } else if (raw !== null && raw !== undefined) {
      plan = 'unknown'
    } else {
      plan = null
    }
  }

  // ---- 2. Workspace API key plane ----
  const rawKey = process.env.ANTHROPIC_API_KEY ?? ''
  const keySet = rawKey.length > 0
  const prefixValid = rawKey.startsWith(WORKSPACE_KEY_PREFIX)
  const keyPreview = keySet ? maskApiKey(rawKey) : null

  // ---- 3. Third-party providers ----
  const providers = loadProviders()
  const useOpenAI = process.env.CLAUDE_CODE_USE_OPENAI === '1'
  const openAIBaseUrl = (process.env.OPENAI_BASE_URL ?? '').trim()

  const thirdParty: AuthStatus['thirdParty'] = providers.map(p => {
    const apiKeySet = Boolean(process.env[p.apiKeyEnv]?.trim())
    const isActive =
      useOpenAI && openAIBaseUrl !== '' && p.baseUrl === openAIBaseUrl
    return {
      id: p.id,
      name: displayName(p.id),
      apiKeyEnv: p.apiKeyEnv,
      apiKeySet,
      isActive,
    }
  })

  return {
    subscription: {
      active: subscriptionActive,
      plan,
      accountEmail: null,
    },
    workspaceKey: {
      set: keySet,
      prefixValid,
      keyPreview,
    },
    thirdParty,
  }
}

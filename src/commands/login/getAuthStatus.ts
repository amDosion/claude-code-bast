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
}

// thirdParty was removed 2026-05-06: fork's existing /login → "Anthropic
// Compatible Setup" form is the single source of truth for OpenAI-compat
// configuration. The summary intentionally only shows Anthropic-side planes
// (subscription / workspace key) which the fork form does not surface.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE_KEY_PREFIX = 'sk-ant-api03-'

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

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns a snapshot of the current auth state by reading:
 *   - process.env.ANTHROPIC_API_KEY (workspace key)
 *   - getClaudeAIOAuthTokens() from the local credential file (subscription OAuth)
 *
 * Third-party provider config (Cerebras / Groq / Qwen / DeepSeek) is owned by
 * fork's existing /login → "Anthropic Compatible Setup" form; the parallel
 * surface here was removed 2026-05-06.
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
  }
}

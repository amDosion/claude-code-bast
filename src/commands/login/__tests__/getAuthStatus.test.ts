/**
 * Tests for getAuthStatus.ts
 * Covers subscription set/unset, workspace API key prefix variants, and third-party provider env vars.
 * All tests are pure (no network calls) — only process.env + mocked OAuth file reads.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

// Mock side-effect modules before importing subject
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/settings/settings.js', () => ({
  getCachedOrDefaultSettings: () => ({}),
  getSettings: () => ({}),
}))
mock.module('src/utils/config.ts', () => ({
  isConfigEnabled: () => true,
}))

// We mock auth.ts getClaudeAIOAuthTokens to return controlled values
// per test — we mock getClaudeAIOAuthTokens from within the test using spies
// on process.env, no network calls happen.

const SUBSCRIPTION_TOKEN_FIXTURE = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference', 'claude.ai'],
  subscriptionType: 'pro',
  rateLimitTier: null,
}

// We'll import getAuthStatus lazily after setting up mocks
describe('getAuthStatus', () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    // Reset env to clean state before each test
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CEREBRAS_API_KEY
    delete process.env.GROQ_API_KEY
    delete process.env.DASHSCOPE_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_BASE_URL
  })

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) {
        delete process.env[key]
      }
    }
    for (const [k, v] of Object.entries(origEnv)) {
      if (v !== undefined) {
        process.env[k] = v
      }
    }
  })

  test('subscription.active=false when no OAuth tokens present', async () => {
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.subscription.active).toBe(false)
    expect(status.subscription.plan).toBeNull()
  })

  test('subscription.active=true and plan=pro when OAuth tokens present with subscriptionType=pro', async () => {
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => SUBSCRIPTION_TOKEN_FIXTURE,
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => true,
      getSubscriptionType: () => 'pro',
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.subscription.active).toBe(true)
    expect(status.subscription.plan).toBe('pro')
  })

  test('workspaceKey.set=false when ANTHROPIC_API_KEY not set', async () => {
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.set).toBe(false)
    expect(status.workspaceKey.prefixValid).toBe(false)
    expect(status.workspaceKey.keyPreview).toBeNull()
  })

  test('workspaceKey.set=true, prefixValid=true with valid sk-ant-api03- prefix', async () => {
    // 52-char key: prefix (14) + 38 chars
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => true,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.set).toBe(true)
    expect(status.workspaceKey.prefixValid).toBe(true)
    expect(status.workspaceKey.keyPreview).not.toBeNull()
    // Preview must NOT include full key value
    expect(status.workspaceKey.keyPreview).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
    // Preview must contain masked form
    expect(status.workspaceKey.keyPreview).toContain('...')
  })

  test('workspaceKey.prefixValid=false when key has wrong prefix', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-wrong-prefix-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => true,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    expect(status.workspaceKey.set).toBe(true)
    expect(status.workspaceKey.prefixValid).toBe(false)
  })

  test('keyPreview format: shows first4 + ... + last2 + length for valid key', async () => {
    // Build a key: sk-ant-api03- (14 chars) + ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567 (34 chars) = 48 chars total
    const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567'
    process.env.ANTHROPIC_API_KEY = key
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => true,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    const preview = status.workspaceKey.keyPreview
    expect(preview).not.toBeNull()
    // Must contain length
    expect(preview).toContain(`(${key.length}`)
    // Must contain first 4 chars
    expect(preview).toContain('sk-a')
    // Must contain last 2 chars
    expect(preview).toContain('67')
    // Full suffix must not appear
    expect(preview).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567')
  })

  test('thirdParty cerebras shows apiKeySet=true when CEREBRAS_API_KEY is set', async () => {
    process.env.CEREBRAS_API_KEY = 'cerebras-test-key-abc'
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    const cerebras = status.thirdParty.find(p => p.id === 'cerebras')
    expect(cerebras).toBeDefined()
    expect(cerebras?.apiKeySet).toBe(true)
  })

  test('thirdParty groq shows apiKeySet=false when GROQ_API_KEY not set', async () => {
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    const groq = status.thirdParty.find(p => p.id === 'groq')
    expect(groq).toBeDefined()
    expect(groq?.apiKeySet).toBe(false)
  })

  test('thirdParty isActive=true when CLAUDE_CODE_USE_OPENAI=1 and OPENAI_BASE_URL matches provider baseUrl', async () => {
    process.env.CEREBRAS_API_KEY = 'cerebras-key'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.cerebras.ai/v1'
    mock.module('src/utils/auth.ts', () => ({
      getClaudeAIOAuthTokens: () => null,
      hasAnthropicApiKeyAuth: () => false,
      isAnthropicAuthEnabled: () => false,
      getSubscriptionType: () => null,
    }))
    const { getAuthStatus } = await import('../getAuthStatus.js')
    const status = getAuthStatus()
    const cerebras = status.thirdParty.find(p => p.id === 'cerebras')
    expect(cerebras?.isActive).toBe(true)
    // Other providers not active
    const groq = status.thirdParty.find(p => p.id === 'groq')
    expect(groq?.isActive).toBe(false)
  })
})

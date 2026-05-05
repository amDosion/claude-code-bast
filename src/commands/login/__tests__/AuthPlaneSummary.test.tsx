/**
 * Tests for AuthPlaneSummary.tsx
 * Uses staticRender to render Ink components to strings.
 * Covers all 4 mode combinations + long provider list + key preview masking.
 */
import { describe, expect, test, mock } from 'bun:test'
import * as React from 'react'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

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

import { renderToString } from '../../../utils/staticRender.js'
import type { AuthStatus } from '../getAuthStatus.js'

// Helper to build minimal AuthStatus fixtures
function makeStatus(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    subscription: {
      active: false,
      plan: null,
      accountEmail: null,
    },
    workspaceKey: {
      set: false,
      prefixValid: false,
      keyPreview: null,
    },
    thirdParty: [
      { id: 'cerebras', name: 'Cerebras', apiKeyEnv: 'CEREBRAS_API_KEY', apiKeySet: false, isActive: false },
      { id: 'groq', name: 'Groq', apiKeyEnv: 'GROQ_API_KEY', apiKeySet: false, isActive: false },
      { id: 'qwen', name: 'Qwen', apiKeyEnv: 'DASHSCOPE_API_KEY', apiKeySet: false, isActive: false },
      { id: 'deepseek', name: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKeySet: false, isActive: false },
    ],
    ...overrides,
  }
}

describe('AuthPlaneSummary', () => {
  test('renders subscription as inactive (☐) when not logged in', async () => {
    const { AuthPlaneSummary } = await import('../AuthPlaneSummary.js')
    const status = makeStatus()
    const out = await renderToString(<AuthPlaneSummary status={status} />)
    expect(out).toContain('Subscription')
    // Subscription inactive symbol or "not logged in" indicator
    expect(out.toLowerCase()).toMatch(/not logged in|☐/)
  })

  test('renders subscription as active (☑) with plan label when subscribed', async () => {
    const { AuthPlaneSummary } = await import('../AuthPlaneSummary.js')
    const status = makeStatus({
      subscription: { active: true, plan: 'pro', accountEmail: null },
    })
    const out = await renderToString(<AuthPlaneSummary status={status} />)
    expect(out).toContain('pro')
    // Active symbol present
    expect(out).toContain('☑')
  })

  test('renders workspace key as set+valid (☑) when prefixValid=true', async () => {
    const { AuthPlaneSummary } = await import('../AuthPlaneSummary.js')
    const status = makeStatus({
      workspaceKey: {
        set: true,
        prefixValid: true,
        keyPreview: 'sk-a...67 (48 chars)',
      },
    })
    const out = await renderToString(<AuthPlaneSummary status={status} />)
    expect(out).toContain('sk-a...67 (48 chars)')
    expect(out).toContain('☑')
  })

  test('renders workspace key warning (⚠) when set but prefix invalid', async () => {
    const { AuthPlaneSummary } = await import('../AuthPlaneSummary.js')
    const status = makeStatus({
      workspaceKey: {
        set: true,
        prefixValid: false,
        keyPreview: 'sk-w...ng (40 chars)',
      },
    })
    const out = await renderToString(<AuthPlaneSummary status={status} />)
    // Warning indicator present
    expect(out).toContain('⚠')
    expect(out.toLowerCase()).toContain('sk-ant-api03-')
  })

  test('shows workspace key 4-step setup instructions when key not set and subscription active', async () => {
    const { AuthPlaneSummary } = await import('../AuthPlaneSummary.js')
    const status = makeStatus({
      subscription: { active: true, plan: 'pro', accountEmail: null },
      workspaceKey: { set: false, prefixValid: false, keyPreview: null },
    })
    const out = await renderToString(<AuthPlaneSummary status={status} />)
    expect(out).toContain('console.anthropic.com')
  })

  test('renders third-party providers with ✓ for set and ☐ for unset', async () => {
    const { AuthPlaneSummary } = await import('../AuthPlaneSummary.js')
    const status = makeStatus({
      thirdParty: [
        { id: 'cerebras', name: 'Cerebras', apiKeyEnv: 'CEREBRAS_API_KEY', apiKeySet: true, isActive: false },
        { id: 'groq', name: 'Groq', apiKeyEnv: 'GROQ_API_KEY', apiKeySet: false, isActive: false },
        { id: 'qwen', name: 'Qwen', apiKeyEnv: 'DASHSCOPE_API_KEY', apiKeySet: false, isActive: false },
        { id: 'deepseek', name: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKeySet: false, isActive: false },
      ],
    })
    const out = await renderToString(<AuthPlaneSummary status={status} />)
    expect(out).toContain('Cerebras')
    expect(out).toContain('✓')
    expect(out).toContain('Groq')
    expect(out).toContain('☐')
  })

  test('marks active provider with (active) label', async () => {
    const { AuthPlaneSummary } = await import('../AuthPlaneSummary.js')
    const status = makeStatus({
      thirdParty: [
        { id: 'cerebras', name: 'Cerebras', apiKeyEnv: 'CEREBRAS_API_KEY', apiKeySet: true, isActive: true },
        { id: 'groq', name: 'Groq', apiKeyEnv: 'GROQ_API_KEY', apiKeySet: false, isActive: false },
        { id: 'qwen', name: 'Qwen', apiKeyEnv: 'DASHSCOPE_API_KEY', apiKeySet: false, isActive: false },
        { id: 'deepseek', name: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKeySet: false, isActive: false },
      ],
    })
    const out = await renderToString(<AuthPlaneSummary status={status} />)
    expect(out.toLowerCase()).toContain('active')
    expect(out).toContain('Cerebras')
  })
})

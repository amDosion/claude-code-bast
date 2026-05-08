import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'

// We mock the LOWER layers (axios + localVault store + http util) rather
// than the tool itself, per memory feedback "Mock dependency not subject".

type AxiosRespLike = {
  status: number
  statusText: string
  headers: Record<string, string | string[]>
  data: string
}

const mockAxiosRequest = mock(
  async (): Promise<AxiosRespLike> => ({
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    data: '{"ok":true}',
  }),
)

mock.module('axios', () => ({
  default: { request: mockAxiosRequest },
}))

let mockedSecret: string | null = 'XSECRETXX'
mock.module('src/services/localVault/store.js', () => ({
  getSecret: async () => mockedSecret,
}))

// MACRO is a Bun build-time define injected at compile time. In bun:test
// it doesn't exist, so any code path that references it crashes. Inject a
// minimal MACRO object before any module under test imports
// src/utils/userAgent.ts (which references MACRO.VERSION).
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: '0.0.0-test',
}

// ── Helpers ─────────────────────────────────────────────────────────────────

import { mockToolContext } from '../../../../../../tests/mocks/toolContext.js'
function mockContext() {
  return mockToolContext()
}

function makeAxiosResp(opts: {
  status?: number
  data?: string
  headers?: Record<string, string | string[]>
}) {
  return {
    status: opts.status ?? 200,
    statusText: 'STATUS',
    headers: opts.headers ?? {},
    data: opts.data ?? '',
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('VaultHttpFetchTool: schema + checkPermissions', () => {
  beforeEach(() => {
    mockAxiosRequest.mockClear()
    mockedSecret = 'XSECRETXX'
  })

  test('AC10: HTTP (non-https) URL is rejected at checkPermissions', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    const result = await VaultHttpFetchTool.checkPermissions!(
      {
        url: 'http://insecure.example.com/api',
        method: 'GET',
        vault_auth_key: 'k',
        auth_scheme: 'bearer',
        reason: 'test',
      },
      mockContext(),
    )
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toMatch(/https:\/\//)
    }
  })

  test('AC11: file:// is rejected', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    const result = await VaultHttpFetchTool.checkPermissions!(
      {
        url: 'file:///etc/passwd',
        method: 'GET',
        vault_auth_key: 'k',
        auth_scheme: 'bearer',
        reason: 'test',
      },
      mockContext(),
    )
    expect(result.behavior).toBe('deny')
  })

  test('AC2: no allow rule → ask (not allow)', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    const result = await VaultHttpFetchTool.checkPermissions!(
      {
        url: 'https://api.example.com',
        method: 'GET',
        vault_auth_key: 'gh',
        auth_scheme: 'bearer',
        reason: 'fetch repo',
      },
      mockContext(),
    )
    expect(result.behavior).toBe('ask')
  })

  test('invalid vault key (path-traversal-like) → deny', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    const result = await VaultHttpFetchTool.checkPermissions!(
      {
        url: 'https://api.example.com',
        method: 'GET',
        vault_auth_key: '../etc',
        auth_scheme: 'bearer',
        reason: 'test',
      },
      mockContext(),
    )
    expect(result.behavior).toBe('deny')
  })

  test('auth_scheme=custom requires auth_header_name', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    const result = await VaultHttpFetchTool.checkPermissions!(
      {
        url: 'https://api.example.com',
        method: 'GET',
        vault_auth_key: 'k',
        auth_scheme: 'custom',
        reason: 'test',
      },
      mockContext(),
    )
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toMatch(/auth_header_name/)
    }
  })

  test('Tool definition: requiresUserInteraction = true (bypass-immune)', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    expect(VaultHttpFetchTool.requiresUserInteraction!()).toBe(true)
  })

  test('Tool definition: isConcurrencySafe = false', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    expect(VaultHttpFetchTool.isConcurrencySafe!()).toBe(false)
  })
})

describe('VaultHttpFetchTool: call() — secret leak prevention', () => {
  beforeEach(() => {
    mockAxiosRequest.mockClear()
    mockedSecret = 'XSECRETXX'
  })

  test('AC4: secret never appears in returned data (Bearer scheme)', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    mockAxiosRequest.mockImplementation(async () =>
      makeAxiosResp({ data: '{"hello":"world"}' }),
    )
    const result = await VaultHttpFetchTool.call(
      {
        url: 'https://api.example.com',
        method: 'GET',
        vault_auth_key: 'gh',
        auth_scheme: 'bearer',
        reason: 'test',
      },
      mockContext(),
    )
    const json = JSON.stringify(result.data)
    expect(json).not.toContain('XSECRETXX')
    expect(json).not.toContain('Bearer XSECRETXX')
  })

  test('AC14: secret echoed in 4xx response body is scrubbed', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    // Server returns 401 + body that echoes the auth header
    mockAxiosRequest.mockImplementation(async () =>
      makeAxiosResp({
        status: 401,
        data: 'Unauthorized: provided "Bearer XSECRETXX" is invalid',
      }),
    )
    const result = await VaultHttpFetchTool.call(
      {
        url: 'https://api.example.com',
        method: 'POST',
        vault_auth_key: 'gh',
        auth_scheme: 'bearer',
        reason: 'test',
      },
      mockContext(),
    )
    expect(result.data.body).toBeDefined()
    expect(result.data.body).not.toContain('XSECRETXX')
    expect(result.data.body).toContain('[REDACTED]')
    // status preserved (4xx not in catch branch)
    expect(result.data.status).toBe(401)
  })

  test('AC15: secret echoed in 200 response body is scrubbed', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    mockAxiosRequest.mockImplementation(async () =>
      makeAxiosResp({
        status: 200,
        data: '{"echo":"Bearer XSECRETXX","ok":true}',
      }),
    )
    const result = await VaultHttpFetchTool.call(
      {
        url: 'https://api.example.com',
        method: 'POST',
        vault_auth_key: 'gh',
        auth_scheme: 'bearer',
        reason: 'test',
      },
      mockContext(),
    )
    expect(result.data.body).not.toContain('XSECRETXX')
    expect(result.data.body).toContain('[REDACTED]')
  })

  test('AC16: all derived secret forms scrubbed (raw / Bearer / base64 / Basic)', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    const b64 = Buffer.from('XSECRETXX', 'utf8').toString('base64')
    mockAxiosRequest.mockImplementation(async () =>
      makeAxiosResp({
        data: `raw=XSECRETXX bearer=Bearer XSECRETXX b64=${b64} basic=Basic ${b64}`,
      }),
    )
    const result = await VaultHttpFetchTool.call(
      {
        url: 'https://api.example.com',
        method: 'GET',
        vault_auth_key: 'gh',
        auth_scheme: 'bearer',
        reason: 'test',
      },
      mockContext(),
    )
    expect(result.data.body).not.toContain('XSECRETXX')
    expect(result.data.body).not.toContain(b64)
  })

  test('AC9: response Authorization echo header is redacted by NAME', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    mockAxiosRequest.mockImplementation(async () =>
      makeAxiosResp({
        data: 'ok',
        headers: { authorization: 'Bearer XSECRETXX', 'content-type': 'text/plain' },
      }),
    )
    const result = await VaultHttpFetchTool.call(
      {
        url: 'https://api.example.com',
        method: 'GET',
        vault_auth_key: 'gh',
        auth_scheme: 'bearer',
        reason: 'test',
      },
      mockContext(),
    )
    expect(result.data.responseHeaders!['authorization']).toBe('[REDACTED]')
    expect(result.data.responseHeaders!['content-type']).toBe('text/plain')
  })

  test('AC8: secret never appears in axios error path', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    class FakeAxiosError extends Error {
      config = { headers: { Authorization: 'Bearer XSECRETXX' } }
    }
    mockAxiosRequest.mockImplementation(async () => {
      throw new FakeAxiosError('connect ECONNREFUSED')
    })
    const result = await VaultHttpFetchTool.call(
      {
        url: 'https://api.example.com',
        method: 'GET',
        vault_auth_key: 'gh',
        auth_scheme: 'bearer',
        reason: 'test',
      },
      mockContext(),
    )
    expect(result.data.error).toBeDefined()
    expect(result.data.error).not.toContain('XSECRETXX')
    expect(result.data.error).not.toContain('Bearer')
  })

  test('AC17: maxRedirects=0 (no redirect Authorization re-leak)', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    mockAxiosRequest.mockImplementation(async () => makeAxiosResp({ data: 'ok' }))
    await VaultHttpFetchTool.call(
      {
        url: 'https://api.example.com',
        method: 'GET',
        vault_auth_key: 'gh',
        auth_scheme: 'bearer',
        reason: 'test',
      },
      mockContext(),
    )
    expect(mockAxiosRequest).toHaveBeenCalledTimes(1)
    const calls = mockAxiosRequest.mock.calls as unknown as Array<
      Array<{ maxRedirects?: number }>
    >
    expect(calls[0]?.[0]?.maxRedirects).toBe(0)
  })

  test('vault key not found -> error message (no crash)', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    mockedSecret = null
    const result = await VaultHttpFetchTool.call(
      {
        url: 'https://api.example.com',
        method: 'GET',
        vault_auth_key: 'missing',
        auth_scheme: 'bearer',
        reason: 'test',
      },
      mockContext(),
    )
    expect(result.data.error).toMatch(/not found/)
  })

  test('basic scheme uses base64 Authorization', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    mockAxiosRequest.mockImplementation(async () => makeAxiosResp({ data: 'ok' }))
    await VaultHttpFetchTool.call(
      {
        url: 'https://api.example.com',
        method: 'GET',
        vault_auth_key: 'k',
        auth_scheme: 'basic',
        reason: 'test',
      },
      mockContext(),
    )
    const calls = mockAxiosRequest.mock.calls as unknown as Array<
      Array<{ headers?: Record<string, string> }>
    >
    const callArgs = calls[0]?.[0] ?? { headers: {} }
    expect(callArgs.headers?.['Authorization']).toBe(
      `Basic ${Buffer.from('XSECRETXX', 'utf8').toString('base64')}`,
    )
  })

  test('header_x_api_key scheme sets X-Api-Key', async () => {
    const { VaultHttpFetchTool } = await import('../VaultHttpFetchTool.js')
    mockAxiosRequest.mockImplementation(async () => makeAxiosResp({ data: 'ok' }))
    await VaultHttpFetchTool.call(
      {
        url: 'https://api.example.com',
        method: 'GET',
        vault_auth_key: 'k',
        auth_scheme: 'header_x_api_key',
        reason: 'test',
      },
      mockContext(),
    )
    const calls = mockAxiosRequest.mock.calls as unknown as Array<
      Array<{ headers?: Record<string, string> }>
    >
    const callArgs = calls[0]?.[0] ?? { headers: {} }
    expect(callArgs.headers?.['X-Api-Key']).toBe('XSECRETXX')
    expect(callArgs.headers?.['Authorization']).toBeUndefined()
  })
})

describe('AC18: VaultHttpFetch is in ALL_AGENT_DISALLOWED_TOOLS', () => {
  // Direct import of src/constants/tools.js depends on bun:bundle feature()
  // macros that don't resolve outside full-build context, and the various
  // mocks in this file can interfere when the suite is run together. Use a
  // grep snapshot — same approach as agentToolFilter AC11b.
  test('subagent gate layer 1 registration is wired', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const file = path.resolve('src/constants/tools.ts')
    const src = fs.readFileSync(file, 'utf8')
    // (a) constant is imported
    expect(src).toContain('VAULT_HTTP_FETCH_TOOL_NAME')
    expect(src).toContain(
      "from '@claude-code-best/builtin-tools/tools/VaultHttpFetchTool/constants.js'",
    )
    // (b) and used in the ALL_AGENT_DISALLOWED_TOOLS region.
    // Find the export and verify VAULT_HTTP_FETCH_TOOL_NAME appears before the
    // CUSTOM_AGENT_DISALLOWED_TOOLS (next export). This avoids a fragile
    // greedy-regex match against the nested AGENT_TOOL_NAME ternary.
    const exportIdx = src.indexOf(
      'export const ALL_AGENT_DISALLOWED_TOOLS = new Set(',
    )
    const customIdx = src.indexOf(
      'export const CUSTOM_AGENT_DISALLOWED_TOOLS',
    )
    expect(exportIdx).toBeGreaterThan(-1)
    expect(customIdx).toBeGreaterThan(exportIdx)
    const region = src.slice(exportIdx, customIdx)
    expect(region).toContain('VAULT_HTTP_FETCH_TOOL_NAME')
  })
})

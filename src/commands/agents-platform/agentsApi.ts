/**
 * Thin HTTP client for the /v1/agents endpoint.
 *
 * Reuses the same base-URL + auth-header pattern as the rest of the codebase:
 *   getOauthConfig().BASE_API_URL → base
 *   getClaudeAIOAuthTokens()?.accessToken → Bearer token
 *   getOAuthHeaders(token) → Authorization + anthropic-version headers
 *   getOrganizationUUID() → x-organization-uuid header
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

export type AgentTrigger = {
  id: string
  cron_expr: string
  prompt: string
  status: string
  timezone: string
  next_run?: string | null
  created_at?: string
}

type ListAgentsResponse = {
  data: AgentTrigger[]
}

type AgentRunResponse = {
  run_id: string
}

// Server requires the managed-agents umbrella beta header.
const AGENTS_BETA_HEADER = 'managed-agents-2026-04-01'
const MAX_RETRIES = 3

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class AgentsApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'AgentsApiError'
  }
}

async function buildHeaders(): Promise<Record<string, string>> {
  // /v1/agents is a workspace-API-key endpoint, not subscription OAuth.
  // Reverse-engineered from claude.exe v2.1.123: the binary contains no
  // actual request construction for /v1/agents — only documentation strings
  // in the managed-agents reference table. Subscription bearer tokens
  // always 401 here. Surface a clear message instead of "auth failed".
  throw new AgentsApiError(
    '/v1/agents requires an Anthropic workspace API key, which the fork does not yet wire up. Subscription OAuth (claude.ai login) cannot reach this endpoint. Use /schedule for cron-style remote agents on the subscription plane.',
    501,
  )
}

function agentsBaseUrl(): string {
  return `${getOauthConfig().BASE_API_URL}/v1/agents`
}

function classifyError(err: unknown): AgentsApiError {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 0
    if (status === 401) {
      return new AgentsApiError(
        'Authentication failed. Please run /login to re-authenticate.',
        401,
      )
    }
    if (status === 403) {
      return new AgentsApiError(
        'Subscription required. Scheduled agents require a Claude Pro/Max/Team subscription.',
        403,
      )
    }
    if (status === 404) {
      return new AgentsApiError('Agent not found.', 404)
    }
    const msg =
      (err.response?.data as { error?: { message?: string } } | undefined)
        ?.error?.message ?? err.message
    return new AgentsApiError(msg, status)
  }
  if (err instanceof AgentsApiError) return err
  return new AgentsApiError(err instanceof Error ? err.message : String(err), 0)
}

/**
 * Parses the Retry-After header value into milliseconds.
 * Accepts both integer-seconds (e.g. "30") and HTTP-date strings.
 * Returns null when the header is absent or unparseable.
 */
function parseRetryAfterMs(header: string | undefined): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: AgentsApiError | undefined
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const classified = classifyError(err)
      // Only retry 5xx errors
      if (classified.statusCode >= 500) {
        lastErr = classified
        if (attempt < MAX_RETRIES - 1) {
          // Honor Retry-After if present; fall back to exponential backoff.
          const retryAfterHeader = axios.isAxiosError(err)
            ? (err.response?.headers as Record<string, string> | undefined)?.[
                'retry-after'
              ]
            : undefined
          const waitMs =
            parseRetryAfterMs(retryAfterHeader) ?? 500 * 2 ** attempt
          await sleep(waitMs)
        }
        continue
      }
      throw classified
    }
  }
  throw lastErr ?? new AgentsApiError('Request failed after retries', 0)
}

export async function listAgents(): Promise<AgentTrigger[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<ListAgentsResponse>(agentsBaseUrl(), {
      headers,
    })
    return response.data.data ?? []
  })
}

export async function createAgent(
  cron: string,
  prompt: string,
): Promise<AgentTrigger> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.post<AgentTrigger>(
      agentsBaseUrl(),
      {
        cron_expr: cron,
        prompt,
        // Server-side agent execution always runs in UTC; the timezone field
        // tells the server how to interpret the cron expression. We use the
        // system timezone so that "9am every Monday" means 9am local time.
        // Users can override via the --tz flag parsed in parseArgs.ts.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
      },
      { headers },
    )
    return response.data
  })
}

export async function deleteAgent(id: string): Promise<void> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    await axios.delete(`${agentsBaseUrl()}/${id}`, { headers })
  })
}

export async function runAgent(id: string): Promise<AgentRunResponse> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.post<AgentRunResponse>(
      `${agentsBaseUrl()}/${id}/run`,
      {},
      { headers },
    )
    return response.data
  })
}

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { sanitizePath } from '../../utils/path.js'
import type { Command, LocalCommandResult } from '../../types/command.js'

// Default context window size for Claude 3.5 Sonnet / Claude 3.7 Sonnet
const DEFAULT_MAX_TOKENS = 200_000
// Number of grid squares in the visualization bar
const GRID_COLS = 50

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtSeconds(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`
  const m = Math.floor(s / 60)
  const r = Math.floor(s - m * 60)
  if (m < 60) return `${m}m ${r}s`
  const h = Math.floor(m / 60)
  const rm = m - h * 60
  return `${h}h ${rm}m ${r}s`
}

/**
 * Renders a colored ASCII grid bar.
 *
 * Segments (left to right):
 *   cache_read  → cyan  '▓'
 *   cache_create → blue '▓'
 *   input        → green '▓'
 *   output       → yellow '▓'
 *   unused       → dim '░'
 *
 * Each square represents 1/GRID_COLS of max_tokens.
 */
function renderContextGrid(
  input: number,
  output: number,
  cacheCreate: number,
  cacheRead: number,
  maxTokens: number,
): string {
  const total = maxTokens
  const usedTotal = input + output + cacheCreate + cacheRead

  // Each slot = how many tokens
  const slotSize = total / GRID_COLS

  const cacheReadSlots = Math.min(GRID_COLS, Math.round(cacheRead / slotSize))
  const cacheCreateSlots = Math.min(
    GRID_COLS - cacheReadSlots,
    Math.round(cacheCreate / slotSize),
  )
  const inputSlots = Math.min(
    GRID_COLS - cacheReadSlots - cacheCreateSlots,
    Math.round(input / slotSize),
  )
  const outputSlots = Math.min(
    GRID_COLS - cacheReadSlots - cacheCreateSlots - inputSlots,
    Math.round(output / slotSize),
  )
  const unusedSlots = Math.max(
    0,
    GRID_COLS - cacheReadSlots - cacheCreateSlots - inputSlots - outputSlots,
  )

  const pct = ((usedTotal / total) * 100).toFixed(1)
  const color =
    usedTotal / total < 0.6
      ? 'green'
      : usedTotal / total < 0.85
        ? 'yellow'
        : 'red'

  // Build the grid string with ANSI codes
  const ansi = {
    cyan: '\x1b[36m',
    blue: '\x1b[34m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    reset: '\x1b[0m',
  }
  const colorLabel =
    color === 'green' ? ansi.green : color === 'yellow' ? ansi.yellow : ansi.red

  const bar = [
    ansi.cyan + '▓'.repeat(cacheReadSlots),
    ansi.blue + '▓'.repeat(cacheCreateSlots),
    ansi.green + '▓'.repeat(inputSlots),
    ansi.yellow + '▓'.repeat(outputSlots),
    ansi.dim + '░'.repeat(unusedSlots),
    ansi.reset,
  ].join('')

  return [
    `  [${bar}] ${colorLabel}${pct}%${ansi.reset}`,
    `  Legend: ${ansi.cyan}▓${ansi.reset}cache_read  ${ansi.blue}▓${ansi.reset}cache_create  ${ansi.green}▓${ansi.reset}input  ${ansi.yellow}▓${ansi.reset}output  ${ansi.dim}░${ansi.reset}unused`,
  ].join('\n')
}

/**
 * Renders a simple cache hit/miss ratio bar.
 */
function renderCacheBar(cacheRead: number, cacheCreate: number): string {
  const total = cacheRead + cacheCreate
  if (total === 0) return '  (no cache activity)'

  const hitPct = (cacheRead / total) * 100
  const missPct = (cacheCreate / total) * 100
  const hitSlots = Math.round((cacheRead / total) * 30)
  const missSlots = 30 - hitSlots

  const ansi = {
    cyan: '\x1b[36m',
    blue: '\x1b[34m',
    reset: '\x1b[0m',
  }

  const bar =
    ansi.cyan +
    '▓'.repeat(hitSlots) +
    ansi.blue +
    '▓'.repeat(missSlots) +
    ansi.reset
  return [
    `  Cache hit/miss: [${bar}]`,
    `  hit ${hitPct.toFixed(1)}% (${cacheRead.toLocaleString()} tokens)  miss ${missPct.toFixed(1)}% (${cacheCreate.toLocaleString()} tokens)`,
  ].join('\n')
}

interface UsageAccumulator {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

interface MessageSummary {
  role: string
  preview: string
  turnInput?: number
  turnOutput?: number
  turnCacheCreate?: number
  turnCacheRead?: number
}

interface LogEntry {
  role?: string
  type?: string
  content?: unknown
  usage?: Record<string, number>
}

function getTranscriptPath(): string {
  const sessionId = getSessionId()
  const projectDir = getSessionProjectDir()
  if (projectDir) return join(projectDir, `${sessionId}.jsonl`)
  return join(
    getClaudeConfigHomeDir(),
    'projects',
    sanitizePath(getOriginalCwd()),
    `${sessionId}.jsonl`,
  )
}

function extractTextPreview(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 60)
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text.slice(0, 60)
      }
      if (block.type === 'tool_use') {
        return `[tool_use: ${block.name ?? 'unknown'}]`
      }
      if (block.type === 'tool_result') {
        return `[tool_result: ${String(block.tool_use_id ?? '').slice(0, 8)}]`
      }
    }
  }
  return ''
}

function parseLogFile(logPath: string): {
  messages: MessageSummary[]
  usage: UsageAccumulator
  roleCounts: Record<string, number>
  totalLines: number
  turns: Array<{
    turnIdx: number
    input: number
    output: number
    cacheCreate: number
    cacheRead: number
  }>
} {
  const usage: UsageAccumulator = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  const roleCounts: Record<string, number> = {}
  const messages: MessageSummary[] = []
  const turns: Array<{
    turnIdx: number
    input: number
    output: number
    cacheCreate: number
    cacheRead: number
  }> = []
  let turnIdx = 0

  const raw = readFileSync(logPath, 'utf8')
  const lines = raw.trim().split('\n').filter(Boolean)
  const totalLines = lines.length

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as LogEntry
      const role = entry.role ?? entry.type ?? 'unknown'
      roleCounts[role] = (roleCounts[role] ?? 0) + 1

      let turnInput = 0
      let turnOutput = 0
      let turnCacheCreate = 0
      let turnCacheRead = 0

      if (entry.usage) {
        const u = entry.usage
        turnInput = typeof u.input_tokens === 'number' ? u.input_tokens : 0
        turnOutput = typeof u.output_tokens === 'number' ? u.output_tokens : 0
        turnCacheCreate =
          typeof u.cache_creation_input_tokens === 'number'
            ? u.cache_creation_input_tokens
            : 0
        turnCacheRead =
          typeof u.cache_read_input_tokens === 'number'
            ? u.cache_read_input_tokens
            : 0

        usage.input_tokens += turnInput
        usage.output_tokens += turnOutput
        usage.cache_creation_input_tokens += turnCacheCreate
        usage.cache_read_input_tokens += turnCacheRead
      }

      // Track per-turn usage for breakdown (user turns as boundaries)
      if (role === 'user') {
        turnIdx++
      }
      if (turnInput + turnOutput + turnCacheCreate + turnCacheRead > 0) {
        turns.push({
          turnIdx,
          input: turnInput,
          output: turnOutput,
          cacheCreate: turnCacheCreate,
          cacheRead: turnCacheRead,
        })
      }

      const preview = extractTextPreview(entry.content)
      messages.push({
        role,
        preview: preview.replace(/\n/g, ' '),
        turnInput,
        turnOutput,
        turnCacheCreate,
        turnCacheRead,
      })
    } catch {
      // skip malformed lines
    }
  }

  return { messages, usage, roleCounts, totalLines, turns }
}

/**
 * Renders a compact per-turn token breakdown bar.
 * Shows the last N turns as mini horizontal bars.
 */
function renderPerTurnBreakdown(
  turns: Array<{
    turnIdx: number
    input: number
    output: number
    cacheCreate: number
    cacheRead: number
  }>,
  maxTokens: number,
): string {
  if (turns.length === 0) return '  (no per-turn usage data)'

  const BAR_WIDTH = 30
  const ansi = {
    cyan: '\x1b[36m',
    blue: '\x1b[34m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    dim: '\x1b[2m',
    reset: '\x1b[0m',
  }

  const recentTurns = turns.slice(-8)
  const rows = recentTurns.map(t => {
    const total = t.input + t.output + t.cacheCreate + t.cacheRead
    const frac = Math.min(1, total / maxTokens)
    const filled = Math.max(1, Math.round(frac * BAR_WIDTH))
    const bar =
      ansi.cyan +
      '▓'.repeat(Math.round((t.cacheRead / maxTokens) * BAR_WIDTH)) +
      ansi.blue +
      '▓'.repeat(Math.round((t.cacheCreate / maxTokens) * BAR_WIDTH)) +
      ansi.green +
      '▓'.repeat(Math.round((t.input / maxTokens) * BAR_WIDTH)) +
      ansi.yellow +
      '▓'.repeat(
        Math.max(
          0,
          filled -
            Math.round(
              ((t.cacheRead + t.cacheCreate + t.input) / maxTokens) * BAR_WIDTH,
            ),
        ),
      ) +
      ansi.reset
    return `  T${String(t.turnIdx).padStart(2)}  [${bar.padEnd(BAR_WIDTH + 20)}]  ${total.toLocaleString()} tokens`
  })

  return rows.join('\n')
}

const ctxViz: Command = {
  type: 'local',
  name: 'ctx_viz',
  aliases: ['context'],
  description:
    'Visualize context window usage as a colored grid — token breakdown, cache stats, per-turn chart',
  isHidden: false,
  isEnabled: () => true,
  supportsNonInteractive: true,
  bridgeSafe: true,
  load: async () => ({
    call: async (args: string): Promise<LocalCommandResult> => {
      const sessionId = getSessionId()
      const logPath = getTranscriptPath()

      // Allow --max-tokens=N override.
      // Cap at 10_000_000 to prevent BAR_WIDTH math underflowing to 0
      // when the divisor is astronomically large (e.g. MAX_SAFE_INTEGER).
      const MAX_TOKENS_CAP = 10_000_000
      let maxTokens = DEFAULT_MAX_TOKENS
      const maxMatch = args.match(/--max-tokens[= ](\d+)/)
      if (maxMatch) {
        const parsed = parseInt(maxMatch[1], 10)
        if (!Number.isNaN(parsed) && parsed > 0) {
          if (parsed > MAX_TOKENS_CAP) {
            return {
              type: 'text',
              value: `--max-tokens value ${parsed} exceeds maximum allowed (${MAX_TOKENS_CAP.toLocaleString()}). Please use a value ≤ ${MAX_TOKENS_CAP.toLocaleString()}.`,
            }
          }
          maxTokens = parsed
        }
      }

      const mem = process.memoryUsage()
      const runtimeSection = [
        '## Runtime',
        `  pid:        ${process.pid}`,
        `  uptime:     ${fmtSeconds(process.uptime())}`,
        `  rss:        ${fmtBytes(mem.rss)}`,
        `  heap:       ${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}`,
        `  session:    ${sessionId}`,
        `  log:        ${logPath}`,
        `  max_tokens: ${maxTokens.toLocaleString()}`,
      ]

      if (!existsSync(logPath)) {
        return {
          type: 'text',
          value: [
            ...runtimeSection,
            '',
            '## Session Log',
            '(no log file found — session may not have started yet)',
          ].join('\n'),
        }
      }

      const { messages, usage, roleCounts, totalLines, turns } =
        parseLogFile(logPath)

      const totalTokens =
        usage.input_tokens +
        usage.output_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens

      // ── Colored context grid ──
      const gridSection = [
        '',
        '## Context Window Usage',
        `  Used: ${totalTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens`,
        '',
        renderContextGrid(
          usage.input_tokens,
          usage.output_tokens,
          usage.cache_creation_input_tokens,
          usage.cache_read_input_tokens,
          maxTokens,
        ),
      ]

      // ── Cache hit/miss bar ──
      const cacheSection = [
        '',
        '## Cache Activity',
        renderCacheBar(
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
        ),
      ]

      const usageSection = [
        '',
        '## Token Usage (cumulative)',
        `  input:          ${usage.input_tokens.toLocaleString()}`,
        `  output:         ${usage.output_tokens.toLocaleString()}`,
        `  cache_creation: ${usage.cache_creation_input_tokens.toLocaleString()}`,
        `  cache_read:     ${usage.cache_read_input_tokens.toLocaleString()}`,
        `  total:          ${totalTokens.toLocaleString()}`,
      ]

      const roleSection = [
        '',
        '## Message Distribution',
        `  total log lines: ${totalLines}`,
        ...Object.entries(roleCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([role, count]) => `  ${role.padEnd(20)} ${count}`),
      ]

      // ── Per-turn breakdown ──
      const turnSection = [
        '',
        `## Per-Turn Token Breakdown (last ${Math.min(8, turns.length)} turns)`,
        renderPerTurnBreakdown(turns, maxTokens),
      ]

      const recent = messages.slice(-20)
      const recentSection = [
        '',
        `## Recent Messages (last ${recent.length})`,
        ...recent.map((m, i) => {
          const idx = messages.length - recent.length + i + 1
          const preview = m.preview ? ` — ${m.preview}` : ''
          return `  [${String(idx).padStart(3)}] ${m.role.padEnd(16)}${preview}`
        }),
      ]

      return {
        type: 'text',
        value: [
          ...runtimeSection,
          ...gridSection,
          ...cacheSection,
          ...usageSection,
          ...roleSection,
          ...turnSection,
          ...recentSection,
        ].join('\n'),
      }
    },
  }),
}

export default ctxViz

// Extract the <autofix-result> tag from a remote autofix-pr session log.
//
// The remote agent emits a structured XML block as its final message
// (initialMessage in launchAutofixPr.ts instructs it to). The tag carries
// PR-specific outcome data — commits pushed, files changed, CI status,
// summary — that the framework's generic "task completed" notification
// can't convey. We surface it to the local model by injecting the tag
// verbatim into the message queue (analogous to <remote-review> handling).
//
// Resilient to two production realities:
//   1. The tag may appear in either an assistant text block or a hook
//      stdout (some autofix skills wrap the final report in a hook).
//   2. The tag may not appear at all (older agents, truncated runs) —
//      caller falls back to generic completion notification.

import type {
  SDKAssistantMessage,
  SDKMessage,
} from '../../entrypoints/agentSdkTypes.js'

export const AUTOFIX_RESULT_TAG = 'autofix-result'

const TAG_OPEN = `<${AUTOFIX_RESULT_TAG}>`
const TAG_CLOSE = `</${AUTOFIX_RESULT_TAG}>`

/**
 * Walk the session log for an <autofix-result> tag. Returns the full tag
 * (including delimiters) so the caller can inject it as-is into the
 * notification; returns null if no tag is present.
 *
 * Search order:
 *   1. Latest hook_progress / hook_response stdout (autofix skills that
 *      use hooks to format the report write here first).
 *   2. Latest assistant text block (agents that don't use hooks write the
 *      tag inline in their final message).
 *
 * Latest-wins so re-tries within the same session don't surface stale
 * earlier results.
 */
export function extractAutofixResultFromLog(log: SDKMessage[]): string | null {
  // Walk backwards so we hit the most recent tag first.
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i]
    if (!msg) continue

    // Hook stdout (system messages of subtype hook_progress / hook_response).
    if (
      msg.type === 'system' &&
      (msg.subtype === 'hook_progress' || msg.subtype === 'hook_response')
    ) {
      const stdout = (msg as { stdout?: unknown }).stdout
      if (typeof stdout === 'string') {
        const extracted = extractBetween(stdout, TAG_OPEN, TAG_CLOSE)
        if (extracted) return extracted
      }
      continue
    }

    // Assistant text blocks.
    if (msg.type === 'assistant') {
      const content = (msg as SDKAssistantMessage).message?.content
      if (!content || typeof content === 'string') continue
      for (const block of content as Array<{ type: string; text?: string }>) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue
        if (!block.text.includes(TAG_OPEN)) continue
        const extracted = extractBetween(block.text, TAG_OPEN, TAG_CLOSE)
        if (extracted) return extracted
      }
    }
  }
  return null
}

function extractBetween(
  text: string,
  open: string,
  close: string,
): string | null {
  const start = text.lastIndexOf(open)
  if (start === -1) return null
  const end = text.indexOf(close, start + open.length)
  if (end === -1) return null
  return text.slice(start, end + close.length)
}

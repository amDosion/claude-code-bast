/**
 * Scrubbing functions for VaultHttpFetchTool.
 *
 * The cardinal rule: NO secret-derived string ever leaves this tool's
 * boundary in any field that would land in tool_result, jsonl, transcript
 * search, telemetry, or compact summaries. The scrub layer applies to:
 *   - response body (server might echo Authorization)
 *   - response headers (Authorization / X-Api-Key / Set-Cookie)
 *   - axios error messages (axios.AxiosError.config can carry the request
 *     headers — including the Authorization we just sent)
 *
 * Strategy: build all "derived forms" of the secret BEFORE the request, then
 * apply scrubAllSecretForms to every byte that crosses the tool boundary.
 *
 * Derived forms covered:
 *   - raw secret value
 *   - 'Bearer <secret>'
 *   - <secret> base64-encoded (for Basic-style payloads)
 *   - 'Basic <base64>' full header value
 *
 * Custom auth_header_name puts the raw secret as the header value, which is
 * already covered by the raw-secret form.
 */

const REDACTED = '[REDACTED]'

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'www-authenticate',
])

/**
 * Minimum secret length to scrub. Below this threshold, scrubbing causes
 * pathological output amplification — e.g. a 1-char secret 'X' on a 1MB
 * body that happens to contain many X chars produces ~10MB of [REDACTED].
 *
 * 4 chars is below any realistic secret (API tokens, OAuth tokens, JWTs,
 * passwords are all >>4). The vault store should reject sub-4-char values
 * at write time, but this is defense-in-depth at scrub time.
 */
const MIN_SCRUB_LENGTH = 4

/**
 * Compute every form the secret could appear in across response body /
 * headers / error message.
 *
 * L7 fix: returns `[]` (empty) when secret is shorter than MIN_SCRUB_LENGTH
 * — scrubbing a too-short pattern is worse than not scrubbing. Caller
 * should guard `if (secret && secret.length >= MIN_SCRUB_LENGTH)` before
 * trusting the result is non-empty. The previous JSDoc claimed "always
 * non-empty" which was inaccurate.
 *
 * Returned forms are sorted longest-first so callers don't need to re-sort.
 */
export function buildDerivedSecretForms(secret: string): readonly string[] {
  if (!secret || secret.length < MIN_SCRUB_LENGTH) return []
  const base64 = Buffer.from(secret, 'utf8').toString('base64')
  // Pre-sorted longest-first (Basic > Bearer > base64 > raw, generally)
  // so callers don't pay the sort cost on every scrub call.
  return [`Basic ${base64}`, `Bearer ${secret}`, base64, secret]
}

/**
 * Replace every occurrence of any derived secret form in `s` with [REDACTED].
 *
 * M7 fix: forms array is pre-sorted longest-first by buildDerivedSecretForms,
 * so we no longer allocate a sorted copy on every call. Also added a
 * `s.length >= form.length` fast-path before `includes()` to skip
 * impossible-match work, and the `includes()` check itself is the fast path
 * that lets us skip the split/join allocation for clean bodies.
 */
export function scrubAllSecretForms(
  s: string,
  forms: readonly string[],
): string {
  if (!s || forms.length === 0) return s
  let out = s
  for (const form of forms) {
    if (
      form.length > 0 &&
      out.length >= form.length &&
      out.includes(form)
    ) {
      out = out.split(form).join(REDACTED)
    }
  }
  return out
}

/**
 * Sanitize response headers: redact sensitive header names entirely, and
 * scrub any remaining headers' values for secret echo.
 */
export function scrubResponseHeaders(
  headers: unknown,
  forms: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    const lname = key.toLowerCase()
    if (SENSITIVE_HEADER_NAMES.has(lname)) {
      out[key] = REDACTED
      continue
    }
    const sv = Array.isArray(value)
      ? value.map(v => String(v ?? '')).join(', ')
      : String(value ?? '')
    out[key] = scrubAllSecretForms(sv, forms)
  }
  return out
}

/**
 * Convert an axios / fetch error into a safe summary string. NEVER stringify
 * the raw error: axios.AxiosError carries .config.headers which contains the
 * Authorization we just sent. Build a synthetic message and scrub it.
 */
export function scrubAxiosError(e: unknown, forms: readonly string[]): string {
  if (e instanceof Error) {
    const msg = scrubAllSecretForms(e.message, forms)
    return `Request failed: ${msg}`
  }
  return 'Request failed (unknown error)'
}

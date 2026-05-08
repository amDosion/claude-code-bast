import { describe, expect, test } from 'bun:test'
import {
  buildDerivedSecretForms,
  scrubAllSecretForms,
  scrubAxiosError,
  scrubResponseHeaders,
} from '../scrub.js'

describe('buildDerivedSecretForms', () => {
  test('returns empty array for empty secret', () => {
    expect(buildDerivedSecretForms('')).toEqual([])
  })

  test('M7: returns empty array for too-short secret (DoS guard)', () => {
    // A 1-3 char secret causes amplification on scrub; refuse to scrub.
    expect(buildDerivedSecretForms('X')).toEqual([])
    expect(buildDerivedSecretForms('XY')).toEqual([])
    expect(buildDerivedSecretForms('XYZ')).toEqual([])
  })

  test('covers all 4 forms: raw, Bearer, base64, Basic-base64', () => {
    const forms = buildDerivedSecretForms('hello')
    expect(forms).toContain('hello')
    expect(forms).toContain('Bearer hello')
    expect(forms).toContain('aGVsbG8=') // base64('hello')
    expect(forms).toContain('Basic aGVsbG8=')
    expect(forms.length).toBe(4)
  })

  test('M7: returns longest-first so callers do not need to sort', () => {
    const forms = buildDerivedSecretForms('hello')
    // Basic <base64> is longest, raw 'hello' is shortest
    for (let i = 1; i < forms.length; i++) {
      expect(forms[i]!.length).toBeLessThanOrEqual(forms[i - 1]!.length)
    }
  })
})

describe('scrubAllSecretForms', () => {
  test('redacts raw secret', () => {
    const forms = buildDerivedSecretForms('XSECRETXX')
    expect(scrubAllSecretForms('header: XSECRETXX', forms)).toBe('header: [REDACTED]')
  })

  test('redacts Bearer-prefixed secret (longest-first)', () => {
    const forms = buildDerivedSecretForms('TOK123')
    // The Bearer form should be matched FIRST so we don't end up with
    // 'Bearer [REDACTED]' (the unredacted 'Bearer' prefix lingering).
    const result = scrubAllSecretForms('Authorization: Bearer TOK123', forms)
    expect(result).toBe('Authorization: [REDACTED]')
  })

  test('redacts base64-form (server might echo Basic auth)', () => {
    const forms = buildDerivedSecretForms('user:pass')
    const b64 = Buffer.from('user:pass', 'utf8').toString('base64')
    const result = scrubAllSecretForms(`echoed: ${b64}`, forms)
    expect(result).toBe('echoed: [REDACTED]')
  })

  test('redacts Basic-base64-form', () => {
    const forms = buildDerivedSecretForms('mypass')
    const b64 = Buffer.from('mypass', 'utf8').toString('base64')
    expect(scrubAllSecretForms(`Auth: Basic ${b64}`, forms)).toBe('Auth: [REDACTED]')
  })

  test('redacts ALL occurrences', () => {
    // M7: secrets >= 4 chars are scrubbed; 'XX' is too short and returns
    // empty forms (DoS guard). Use a 4-char secret to verify all-occurrence
    // replacement.
    const forms = buildDerivedSecretForms('XKEY')
    expect(scrubAllSecretForms('XKEY-hello-XKEY', forms)).toBe(
      '[REDACTED]-hello-[REDACTED]',
    )
  })

  test('preserves non-secret strings', () => {
    const forms = buildDerivedSecretForms('SECRET')
    expect(scrubAllSecretForms('hello world', forms)).toBe('hello world')
  })

  test('handles empty inputs', () => {
    expect(scrubAllSecretForms('', buildDerivedSecretForms('X'))).toBe('')
    expect(scrubAllSecretForms('text', [])).toBe('text')
  })
})

describe('scrubResponseHeaders', () => {
  test('redacts Authorization header by NAME (case-insensitive)', () => {
    const forms = buildDerivedSecretForms('SECRET')
    const result = scrubResponseHeaders(
      { 'Content-Type': 'application/json', authorization: 'Bearer SECRET' },
      forms,
    )
    expect(result['authorization']).toBe('[REDACTED]')
    expect(result['Content-Type']).toBe('application/json')
  })

  test('redacts X-Api-Key header', () => {
    const forms = buildDerivedSecretForms('K')
    const result = scrubResponseHeaders({ 'x-api-key': 'K' }, forms)
    expect(result['x-api-key']).toBe('[REDACTED]')
  })

  test('redacts cookie / set-cookie / proxy-authorization / www-authenticate', () => {
    const forms = buildDerivedSecretForms('S')
    const result = scrubResponseHeaders(
      {
        cookie: 'session=abc',
        'set-cookie': 'token=xyz',
        'proxy-authorization': 'Bearer S',
        'www-authenticate': 'Bearer realm="x"',
      },
      forms,
    )
    expect(result['cookie']).toBe('[REDACTED]')
    expect(result['set-cookie']).toBe('[REDACTED]')
    expect(result['proxy-authorization']).toBe('[REDACTED]')
    expect(result['www-authenticate']).toBe('[REDACTED]')
  })

  test('scrubs secret-like values from non-sensitive headers (echo case)', () => {
    const forms = buildDerivedSecretForms('XSECRETXX')
    // Server echoes our auth into a non-sensitive header (defensive)
    const result = scrubResponseHeaders(
      { 'x-debug-echo': 'received header: Bearer XSECRETXX' },
      forms,
    )
    expect(result['x-debug-echo']).toBe('received header: [REDACTED]')
  })

  test('handles array-valued headers (set-cookie)', () => {
    const forms = buildDerivedSecretForms('X')
    const result = scrubResponseHeaders(
      { 'set-cookie': ['a', 'b'] },
      forms,
    )
    expect(result['set-cookie']).toBe('[REDACTED]')
  })

  test('handles empty / null / non-object input', () => {
    expect(scrubResponseHeaders(null, [])).toEqual({})
    expect(scrubResponseHeaders(undefined, [])).toEqual({})
    expect(scrubResponseHeaders('not-an-object', [])).toEqual({})
  })
})

describe('scrubAxiosError', () => {
  test('NEVER stringifies raw Error / AxiosError (would expose .config.headers)', () => {
    // Mimic an axios-like error with config.headers carrying Authorization
    class FakeAxiosError extends Error {
      config = { headers: { Authorization: 'Bearer XSECRETXX' } }
    }
    const e = new FakeAxiosError('Request failed with status code 401')
    const forms = buildDerivedSecretForms('XSECRETXX')
    const result = scrubAxiosError(e, forms)
    expect(result).not.toContain('XSECRETXX')
    expect(result).not.toContain('Bearer')
    // Should be a synthetic safe summary, not JSON.stringify of the error
    expect(result.startsWith('Request failed:')).toBe(true)
  })

  test('scrubs secret-derived strings in error.message', () => {
    const e = new Error('Bearer XSECRETXX failed')
    const forms = buildDerivedSecretForms('XSECRETXX')
    const result = scrubAxiosError(e, forms)
    expect(result).toBe('Request failed: [REDACTED] failed')
  })

  test('handles non-Error throwable', () => {
    expect(scrubAxiosError('boom', [])).toBe('Request failed (unknown error)')
    expect(scrubAxiosError({ status: 500 }, [])).toBe('Request failed (unknown error)')
  })
})

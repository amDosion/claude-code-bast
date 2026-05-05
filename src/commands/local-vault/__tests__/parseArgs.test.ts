import { describe, test, expect } from 'bun:test'
import { parseLocalVaultArgs } from '../parseArgs.js'

describe('parseLocalVaultArgs', () => {
  test('empty string → list', () => {
    expect(parseLocalVaultArgs('')).toEqual({ action: 'list' })
  })

  test('"list" → list', () => {
    expect(parseLocalVaultArgs('list')).toEqual({ action: 'list' })
  })

  test('set with key and value', () => {
    expect(parseLocalVaultArgs('set MY_KEY my-secret-value')).toEqual({
      action: 'set',
      key: 'MY_KEY',
      value: 'my-secret-value',
    })
  })

  test('set with value containing spaces', () => {
    expect(parseLocalVaultArgs('set MY_KEY value with spaces')).toEqual({
      action: 'set',
      key: 'MY_KEY',
      value: 'value with spaces',
    })
  })

  test('set without value → invalid', () => {
    const result = parseLocalVaultArgs('set MY_KEY')
    expect(result.action).toBe('invalid')
  })

  test('set without key → invalid', () => {
    const result = parseLocalVaultArgs('set')
    expect(result.action).toBe('invalid')
  })

  test('get without --reveal → reveal=false', () => {
    expect(parseLocalVaultArgs('get MY_KEY')).toEqual({
      action: 'get',
      key: 'MY_KEY',
      reveal: false,
    })
  })

  test('get with --reveal → reveal=true', () => {
    expect(parseLocalVaultArgs('get MY_KEY --reveal')).toEqual({
      action: 'get',
      key: 'MY_KEY',
      reveal: true,
    })
  })

  test('get without key → invalid', () => {
    const result = parseLocalVaultArgs('get')
    expect(result.action).toBe('invalid')
  })

  test('delete with key', () => {
    expect(parseLocalVaultArgs('delete MY_KEY')).toEqual({
      action: 'delete',
      key: 'MY_KEY',
    })
  })

  test('delete without key → invalid', () => {
    const result = parseLocalVaultArgs('delete')
    expect(result.action).toBe('invalid')
  })

  test('unknown sub-command → invalid', () => {
    const result = parseLocalVaultArgs('frobnicate')
    expect(result.action).toBe('invalid')
    if (result.action === 'invalid') {
      expect(result.reason).toContain('frobnicate')
    }
  })
})

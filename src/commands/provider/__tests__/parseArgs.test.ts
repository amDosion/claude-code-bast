import { describe, test, expect } from 'bun:test'
import { parseProviderArgs } from '../parseArgs.js'

describe('parseProviderArgs', () => {
  test('empty string returns list', () => {
    expect(parseProviderArgs('')).toEqual({ action: 'list' })
  })

  test('"list" returns list', () => {
    expect(parseProviderArgs('list')).toEqual({ action: 'list' })
  })

  test('whitespace returns list', () => {
    expect(parseProviderArgs('   ')).toEqual({ action: 'list' })
  })

  test('"show" returns show', () => {
    expect(parseProviderArgs('show')).toEqual({ action: 'show' })
  })

  test('"add" returns add', () => {
    expect(parseProviderArgs('add')).toEqual({ action: 'add' })
  })

  test('"use cerebras" returns use with id', () => {
    expect(parseProviderArgs('use cerebras')).toEqual({
      action: 'use',
      id: 'cerebras',
    })
  })

  test('"use groq" returns use with id', () => {
    expect(parseProviderArgs('use groq')).toEqual({ action: 'use', id: 'groq' })
  })

  test('"use deepseek" returns use with id', () => {
    expect(parseProviderArgs('use deepseek')).toEqual({
      action: 'use',
      id: 'deepseek',
    })
  })

  test('"use" without id returns invalid', () => {
    const result = parseProviderArgs('use')
    expect(result.action).toBe('invalid')
    if (result.action === 'invalid') {
      expect(result.reason).toContain('use requires a provider id')
    }
  })

  test('unknown subcommand returns invalid', () => {
    const result = parseProviderArgs('frobnicate')
    expect(result.action).toBe('invalid')
    if (result.action === 'invalid') {
      expect(result.reason).toContain('frobnicate')
    }
  })

  test('"use  myid  " trims whitespace', () => {
    expect(parseProviderArgs('use  myid  ')).toEqual({
      action: 'use',
      id: 'myid',
    })
  })
})

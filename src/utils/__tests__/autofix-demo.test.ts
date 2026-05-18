import { describe, expect, test } from 'bun:test'

describe('autofix-demo', () => {
  test('intentional type error to trigger CI failure', () => {
    const value: string = '42'
    expect(value).toBeDefined()
  })
})

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { attachUdsResponseReader } from '../udsResponseReader.js'

class FakeSocket extends EventEmitter {
  destroyed = false
  ended = false

  destroy(): this {
    this.destroyed = true
    this.emit('close', true)
    return this
  }

  end(): this {
    this.ended = true
    this.emit('close', false)
    return this
  }

  emitData(chunk: Buffer): void {
    this.emit('data', chunk)
  }
}

function asSocket(socket: FakeSocket): Socket {
  return socket as unknown as Socket
}

describe('attachUdsResponseReader', () => {
  test('tracks byte limits across split multibyte response chunks', () => {
    const socket = new FakeSocket()
    let settled = false
    let settledError: Error | undefined

    attachUdsResponseReader(asSocket(socket), {
      maxFrameBytes: 128,
      onSettled: error => {
        settled = true
        settledError = error
      },
    })

    const multibyte = String.fromCodePoint(0x20ac)
    const frame = Buffer.from(
      JSON.stringify({ type: 'response', data: `ok ${multibyte}` }) + '\n',
      'utf8',
    )
    const multibyteStart = frame.indexOf(Buffer.from(multibyte, 'utf8')[0])

    socket.emitData(frame.subarray(0, multibyteStart + 1))
    expect(settled).toBe(false)

    socket.emitData(frame.subarray(multibyteStart + 1))
    expect(settled).toBe(true)
    expect(settledError).toBeUndefined()
    expect(socket.ended).toBe(true)
  })

  test('rejects malformed response frames immediately', () => {
    const socket = new FakeSocket()
    let settledError: Error | undefined

    attachUdsResponseReader(asSocket(socket), {
      maxFrameBytes: 128,
      onSettled: error => {
        settledError = error
      },
    })

    socket.emitData(Buffer.from('{bad-json}\n'))

    expect(settledError?.message).toBe('Invalid UDS response frame')
    expect(socket.destroyed).toBe(true)
  })
})

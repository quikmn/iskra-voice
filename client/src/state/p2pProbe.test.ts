// The direct-address probe before a tunnel: whether it answered, why not (as a log word), and how long it took.
import { describe, expect, it } from 'vitest'
import { probeDirect } from './p2p'

const clock = (...times: number[]) => () => times.shift() ?? 0
const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('probeDirect', () => {
  it('ok when an Iskra server answers', async () => {
    expect(await probeDirect('http://203.0.113.5:47070', answer(200, { iskra: 1 }), clock(100, 342))).toEqual({ ok: true, took: 242 })
  })

  it('says why not, in words that carry no address', async () => {
    expect(await probeDirect('http://x', answer(502, {}), clock(0, 10))).toEqual({ ok: false, why: 'http-502', took: 10 })
    expect(await probeDirect('http://x', answer(200, { hello: 1 }), clock(0, 10))).toEqual({ ok: false, why: 'not-iskra', took: 10 })
    const timeout = (async () => { throw new DOMException('The operation timed out.', 'TimeoutError') }) as unknown as typeof fetch
    expect(await probeDirect('http://x', timeout, clock(0, 2500))).toEqual({ ok: false, why: 'timeout', took: 2500 })
    const refused = (async () => { throw new TypeError('Failed to fetch 203.0.113.5') }) as unknown as typeof fetch
    expect(await probeDirect('http://x', refused, clock(0, 30))).toEqual({ ok: false, why: 'unreachable', took: 30 })
  })
})

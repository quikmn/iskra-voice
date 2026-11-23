import { describe, expect, it, vi } from 'vitest'

// As @capacitor/core's registerPlugin: every property is a method that calls the native side, and one the native
// side doesn't have ("then") fails later without calling what it was given.
const calls: string[] = []
function capacitorLikePlugin(): object {
  return new Proxy({}, {
    get: (_, prop) => (...args: unknown[]) => {
      calls.push(String(prop))
      if (prop === 'voiceStart') return Promise.resolve(args[0])
      const failed = Promise.reject(new Error(`"IskraNative.${String(prop)}()" is not implemented on android`))
      failed.catch(() => undefined)
      return failed
    },
  })
}
vi.mock('@capacitor/core', () => ({ registerPlugin: () => capacitorLikePlugin() }))

const settles = (p: Promise<unknown>) => Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 50))])

describe('the phone app plugin', () => {
  it('a promise resolved with a Capacitor plugin never settles (why it is never returned through one)', async () => {
    expect(await settles(Promise.resolve().then(() => capacitorLikePlugin()))).toBe('pending')
  })

  it('reaches the native method', async () => {
    const { withPlugin } = await import('./nativePlugin')
    calls.length = 0
    const options = { title: 'In voice: lounge', call: false, video: false }
    expect(await settles(withPlugin((p) => p.voiceStart(options)))).toBe('settled')
    expect(calls).toEqual(['voiceStart'])
    await expect(withPlugin((p) => p.voiceStart(options))).resolves.toBe(options)
  })
})

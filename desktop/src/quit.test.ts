import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { logUncaughtErrors, settleWithin } from './quit'

test('settleWithin: resolves when the work finishes, fails, or takes too long', async () => {
  let t = Date.now()
  await settleWithin(Promise.resolve('done'), 5000)
  assert.ok(Date.now() - t < 1000)
  t = Date.now()
  await settleWithin(Promise.reject(new Error('server gone')), 5000) // never rejects itself
  assert.ok(Date.now() - t < 1000)
  t = Date.now()
  await settleWithin(new Promise(() => undefined), 50) // never settles: the app quits anyway
  assert.ok(Date.now() - t >= 40)
})

test('logUncaughtErrors: late errors are logged, once per process', () => {
  const proc = new EventEmitter()
  const logged: unknown[] = []
  logUncaughtErrors(proc as unknown as NodeJS.Process, (e) => logged.push(e))
  logUncaughtErrors(proc as unknown as NodeJS.Process, (e) => logged.push(e))
  assert.equal(proc.listenerCount('uncaughtException'), 1)
  const late = new TypeError('Object has been destroyed')
  proc.emit('uncaughtException', late)
  assert.deepEqual(logged, [late])
})

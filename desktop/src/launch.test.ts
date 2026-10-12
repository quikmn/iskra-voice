import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DESKTOP_TEXT } from './i18n'
import { initialLaunch, launchProgress, launchStep, readyToShow, splashView, updatedTo, updatingView, type LaunchState } from './launch'
import { DEFAULT_DESKTOP_SETTINGS, isVersion, parseDesktopSettings } from './platform'

const t = DESKTOP_TEXT.en.splash
const at = (s: LaunchState, next: Partial<LaunchState>): LaunchState => ({ ...s, ...next })

test('launch steps without hosted servers: starting, connecting, ready', () => {
  let s = initialLaunch(0)
  assert.equal(launchStep(s), 'starting')
  assert.equal(readyToShow(s), false)
  s = at(s, { page: 'loaded' })
  assert.equal(launchStep(s), 'connecting')
  s = at(s, { page: 'ready' })
  assert.equal(launchStep(s), 'ready')
  assert.equal(readyToShow(s), true)
  assert.equal(launchProgress(s), 1)
})

test('launch steps with hosted servers: the window waits for them, or until we stop waiting', () => {
  let s = at(initialLaunch(2), { page: 'ready' })
  assert.equal(launchStep(s), 'servers')
  assert.equal(readyToShow(s), false)
  s = at(s, { servers: { total: 2, done: 1 } })
  assert.equal(launchStep(s), 'servers')
  s = at(s, { servers: { total: 2, done: 2 } })
  assert.equal(readyToShow(s), true)
  // A slow server: after a while the app shows anyway.
  const slow = at(initialLaunch(1), { page: 'ready', serversGaveUp: true })
  assert.equal(readyToShow(slow), true)
  // Servers up but the page still loading: not ready, and no longer "starting your servers".
  const early = at(initialLaunch(1), { servers: { total: 1, done: 1 } })
  assert.equal(launchStep(early), 'starting')
  assert.equal(readyToShow(early), false)
})

test('progress only moves left to right, from a little to full', () => {
  const steps: LaunchState[] = [
    initialLaunch(2),
    at(initialLaunch(2), { servers: { total: 2, done: 1 } }),
    at(initialLaunch(2), { servers: { total: 2, done: 1 }, page: 'loaded' }),
    at(initialLaunch(2), { servers: { total: 2, done: 2 }, page: 'loaded' }),
    at(initialLaunch(2), { servers: { total: 2, done: 2 }, page: 'ready' }),
  ]
  const values = steps.map(launchProgress)
  assert.ok(values[0] > 0 && values[0] < 0.2, 'something shows straight away')
  for (let i = 1; i < values.length; i++) assert.ok(values[i] > values[i - 1], `step ${i} moves forward`)
  assert.equal(values.at(-1), 1)
  for (const v of values) assert.ok(v >= 0 && v <= 1)
  // Servers that report "done" too often never push it past its share.
  assert.ok(launchProgress(at(initialLaunch(1), { servers: { total: 1, done: 5 } })) < 1)
  assert.ok(launchProgress(initialLaunch(-3)) > 0)
})

test('"Updated to X" only after moving to a newer version', () => {
  assert.equal(updatedTo('2.0.0-alpha.12', '2.0.0-alpha.13'), '2.0.0-alpha.13')
  assert.equal(updatedTo('2.0.0-alpha.13', '2.0.0'), '2.0.0')
  assert.equal(updatedTo('1.9.9', '2.0.0'), '2.0.0')
  assert.equal(updatedTo(null, '2.0.0'), null) // first run
  assert.equal(updatedTo('2.0.0', '2.0.0'), null) // same version
  assert.equal(updatedTo('2.0.1', '2.0.0'), null) // a downgrade isn't an update
  assert.equal(updatedTo('nonsense', '2.0.0'), null)
  assert.equal(updatedTo('2.0.0', 'nonsense'), null)
})

test('the last-run version is stored only when it is a version', () => {
  assert.equal(DEFAULT_DESKTOP_SETTINGS.lastRunVersion, null)
  assert.equal(parseDesktopSettings({ lastRunVersion: '2.0.0-alpha.12' }).lastRunVersion, '2.0.0-alpha.12')
  for (const bad of ['v2.0.0', '2.0', '<b>2.0.0</b>', 7, null, '1.0.0-' + 'x'.repeat(80)]) assert.equal(parseDesktopSettings({ lastRunVersion: bad }).lastRunVersion, null)
  assert.equal(isVersion('2.0.0-alpha.12'), true)
})

test('splash text: the heading, the step, and the update notice', () => {
  const s = initialLaunch(1)
  assert.deepEqual(splashView(s, null, t), { heading: 'Iskra', status: 'Starting your servers…', progress: launchProgress(s) })
  assert.equal(splashView(s, '2.0.0', t).heading, 'Updated to 2.0.0')
  assert.equal(splashView(at(s, { page: 'loaded', serversGaveUp: true }), null, t).status, 'Connecting…')
  assert.deepEqual(updatingView('2.1.0', t), { heading: 'Updating Iskra to 2.1.0…', status: "It'll be back in a few seconds.", progress: null })
  assert.equal(splashView(initialLaunch(0), '2.0.0', DESKTOP_TEXT.sv.splash).heading, 'Uppdaterad till 2.0.0')
})

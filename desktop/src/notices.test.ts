import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseNoticeAction, updateCheckNotice } from './notices'

test('"Check for updates" tells the page what it found, never pre-translated text', () => {
  assert.deepEqual(updateCheckNotice('found', { state: 'downloading', version: '2.1.0' }, '2.0.0'), { kind: 'update-check', result: 'found', version: '2.1.0' })
  assert.deepEqual(updateCheckNotice('up-to-date', { state: 'none' }, '2.0.0'), { kind: 'update-check', result: 'up-to-date', version: '2.0.0' })
  assert.deepEqual(updateCheckNotice('off', { state: 'none' }, '2.0.0'), { kind: 'update-check', result: 'off', version: '2.0.0' })
  assert.deepEqual(updateCheckNotice('failed', { state: 'none' }, '2.0.0'), { kind: 'update-check', result: 'failed', version: '2.0.0' })
  // A result that somehow comes without a version in the status still names the running one.
  assert.deepEqual(updateCheckNotice('found', { state: 'none' }, '2.0.0'), { kind: 'update-check', result: 'found', version: '2.0.0' })
})

test('only the replies a notice really has', () => {
  assert.deepEqual(parseNoticeAction('screen-permission', 'open-settings'), { kind: 'screen-permission', action: 'open-settings' })
  assert.deepEqual(parseNoticeAction('about', 'licenses'), { kind: 'about', action: 'licenses' })
  for (const [kind, action] of [
    ['screen-permission', 'licenses'], ['about', 'open-settings'], ['update-check', 'open-settings'], ['toString', 'licenses'], ['__proto__', 'licenses'],
    [42, 'licenses'], ['about', null], [null, null],
  ]) assert.equal(parseNoticeAction(kind, action), null, `${String(kind)} ${String(action)}`)
})

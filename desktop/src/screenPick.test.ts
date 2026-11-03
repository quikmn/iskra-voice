import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScreenPicks } from './screenPick'

test('two screen-share requests at once never take each other’s answer', async () => {
  const picks = new ScreenPicks()
  const shown: number[] = []
  const first = picks.ask((id) => shown.push(id))
  const second = picks.ask((id) => shown.push(id))
  assert.equal(await first, null) // replaced by the newer request
  picks.answer(shown[0], 'screen:1') // a late answer to the old one: ignored
  picks.answer(shown[1], 'window:2')
  assert.equal(await second, 'window:2')
  picks.answer(shown[1], 'screen:3') // answered already
  const third = picks.ask(() => undefined)
  picks.cancel()
  assert.equal(await third, null)
  const fourth = picks.ask((id) => picks.answer(id, 42))
  assert.equal(await fourth, null) // not an id
})

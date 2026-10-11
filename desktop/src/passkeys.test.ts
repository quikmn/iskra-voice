import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { ceremonyScript, parseCreate, parseGet, passkeyPage } from './passkeys'

const create = {
  rpId: 'app.iskra.foo', userId: 'AAAAAAAAAAAAAAAAAAAAAA', userName: 'Iskra · Ada', displayName: 'Ada',
  challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', exclude: [], prfSalt: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
}

test('passkey requests are checked before a ceremony runs', () => {
  assert.deepEqual(parseCreate(create), create)
  // Only app.iskra.foo's passkeys, only base64url bytes, no control characters in names.
  assert.equal(parseCreate({ ...create, rpId: 'evil.example' }), null)
  assert.equal(parseCreate({ ...create, prfSalt: 'not base64!' }), null)
  assert.equal(parseCreate({ ...create, userName: 'a\nb' }), null)
  assert.equal(parseCreate({ ...create, exclude: Array(21).fill('AAAA') }), null)
  assert.deepEqual(parseGet({ rpId: 'app.iskra.foo', challenge: 'AAAA', salts: { AAAA: 'AQEB' } }), { rpId: 'app.iskra.foo', challenge: 'AAAA', salts: { AAAA: 'AQEB' } })
  assert.equal(parseGet({ rpId: 'app.iskra.foo', challenge: 'AAAA', salts: {} }), null)
  assert.equal(parseGet({ rpId: 'app.iskra.foo', challenge: 'AAAA', salts: { 'x"y': 'AQEB' } }), null)
})

test('the request reaches the page as JSON data, never as code', () => {
  const script = ceremonyScript('create', { ...create, displayName: "Ada'); alert(1); ('" })
  assert.ok(script.includes(JSON.stringify("Ada'); alert(1); ('")))
  assert.ok(!passkeyPage('<b>', '<script>').includes('<script>'))
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { friendKeyPair, hostKeyHex, hostKeyPair, onlyFriends, parseSecret, seed } from './keys'

// The same vector as the server's P2pTests.Keys_derive_exactly_as_the_desktop_app_derives_them.
const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))

test('derives the host and friend keys from the secret, like the server does', () => {
  assert.equal(seed(secret, 'iskra/p2p/v1/host-seed').toString('hex'), '4f36d1a0830dda1df53248fb70b7e0ab13b8d0af3ee45f68cd8508a7c85add86')
  assert.equal(hostKeyHex(secret), '71b61f4c35ce6e8f87eb58793b6fcdcebf6a42b7435f70f2b4c6fab4b541ae30')
  assert.equal(friendKeyPair(secret).publicKey.toString('hex'), '863e296ec785d46650d78089ab2e82654f494cbeaada13c83bee6d7fedb37e5a')
  assert.notEqual(hostKeyPair(secret).publicKey.toString('hex'), friendKeyPair(secret).publicKey.toString('hex'))
  assert.throws(() => seed(secret.subarray(1), 'x'))
})

test('the host accepts the friend key of its secret and nobody else', () => {
  const allow = onlyFriends(secret)
  assert.equal(allow(friendKeyPair(secret).publicKey), true)
  assert.equal(allow(hostKeyPair(secret).publicKey), false)
  const other = Buffer.from(Array.from({ length: 32 }, (_, i) => 32 - i))
  assert.equal(allow(friendKeyPair(other).publicKey), false)
})

test('reads a secret as invite links carry it', () => {
  assert.deepEqual(parseSecret(secret.toString('base64url')), secret)
  assert.equal(parseSecret(secret.toString('base64url') + 'A'), null)
  assert.equal(parseSecret('short'), null)
  assert.equal(parseSecret(42), null)
  assert.equal(parseSecret(null), null)
})

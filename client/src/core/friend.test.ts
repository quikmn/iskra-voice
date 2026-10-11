import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, ready } from './crypto'
import { createIdentity } from './identity'
import { checkFriend, signFriend, MAX_FUTURE_MS } from './friend'
import { decryptDm, encryptDm } from './dm'

beforeAll(ready)

describe('friend actions', () => {
  it('a signed action checks out between its two people', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const bobKey = b64u(bob.account.publicKey)
    const action = signFriend(alice, 'request', bobKey, 1_000)
    expect(checkFriend(action, action.from, bobKey, 2_000)).toEqual(action)
  })

  it('nobody can forge an accept: a wrong signer, edited fields or a moved action fail', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const mallory = createIdentity()
    const [a, b, m] = [alice, bob, mallory].map((i) => b64u(i.account.publicKey))
    const accept = signFriend(bob, 'accept', a, 1_000)

    // Mallory signs an "accept" claiming to be Bob.
    const forged = { ...signFriend(mallory, 'accept', a, 1_000), from: b }
    expect(checkFriend(forged, b, a, 2_000)).toBeNull()
    // Bob's real request can't be turned into an accept, or re-timed.
    const request = signFriend(bob, 'request', a, 1_000)
    expect(checkFriend({ ...request, kind: 'accept' }, b, a, 2_000)).toBeNull()
    expect(checkFriend({ ...accept, at: 5_000 }, b, a, 6_000)).toBeNull()
    // Bob's accept to Alice can't be replayed to Mallory, nor sent by Mallory as if from Bob.
    expect(checkFriend(accept, b, m, 2_000)).toBeNull()
    expect(checkFriend(accept, m, a, 2_000)).toBeNull()
    expect(checkFriend({ ...accept, to: m }, b, m, 2_000)).toBeNull()
  })

  it('rejects malformed actions and ones from the future', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const bobKey = b64u(bob.account.publicKey)
    const action = signFriend(alice, 'remove', bobKey, 1_000)
    for (const bad of [null, 'x', [], { ...action, kind: 'befriend' }, { ...action, id: '' }, { ...action, at: -1 }, { ...action, sig: 'AA' }])
      expect(checkFriend(bad, action.from, bobKey, 2_000)).toBeNull()
    const future = signFriend(alice, 'request', bobKey, 10_000 + MAX_FUTURE_MS + 1)
    expect(checkFriend(future, future.from, bobKey, 10_000)).toBeNull()
  })

  it('rides inside an encrypted DM and comes out intact', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const [a, b] = [alice, bob].map((i) => b64u(i.account.publicKey))
    const action = signFriend(alice, 'request', b)
    const envelope = encryptDm(alice, b, [bob.cert], [], { text: 'Sent you a friend request.', friend: { ...action } })
    const opened = decryptDm(bob, envelope, a, b)
    expect(checkFriend(opened.friend, a, b)).toEqual(action)
  })
})

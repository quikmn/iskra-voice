import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, fromB64u, ready, sign, signedPayload } from './crypto'
import { generatePrekey, signPrekey } from './devices'
import {
  asRename, decryptGroup, encryptGroup, GROUP_CHANGE_CONTEXT, GroupBehindError, newGroupId, signChange, verifyChain,
  type GroupChange, type GroupEnvelope, type GroupView, type MemberBundle,
} from './group'
import { createIdentity, type Identity } from './identity'

beforeAll(ready)

const key = (id: Identity) => b64u(id.account.publicKey)
const bundle = (...ids: Identity[]): MemberBundle[] => ids.map((id) => ({ accountKey: key(id), devices: [id.cert] }))

/** A change with any body, signed by `by` (for building forgeries the honest signer would refuse). */
function forge(by: Identity, body: Record<string, unknown>): GroupChange {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return { payload: b64u(bytes), sig: b64u(sign(signedPayload(GROUP_CHANGE_CONTEXT, bytes), by.account.secretKey)) }
}

function setup() {
  const [alice, bob, carol, dave] = [createIdentity(), createIdentity(), createIdentity(), createIdentity()]
  const id = newGroupId()
  const create = signChange(alice, null, id, 'create', [key(bob), key(carol)])
  const view = verifyChain(id, [create])
  return { alice, bob, carol, dave, id, create, view }
}

const route = (env: GroupEnvelope) => ({ group: env.header.group, from: env.header.from, version: env.header.version })

describe('group membership chain', () => {
  it('verifies a creation, adds, removals and leaving', () => {
    const { alice, bob, carol, dave, id, create, view } = setup()
    expect(view.members).toEqual([key(alice), key(bob), key(carol)])
    const add = signChange(bob, view, id, 'add', [key(dave)])
    const v2 = verifyChain(id, [add], view)
    expect(v2.members).toEqual([key(alice), key(bob), key(carol), key(dave)])
    const remove = signChange(alice, v2, id, 'remove', [key(carol)])
    const leave = signChange(alice, verifyChain(id, [remove], v2), id, 'leave', [key(alice)])
    const v4 = verifyChain(id, [create, add, remove, leave])
    expect(v4.version).toBe(4)
    // The owner left: Bob is now the longest-standing member and may remove people.
    expect(v4.members).toEqual([key(bob), key(dave)])
    expect(() => signChange(bob, v4, id, 'remove', [key(dave)])).not.toThrow()
    expect(() => signChange(dave, v4, id, 'remove', [key(bob)])).toThrow(/owner/)
  })

  it('refuses a member the server (or anyone) added without a member signing it', () => {
    const { bob, dave, id, view } = setup()
    // Dave signs his own way in: he isn't a member, so it doesn't count.
    const selfAdd = forge(dave, { v: 1, group: id, version: 2, prev: view.head, by: key(dave), action: 'add', targets: [key(dave)], members: [...view.members, key(dave)], at: Date.now() })
    expect(() => verifyChain(id, [selfAdd], view)).toThrow(/outside the group/)
    // A member's signature over a different body doesn't carry over.
    const real = signChange(bob, view, id, 'add', [key(dave)])
    const tampered = { ...real, payload: b64u(new TextEncoder().encode(new TextDecoder().decode(fromB64u(real.payload)).replace('"add"', '"add" '))) }
    expect(() => verifyChain(id, [tampered], view)).toThrow(/signed/)
    // A member list that doesn't match the action.
    const sneaky = forge(bob, { v: 1, group: id, version: 2, prev: view.head, by: key(bob), action: 'add', targets: [], members: [...view.members, key(dave)], at: Date.now() })
    expect(() => verifyChain(id, [sneaky], view)).toThrow()
  })

  it('refuses rewritten history, changes from other groups, and gaps', () => {
    const { alice, bob, carol, dave, id, create, view } = setup()
    const other = newGroupId()
    const foreign = signChange(alice, verifyChain(other, [signChange(alice, null, other, 'create', [key(bob), key(carol)])]), other, 'add', [key(dave)])
    expect(() => verifyChain(id, [create, foreign])).toThrow()
    const add = signChange(bob, view, id, 'add', [key(dave)])
    const v2 = verifyChain(id, [add], view)
    const v3 = verifyChain(id, [signChange(alice, v2, id, 'remove', [key(dave)])], v2)
    // Skipping a change, or replaying an old one on top, breaks the hash links.
    expect(() => verifyChain(id, [create, signChange(alice, v2, id, 'remove', [key(dave)])])).toThrow(/fit together/)
    expect(() => verifyChain(id, [add], v3)).toThrow(/fit together/)
    // Two people, too few for a group.
    expect(() => signChange(alice, null, newGroupId(), 'create', [key(bob)])).toThrow()
  })
})

describe('group messages', () => {
  it('every member reads it, with forward-secret slots where devices have prekeys', () => {
    const { alice, bob, carol, view } = setup()
    const bobPrekey = generatePrekey()
    bob.prekeys = [bobPrekey]
    const env = encryptGroup(alice, view, bundle(alice, bob, carol), { text: 'hi all' }, Date.now(), { prekeys: [signPrekey(bob, bobPrekey)] })
    expect(env.keys).toHaveLength(3)
    expect(env.keys.find((k) => k.device === bob.cert.deviceKey)).toHaveProperty('seal')
    for (const reader of [alice, bob, carol]) expect(decryptGroup(reader, env, route(env), view).text).toBe('hi all')
  })

  it('encrypts only to the verified member list, whatever devices the server hands over', () => {
    const { alice, bob, carol, dave, view } = setup()
    const env = encryptGroup(alice, view, bundle(alice, bob, carol, dave), { text: 'not for Dave' })
    expect(env.keys.map((k) => k.device)).not.toContain(dave.cert.deviceKey)
    expect(() => decryptGroup(dave, env, route(env), view)).toThrow(/this device/)
    // Bob's bundle with Dave's device in it doesn't help Dave either.
    const mixed = encryptGroup(alice, view, [{ accountKey: key(bob), devices: [bob.cert, dave.cert] }, ...bundle(carol)], { text: 'x' })
    expect(mixed.keys.map((k) => k.device)).not.toContain(dave.cert.deviceKey)
  })

  it("can't be moved to another group or another version, or come from a non-member", () => {
    const { alice, bob, carol, dave, id, view } = setup()
    const env = encryptGroup(alice, view, bundle(alice, bob, carol), { text: 'secret' })
    expect(() => decryptGroup(bob, env, { ...route(env), group: newGroupId() }, view)).toThrow(/another conversation/)
    const moved = { ...env, header: { ...env.header, group: newGroupId() } }
    expect(() => decryptGroup(bob, moved, route(moved), { ...view, id: moved.header.group })).toThrow()
    expect(() => decryptGroup(bob, env, { ...route(env), from: key(carol) }, view)).toThrow(/doesn't match/)

    // A newer version than we know: fetch the chain first.
    const v2 = verifyChain(id, [signChange(alice, view, id, 'add', [key(dave)])], view)
    const newer = encryptGroup(alice, v2, bundle(alice, bob, carol, dave), { text: 'welcome Dave' })
    expect(() => decryptGroup(bob, newer, route(newer), view)).toThrow(GroupBehindError)
    expect(decryptGroup(bob, newer, route(newer), v2).text).toBe('welcome Dave')
    // A head that isn't the one in our chain (a forked member list) is refused.
    const fork: GroupView = { ...v2, changes: v2.changes.map((c) => (c.version === 2 ? { ...c, head: 'x'.repeat(43) } : c)) }
    expect(() => decryptGroup(bob, newer, route(newer), fork)).toThrow(/never had/)

    // Dave signing a message to version 1 (before he joined) isn't accepted, even with his slot in it.
    const outsider = encryptGroup(dave, { ...view, members: [...view.members, key(dave)] }, bundle(alice, bob, carol, dave), { text: 'let me in' })
    expect(() => decryptGroup(bob, outsider, route(outsider), view)).toThrow(/wasn't in the group/)
  })

  it('carries renames, checked', () => {
    const { alice, bob, carol, view } = setup()
    const env = encryptGroup(alice, view, bundle(alice, bob, carol), { text: 'Alice named the group', group: { kind: 'rename', name: ' Trip ' } })
    expect(asRename(decryptGroup(carol, env, route(env), view).group)).toEqual({ kind: 'rename', name: 'Trip' })
    expect(asRename({ kind: 'rename', name: 'x'.repeat(65) })).toBeNull()
    expect(asRename({ kind: 'other' })).toBeNull()
  })
})

describe('group chains across account key rotations', () => {
  it("accepts a member's new key once the rotation is known, and keeps checking the old changes", async () => {
    const { setGroupKeyResolver } = await import('./group')
    const { alice, bob, carol, dave, id, create } = setup()
    const bobNew = createIdentity()
    // Without the rotation, Bob's new key is a stranger.
    expect(() => verifyChain(id, [create, signChange(bobNew, verifyChain(id, [create]), id, 'add', [key(dave)])])).toThrow()
    setGroupKeyResolver((k) => (k === key(bob) ? key(bobNew) : k))
    try {
      const view = verifyChain(id, [create])
      const add = signChange(bobNew, view, id, 'add', [key(dave)])
      const v2 = verifyChain(id, [create, add])
      expect(v2.members).toEqual([key(alice), key(bobNew), key(carol), key(dave)])
      // Messages from either key of Bob's are his.
      const env = encryptGroup(bobNew, v2, bundle(alice, bobNew, carol, dave), { text: 'new key, same me' })
      expect(decryptGroup(alice, env, route(env), v2).text).toBe('new key, same me')
      // The owner can still remove Bob, under his new key.
      expect(() => signChange(alice, v2, id, 'remove', [key(bobNew)])).not.toThrow()
    } finally {
      setGroupKeyResolver((k) => k)
    }
  })
})

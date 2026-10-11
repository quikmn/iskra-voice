import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, generateSigningKeyPair, ready, sign, type SigningKeyPair } from './crypto'
import { createIdentity } from './identity'
import {
  checkGossip, compareGossip, emptyView, entryHash, extendView, headPayload, LogError, lookalikes, signGossip, splitViews, unloggedKeys,
  type LogHead, type LogView, type WireLogEntry,
} from './keylog'
import { KeyMap, signRotation } from './rotation'

beforeAll(ready)

/** A server's key log, built the way the .NET server builds it (KeyLogFeature.cs). */
class FakeLog {
  entries: WireLogEntry[] = []
  hash: Uint8Array = new Uint8Array(32)
  at = 1_760_000_000_000
  readonly server: SigningKeyPair
  constructor(server: SigningKeyPair = generateSigningKeyPair()) {
    this.server = server
  }
  get serverKey() { return b64u(this.server.publicKey) }
  append(entry: object): this {
    const seq = this.entries.length + 1
    const data = JSON.stringify({ ...entry, at: ++this.at })
    this.hash = entryHash(this.hash, seq, data)
    this.entries.push({ seq, data })
    return this
  }
  join(key: string, name: string) { return this.append({ kind: 'join', key, name }) }
  head(): LogHead {
    const head = { seq: this.entries.length, hash: b64u(this.hash), at: this.at }
    return { ...head, sig: b64u(sign(headPayload(this.server.publicKey, head), this.server.secretKey)) }
  }
  /** A copy that shares the history so far (a server about to show two people different things). */
  fork(): FakeLog {
    const copy = new FakeLog(this.server)
    copy.entries = [...this.entries]
    copy.hash = this.hash
    copy.at = this.at
    return copy
  }
}

const key = () => b64u(generateSigningKeyPair().publicKey)
const sync = (view: LogView, log: FakeLog) => extendView(view, log.head(), log.entries).view

describe('key log', () => {
  it('hashes entries exactly like the server (KeyLogTests has the same vector)', () => {
    expect(b64u(entryHash(new Uint8Array(32), 1, '{"kind":"join","at":1,"key":"x","name":"Åsa"}'))).toBe('HDAGcWbJZWJdv3SdvbSOkFgjcLtQ23ByiJ6Ws9qM9_4')
  })

  it('follows a correctly signed chain and remembers who joined and moved', () => {
    const [alice, bob] = [generateSigningKeyPair(), key()]
    const next = generateSigningKeyPair()
    const rotation = signRotation(alice, next)
    const log = new FakeLog().join(b64u(alice.publicKey), 'Alice').join(bob, 'Bob').append({ kind: 'rotate', rotation })
    const view = sync(emptyView(log.serverKey), log)
    expect(view.head.seq).toBe(3)
    expect(view.names).toEqual({ [bob]: 'Bob', [rotation.newKey]: 'Alice' })
    expect(view.rotations[rotation.oldKey]).toBe(rotation.newKey)
    // Members the log explains pass; a key it never logged doesn't.
    const forged = key()
    expect(unloggedKeys(view, [bob, rotation.newKey, forged])).toEqual([forged])

    // Later entries extend it; asking again with the same head changes nothing.
    log.append({ kind: 'name', key: bob, name: 'Robert' })
    const later = extendView(view, log.head(), log.entries.slice(3))
    expect(later.added).toHaveLength(1)
    expect(later.view.names[bob]).toBe('Robert')
    expect(extendView(later.view, log.head(), []).added).toEqual([])
  })

  it('catches rollbacks, forks, gaps, bad signatures and forged rotations', () => {
    const log = new FakeLog().join(key(), 'A').join(key(), 'B')
    const view = sync(emptyView(log.serverKey), log)
    const problem = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return (e as LogError).problem
      }
      return 'none'
    }

    // An older head than the one the server already signed for us.
    expect(problem(() => extendView(view, signedHead(log, 1, log.entries[0]), []))).toBe('rollback')
    // Same position, different history.
    const other = new FakeLog(log.server).join(key(), 'A').join(key(), 'Mallory')
    expect(problem(() => extendView(view, other.head(), []))).toBe('fork')
    // A history rewritten underneath, presented as a longer log.
    other.join(key(), 'C')
    expect(problem(() => extendView(view, other.head(), other.entries))).toBe('fork')
    // Missing entries, an unsigned head, another server's signature, a rotation nobody signed.
    log.join(key(), 'C').join(key(), 'D')
    expect(problem(() => extendView(view, log.head(), log.entries.slice(3)))).toBe('gap')
    expect(problem(() => extendView(view, { ...log.head(), sig: log.head().sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }, log.entries))).toBe('bad-signature')
    expect(problem(() => extendView(emptyView(key()), log.head(), log.entries))).toBe('bad-signature')
    const bad = new FakeLog(log.server).append({ kind: 'rotate', rotation: { ...signRotation(generateSigningKeyPair(), generateSigningKeyPair()), newSig: b64u(new Uint8Array(64)) } })
    expect(problem(() => extendView(emptyView(bad.serverKey), bad.head(), bad.entries))).toBe('bad-entry')
  })

  it('notices servers that disagree about where an account went', () => {
    const alice = generateSigningKeyPair()
    const real = signRotation(alice, generateSigningKeyPair())
    const thief = signRotation(alice, generateSigningKeyPair())
    const a = new FakeLog().join(real.oldKey, 'Alice').append({ kind: 'rotate', rotation: real })
    const b = new FakeLog().join(thief.oldKey, 'Alice').append({ kind: 'rotate', rotation: thief })
    const c = new FakeLog().join(real.oldKey, 'Alice').append({ kind: 'rotate', rotation: real })
    const views = [a, b, c].map((log) => sync(emptyView(log.serverKey), log))
    expect(splitViews(views)).toEqual([{ oldKey: real.oldKey, claims: { [real.newKey]: [a.serverKey, c.serverKey], [thief.newKey]: [b.serverKey] } }])
    expect(splitViews([views[0], views[2]])).toEqual([])
  })

  it('flags someone using a friend\'s name on a server the friend isn\'t on', () => {
    const friend = { key: key(), name: 'Alice' }
    const fake = { key: key(), name: ' alice ' }
    const same = (x: string, y: string) => x === y
    expect(lookalikes([friend], [fake, { key: key(), name: 'Bob' }], same)).toEqual([{ friend: friend.key, key: fake.key, name: ' alice ' }])
    // The friend is there too: two people can share a name.
    expect(lookalikes([friend], [fake, friend], same)).toEqual([])
  })
})

/** A correctly signed head for an earlier position of <paramref name="log"/>. */
function signedHead(log: FakeLog, seq: number, last: WireLogEntry): LogHead {
  const hash = entryHash(new Uint8Array(32), seq, last.data)
  const head = { seq, hash: b64u(hash), at: JSON.parse(last.data).at as number }
  return { ...head, sig: b64u(sign(headPayload(log.server.publicKey, head), log.server.secretKey)) }
}

describe('gossip between friends', () => {
  it('signs digests that only check out for the right people', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const [a, b] = [b64u(alice.account.publicKey), b64u(bob.account.publicKey)]
    const log = new FakeLog().join(a, 'Alice').join(b, 'Bob')
    const rotation = signRotation(generateSigningKeyPair(), generateSigningKeyPair())
    const g = signGossip(alice, b, { heads: [{ server: log.serverKey, ...log.head() }], rotations: [rotation], devices: [b64u(alice.device.publicKey)] })
    expect(checkGossip(JSON.parse(JSON.stringify(g)), a, b)).toMatchObject({ from: a, heads: [{ seq: 2 }], rotations: [rotation] })
    // Moved to another conversation, edited, or from the future: refused.
    expect(checkGossip(g, b, a)).toBeNull()
    expect(checkGossip({ ...g, devices: [] }, a, b)).toBeNull()
    expect(checkGossip(signGossip(alice, b, { heads: [], rotations: [], devices: [] }, Date.now() + 3_600_000), a, b)).toBeNull()
    // A head with a bad signature is dropped, the rest still counts.
    const forgedHead = { ...g.heads[0], seq: 7 }
    const withForged = signGossip(alice, b, { heads: [forgedHead], rotations: [], devices: [] })
    expect(checkGossip(withForged, a, b)!.heads).toEqual([])
  })

  it('catches a server that shows two people different keys for a third (split view)', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const carol = key()
    const [a, b] = [b64u(alice.account.publicKey), b64u(bob.account.publicKey)]
    // Same server, same history so far.
    const honest = new FakeLog().join(a, 'Alice').join(b, 'Bob')
    const lie = honest.fork()
    // Carol joins. Bob is shown her real key; Alice is shown a key the server controls, under Carol's name.
    honest.join(carol, 'Carol')
    lie.join(key(), 'Carol')
    const bobView = sync(emptyView(honest.serverKey), honest)
    const aliceView = sync(emptyView(lie.serverKey), lie)
    // Each log on its own is consistent: neither app can tell alone.
    expect(unloggedKeys(aliceView, Object.keys(aliceView.names))).toEqual([])

    // Bob's next DM to Alice carries his signed head. Same position, different hash: proof of a fork.
    const fromBob = checkGossip(signGossip(bob, a, { heads: [{ server: honest.serverKey, ...bobView.head }], rotations: [], devices: [] }), b, a)!
    const { findings } = compareGossip({ [lie.serverKey]: aliceView }, fromBob, (k) => k)
    expect(findings).toEqual([{ kind: 'fork', server: lie.serverKey, seq: 3 }])

    // A head ahead of ours is remembered and checked when our log gets there.
    honest.join(key(), 'Dave')
    const ahead = checkGossip(signGossip(bob, a, { heads: [{ server: honest.serverKey, ...honest.head() }], rotations: [], devices: [] }), b, a)!
    const early = sync(emptyView(lie.serverKey), { ...lie, entries: lie.entries.slice(0, 2), head: () => signedHeadAt(lie, 2) } as FakeLog)
    const remembered = compareGossip({ [lie.serverKey]: early }, ahead, (k) => k)
    expect(remembered.findings).toEqual([])
    lie.join(key(), 'Dave')
    expect(() => extendView(remembered.views[lie.serverKey], lie.head(), lie.entries)).toThrow(LogError)
    // The honest log passes the same check.
    const fine = compareGossip({ [honest.serverKey]: sync(emptyView(honest.serverKey), { ...honest, entries: honest.entries.slice(0, 2), head: () => signedHeadAt(honest, 2) } as FakeLog) }, ahead, (k) => k)
    expect(extendView(fine.views[honest.serverKey], honest.head(), honest.entries).view.head.seq).toBe(4)
  })

  it('reports a rotation that disagrees with the one we follow', () => {
    const old = generateSigningKeyPair()
    const ours = signRotation(old, generateSigningKeyPair())
    const theirs = signRotation(old, generateSigningKeyPair())
    const map = new KeyMap([ours])
    const alice = createIdentity()
    const g = signGossip(alice, key(), { heads: [], rotations: [theirs, ours], devices: [] })
    const { findings } = compareGossip({}, g, (k) => map.resolve(k))
    expect(findings).toEqual([{ kind: 'conflict', oldKey: ours.oldKey, mine: ours.newKey, theirs: theirs.newKey }])
  })
})

/** A signed head for <paramref name="log"/> as it was at <paramref name="seq"/>. */
function signedHeadAt(log: FakeLog, seq: number): LogHead {
  let hash: Uint8Array = new Uint8Array(32)
  for (const e of log.entries.slice(0, seq)) hash = entryHash(hash, e.seq, e.data)
  const head = { seq, hash: b64u(hash), at: JSON.parse(log.entries[seq - 1].data).at as number }
  return { ...head, sig: b64u(sign(headPayload(log.server.publicKey, head), log.server.secretKey)) }
}

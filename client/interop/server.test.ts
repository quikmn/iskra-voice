// The TypeScript client against the real .NET server, over real WebSockets.
// Run with `npm run test:interop` (builds the server first).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Connection, type ConnectionStatus } from '../src/core/connection'
import { ready } from '../src/core/crypto'
import { b64u, fromB64u } from '../src/core/crypto'
import { generatePrekey, revokedSet, signPrekey, signRevocation } from '../src/core/devices'
import { decryptDm, encryptDm } from '../src/core/dm'
import { encryptedSize, FileDecryptor, FileEncryptor } from '../src/core/dmFiles'
import { createIdentity, type Identity } from '../src/core/identity'
import {
  checkMac, confirmationCode, encodeLinkCode, ephemeralKey, linkKeys, macKey, newLinkSecret, openPayload, parseLinkCode,
  relayDeliver, relayPoll, relayRequest, sealPayload,
} from '../src/core/link'
import { restoreIdentity, seedOf } from '../src/core/recovery'
import { KeyMap, openHandover, prepareRotation, verifyRotation } from '../src/core/rotation'
import { buildInviteLink, parseInvite, type InviteLink } from '../src/core/invite'
import { openPrefs, prefsKey, sealPrefs } from '../src/core/prefs'
import { authProfile } from '../src/core/profile'
import { compareStamps, nextStamp, parseSynced, PROFILE_PREF, toSynced, wireStamp } from '../src/core/profileSync'
import type { Profile } from '../src/core/storage'
import type { Events, Welcome } from '../src/core/protocol'

const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')

interface RunningServer {
  url: string
  world: string
  stop: () => Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer().listen(0, () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => done(port))
    })
  })
}

async function waitFor<T>(check: () => T | undefined | null | false, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

async function startServer(world: string, port: number): Promise<RunningServer> {
  if (!existsSync(join(world, 'server.json')))
    writeFileSync(join(world, 'server.json'), JSON.stringify({ Name: 'Interop', Port: port, LocalOnly: true }))
  const proc: ChildProcess = spawn('dotnet', [SERVER_DLL, world], { stdio: 'ignore' })
  const url = `http://localhost:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(url)).ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('Server did not start')
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    url,
    world,
    stop: () =>
      new Promise((done) => {
        proc.once('exit', () => done())
        proc.kill()
      }),
  }
}

class TestUser {
  readonly identity: Identity
  readonly events: { type: keyof Events; body: unknown }[] = []
  readonly statuses: ConnectionStatus[] = []
  welcome: Welcome | null = null
  readonly connection: Connection

  constructor(name: string, server: { url: string }, invite?: InviteLink, identity: Identity = createIdentity(), profile?: () => Profile) {
    this.identity = identity
    this.connection = new Connection({
      serverUrl: invite?.serverUrl ?? server.url,
      expectedServerKey: invite?.serverKey,
      invite: invite?.code,
      identity: this.identity,
      name: () => profile?.().name ?? name,
      profile: profile && (() => authProfile(profile())),
      onStatus: (s) => this.statuses.push(s),
      onWelcome: (w) => (this.welcome = w),
      onEvent: (type, body) => this.events.push({ type, body }),
    })
    this.connection.start()
  }

  get status(): ConnectionStatus | undefined {
    return this.statuses.at(-1)
  }

  online = () => waitFor(() => this.status?.state === 'online', 'online')

  event<K extends keyof Events>(type: K, match: (body: Events[K]) => boolean = () => true): Promise<Events[K]> {
    return waitFor(
      () => this.events.find((e) => e.type === type && match(e.body as Events[K]))?.body as Events[K] | undefined,
      `event ${type}`,
    )
  }
}

describe('client ↔ server', () => {
  let world: string
  let port: number
  let server: RunningServer

  beforeAll(async () => {
    await ready()
    world = mkdtempSync(join(tmpdir(), 'iskra-interop-'))
    port = await freePort()
    server = await startServer(world, port)
  })

  afterAll(async () => {
    await server?.stop()
    rmSync(world, { recursive: true, force: true })
  })

  const users: TestUser[] = []
  afterAll(() => users.forEach((u) => u.connection.stop()))

  it('owner claims the server, invites a friend, and they chat', async () => {
    const ownerLink = parseInvite(readFileSync(join(world, 'owner-invite.txt'), 'utf8'))
    expect(ownerLink).not.toBeNull()

    const owner = new TestUser('Host', server, ownerLink!)
    users.push(owner)
    await owner.online()
    expect(owner.welcome?.you.role).toBe('owner')
    expect(owner.welcome?.channels.map((c) => c.name)).toContain('general')

    const { invite } = await owner.connection.request('invite.create', {})
    const link = parseInvite(buildInviteLink('http://localhost:5173', { serverUrl: server.url, serverKey: ownerLink!.serverKey, code: invite.code }))

    const friend = new TestUser('Friend', server, link!)
    users.push(friend)
    await friend.online()
    expect(friend.welcome?.you.role).toBe('member')

    const general = friend.welcome!.channels.find((c) => c.name === 'general')!
    const { message } = await friend.connection.request('chat.send', { channelId: general.id, text: 'hi from TypeScript 👋' })
    const received = await owner.event('chat.message', (b) => b.message.id === message.id)
    expect(received.message.text).toBe('hi from TypeScript 👋')
    expect(received.message.author).toBe(friend.welcome!.you.accountKey)
  })

  it('uploads an encrypted DM file in parts and the other person streams it back, intact', async () => {
    const [owner, friend] = users
    const size = 3 * 64 * 1024 + 5000
    const plain = Uint8Array.from({ length: size }, (_, i) => (i * 7) % 256)
    const encryptor = new FileEncryptor(size)
    const begun = await friend.connection.request('dm.upload.begin', { accountKey: owner.welcome!.you.accountKey, size: encryptedSize(size) })
    expect(begun.partBytes).toBe(16 * 1024 * 1024)
    // Parts of 100 KB of plaintext (the app uses bigger ones; the server takes any split).
    let sent = 0
    let id: string | null = null
    for (let at = 0; at < size; at += 100_000) {
      const part = encryptor.push(plain.subarray(at, Math.min(size, at + 100_000)))
      const response = await fetch(`${server.url}${begun.url}?offset=${sent}`, { method: 'PUT', body: part as Uint8Array<ArrayBuffer> })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { received?: number; file?: { id: string } }
      sent += part.length
      if (body.file) id = body.file.id
      else expect(body.received).toBe(sent)
    }
    const { key, hash } = encryptor.finish()
    expect(id).not.toBeNull()

    const { url } = await owner.connection.request('dm.file.url', { id: id! })
    const response = await fetch(server.url + url)
    const decryptor = new FileDecryptor({ key, hash, size })
    const parts: Uint8Array[] = []
    const reader = response.body!.getReader()
    for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(...decryptor.push(r.value))
    parts.push(decryptor.finish())
    expect(Buffer.concat(parts).equals(Buffer.from(plain))).toBe(true)
  })

  it('syncs a profile between two devices: the newest wins, an old device cannot put its profile back', async () => {
    const [owner, friend] = users
    const friendKey = friend.welcome!.you.accountKey
    // The friend's second device, still on the profile it had before.
    const laptopIdentity = restoreIdentity(seedOf(friend.identity))
    let laptopProfile: Profile = { name: 'Friend', bio: 'old', ...nextStamp(undefined, laptopIdentity.cert.deviceKey, Date.now() - 60_000) }

    // The phone renames: stamped on the server, sealed as the account's copy.
    const phoneProfile: Profile = { name: 'Friendly', bio: 'new', ...nextStamp(undefined, friend.identity.cert.deviceKey) }
    const updated = await friend.connection.request('profile.update', { name: phoneProfile.name, bio: phoneProfile.bio, ...wireStamp(phoneProfile) })
    expect(updated.member.name).toBe('Friendly')
    const key = prefsKey(friend.identity.account.secretKey)
    const copy = toSynced(phoneProfile)!
    await friend.connection.request('prefs.set', { name: PROFILE_PREF, data: sealPrefs(key, PROFILE_PREF, JSON.stringify(copy)), updatedAt: copy.updatedAt })

    // The laptop connects with its older profile: the server keeps the new one and tells nobody otherwise.
    const laptop = new TestUser('Friend', server, undefined, laptopIdentity, () => laptopProfile)
    users.push(laptop)
    await laptop.online()
    expect(laptop.welcome?.you.name).toBe('Friendly')
    expect(laptop.welcome?.you.bio).toBe('new')
    const stale = await laptop.connection.request('profile.update', { bio: 'old', ...wireStamp(laptopProfile) })
    expect(stale.stale).toBe(true)

    // It reads the account's copy (sealed under a key only the account has), sees it's newer, and takes it.
    const got = await laptop.connection.request('prefs.get', { name: PROFILE_PREF })
    const remote = parseSynced(openPrefs(prefsKey(laptopIdentity.account.secretKey), PROFILE_PREF, got.data!)!)!
    expect(compareStamps(remote, laptopProfile as { updatedAt: number; by: string })).toBe(1)
    laptopProfile = { ...laptopProfile, name: remote.name, bio: remote.bio, updatedAt: remote.updatedAt, by: remote.by }

    // Reconnecting now changes nothing, and an edit made after catching up wins everywhere.
    laptop.connection.stop()
    const again = new TestUser('Friend', server, undefined, laptopIdentity, () => laptopProfile)
    users.push(again)
    await again.online()
    expect(again.welcome?.you.name).toBe('Friendly')
    laptopProfile = { ...laptopProfile, name: 'Fred', ...nextStamp(laptopProfile, laptopIdentity.cert.deviceKey) }
    const renamed = await again.connection.request('profile.update', { name: 'Fred', ...wireStamp(laptopProfile) })
    expect(renamed.stale).toBeUndefined()
    await owner.event('member.updated', (b) => b.member.accountKey === friendKey && b.member.name === 'Fred')
    again.connection.stop()
  })

  it('refuses a server whose key does not match the invite', async () => {
    const impostorLink: InviteLink = { serverUrl: server.url, serverKey: 'B'.repeat(43), code: 'whatever1' }

    const user = new TestUser('Victim', server, impostorLink)
    users.push(user)
    const status = await waitFor(() => (user.status?.state === 'rejected' ? user.status : null), 'rejection')
    expect(status.code).toBe('server_key_mismatch')
  })

  it('reports a missing invite as a rejection and does not retry', async () => {
    const stranger = new TestUser('Stranger', server)
    users.push(stranger)
    const status = await waitFor(() => (stranger.status?.state === 'rejected' ? stranger.status : null), 'rejection')
    expect(status.code).toBe('invite_required')
    await new Promise((r) => setTimeout(r, 1500))
    expect(stranger.statuses.filter((s) => s.state === 'connecting')).toHaveLength(1)
  })

  it('links a new device through the relay, sends it a forward-secret DM, then revokes it', async () => {
    const [owner, friend] = users
    const ownerKey = b64u(owner.identity.account.publicKey)

    // Existing device: a relay slot, and a code with a secret the server never sees.
    const { token, putKey } = await owner.connection.request('link.create', {})
    const shown = encodeLinkCode({ serverUrl: server.url, token, secret: newLinkSecret() })

    // New device: only has the code.
    const code = parseLinkCode(shown)!
    const keys = linkKeys(code)
    const fresh = ephemeralKey()
    const readKey = await relayRequest(code, { epk: b64u(fresh.publicKey), mac: macKey(fresh.publicKey, keys.macNew), info: 'Interop' })

    const request = await owner.event('link.request', (r) => r.token === token)
    const ownerKeys = linkKeys(parseLinkCode(shown)!)
    const theirs = checkMac(request.epk, request.mac, ownerKeys.macNew)!
    expect(theirs).not.toBeNull()
    const mine = ephemeralKey()
    await owner.connection.request('link.respond', { token, epk: b64u(mine.publicKey), mac: macKey(mine.publicKey, ownerKeys.macExisting) })

    const answered = await relayPoll(code, readKey)
    if (answered.state !== 'answered') throw new Error(`expected answered, got ${answered.state}`)
    const existing = checkMac(answered.epk, answered.mac, keys.macExisting)!
    expect(confirmationCode(keys, existing, fresh.publicKey)).toBe(confirmationCode(ownerKeys, mine.publicKey, theirs))

    await relayDeliver(server.url, token, putKey, sealPayload({ seed: b64u(seedOf(owner.identity)) }, mine, theirs))
    const done = await relayPoll(code, readKey)
    if (done.state !== 'done') throw new Error(`expected done, got ${done.state}`)
    const { seed } = openPayload<{ seed: string }>(fromB64u(done.payload), existing, fresh)

    // The new device is the same account, with its own device key; no invite needed.
    const phoneIdentity = restoreIdentity(fromB64u(seed))
    phoneIdentity.prekeys = [generatePrekey()]
    const phone = new TestUser('Host', server, undefined, phoneIdentity)
    users.push(phone)
    await phone.online()
    expect(phone.welcome?.you.role).toBe('owner')
    await phone.connection.request('prekey.publish', signPrekey(phoneIdentity, phoneIdentity.prekeys[0]))

    // A friend encrypts to both devices; the phone's slot is sealed to its prekey.
    const bundle = await friend.connection.request('dm.devices', { accountKey: ownerKey })
    expect(bundle.devices).toHaveLength(2)
    const envelope = encryptDm(friend.identity, ownerKey, bundle.devices, [], { text: 'hi phone' }, Date.now(), { prekeys: bundle.prekeys })
    expect(envelope.v).toBe(2)
    expect(envelope.keys.find((k) => k.device === phoneIdentity.cert.deviceKey)).toHaveProperty('seal')
    await friend.connection.request('dm.send', { accountKey: ownerKey, envelope })
    const received = await phone.event('dm.message', (b) => b.message.envelope.header.id === envelope.header.id)
    expect(decryptDm(phoneIdentity, received.message.envelope, received.message.from, received.message.to).text).toBe('hi phone')

    // Revoked: kicked, refused, and gone from what senders see.
    await owner.connection.request('device.revoke', signRevocation(owner.identity, phoneIdentity.cert.deviceKey))
    await waitFor(() => phone.status?.state === 'rejected', 'phone kicked')
    const after = await friend.connection.request('dm.devices', { accountKey: ownerKey })
    expect(after.devices.map((d) => d.deviceKey)).not.toContain(phoneIdentity.cert.deviceKey)
    expect(revokedSet(ownerKey, after.revoked).has(phoneIdentity.cert.deviceKey)).toBe(true)

    phone.connection.stop()
    const again = new TestUser('Host', server, undefined, phoneIdentity)
    users.push(again)
    await waitFor(() => again.status?.state === 'rejected', 'refused')
    expect(again.status).toMatchObject({ code: 'device_revoked' })
  })

  it('rotates an account key: a carried-over device follows, contacts see it, old DMs still open', async () => {
    const [owner, friend] = users
    const ownerKey = b64u(owner.identity.account.publicKey)
    const friendKey = b64u(friend.identity.account.publicKey)
    const phoneIdentity = restoreIdentity(seedOf(friend.identity))
    const phone = new TestUser('Friend', server, undefined, phoneIdentity)
    users.push(phone)
    await phone.online()

    // A DM to the friend before the rotation.
    const bundle = await owner.connection.request('dm.devices', { accountKey: friendKey })
    const before = encryptDm(owner.identity, friendKey, bundle.devices, [], { text: 'before the new key' })
    await owner.connection.request('dm.send', { accountKey: friendKey, envelope: before })

    const prepared = prepareRotation(friend.identity, [phoneIdentity.cert])
    const newKey = prepared.rotation.newKey
    const { status } = await friend.connection.request('account.rotate', {
      rotation: prepared.rotation, certs: prepared.certs, handovers: prepared.handovers,
    })
    expect(status).toBe('applied')
    await waitFor(() => friend.status?.state === 'rejected', 'old session closed')
    expect(friend.status).toMatchObject({ code: 'account_rotated' })

    // The other device opens its hand-over and checks it against the signed rotation.
    const moved = await phone.event('account.rotated')
    const opened = openHandover(phoneIdentity, moved.handover!, moved.rotations)
    expect(opened && b64u(opened.account.publicKey)).toBe(newKey)

    // Contacts get the signed statement and check it themselves.
    const seen = await owner.event('member.rotated')
    expect(verifyRotation(seen.rotation)).toBe(true)
    expect(seen.member.accountKey).toBe(newKey)

    // Signing in with the new key: same member; the old DM is routed to the new key and still opens.
    const next = new TestUser('Friend', server, undefined, prepared.identity)
    users.push(next)
    await next.online()
    expect(next.welcome?.you.role).toBe('member')
    const { messages } = await next.connection.request('dm.history', { accountKey: ownerKey })
    const keys = new KeyMap([seen.rotation])
    const old = messages.find((m) => m.envelope.header.id === before.header.id)!
    expect(old.to).toBe(newKey)
    expect(decryptDm(prepared.identity, old.envelope, old.from, old.to, (a, b) => keys.same(a, b)).text).toBe('before the new key')

    // The old key is refused with where it went.
    const stale = new TestUser('Friend', server, undefined, friend.identity)
    users.push(stale)
    const refused = await waitFor(() => (stale.status?.state === 'rejected' ? stale.status : null), 'old key refused')
    expect(refused.code).toBe('account_rotated')
    expect((refused.detail?.rotations as { newKey: string }[])[0].newKey).toBe(newKey)
  })

  it('reconnects by itself after a server restart', async () => {
    const owner = users[0]
    await server.stop()
    await waitFor(() => owner.status?.state === 'offline', 'offline')

    server = await startServer(world, port)
    await waitFor(() => owner.status?.state === 'online', 'back online', 40_000)

    const general = owner.welcome!.channels.find((c) => c.name === 'general')!
    const { messages } = await owner.connection.request('chat.history', { channelId: general.id })
    expect(messages.map((m) => m.text)).toContain('hi from TypeScript 👋')
  }, 60_000) // reconnect backoff can take a while after a restart
})

// Bot DMs: a person and a bot (the SDK) message each other end-to-end encrypted through the real .NET server, commands
// typed in a DM reach the bot's handlers, and a bot opens an encrypted attachment. Run with `npm run test:interop`.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bot, loadState, type IncomingDm } from '../../bots/sdk/src/index'
import { Connection } from '../src/core/connection'
import { b64u, ready } from '../src/core/crypto'
import { decryptDm, encryptDm, type DmContent } from '../src/core/dm'
import { encryptFile } from '../src/core/dmFiles'
import { createIdentity, type Identity } from '../src/core/identity'
import { buildInviteLink, parseInvite } from '../src/core/invite'
import type { Events, Welcome, WireDm } from '../src/core/protocol'

const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')

const freePort = () => new Promise<number>((done) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const port = (probe.address() as { port: number }).port
    probe.close(() => done(port))
  })
})

async function waitFor<T>(check: () => T | undefined | null | false, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

interface Person {
  identity: Identity
  connection: Connection
  welcome: Welcome
  dms: WireDm[]
  key: string
}

describe('bot DMs ↔ server', () => {
  let world: string
  let url: string
  let stop: () => Promise<void>
  let owner: Person
  const people: Person[] = []
  const bots: Bot[] = []

  async function connect(code: string, serverUrl: string, serverKey: string, name: string): Promise<Person> {
    const identity = createIdentity()
    const dms: WireDm[] = []
    let welcome: Welcome | null = null
    const connection = new Connection({
      serverUrl, expectedServerKey: serverKey, invite: code, identity, name: () => name,
      onStatus: () => undefined, onWelcome: (w) => (welcome = w),
      onEvent: (type, body) => {
        if (type === 'dm.message') dms.push((body as Events['dm.message']).message)
      },
    })
    connection.start()
    await waitFor(() => welcome, `${name} online`)
    const person = { identity, connection, welcome: welcome!, dms, key: b64u(identity.account.publicKey) }
    people.push(person)
    return person
  }

  beforeAll(async () => {
    await ready()
    world = mkdtempSync(join(tmpdir(), 'iskra-botdms-'))
    const port = await freePort()
    writeFileSync(join(world, 'server.json'), JSON.stringify({ Name: 'Bot DMs', Port: port, LocalOnly: true, Voice: { Enabled: false } }))
    const proc = spawn('dotnet', [SERVER_DLL, world], { stdio: 'ignore' })
    url = `http://localhost:${port}`
    stop = () => new Promise((done) => {
      proc.once('exit', () => done())
      proc.kill()
    })
    await waitFor(() => existsSync(join(world, 'owner-invite.txt')), 'server start', 30_000)
    for (;;) {
      try {
        if ((await fetch(url)).ok) break
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    const link = parseInvite(readFileSync(join(world, 'owner-invite.txt'), 'utf8'))!
    owner = await connect(link.code, link.serverUrl, link.serverKey, 'Host')
  })

  afterAll(async () => {
    bots.forEach((b) => b.stop())
    people.forEach((p) => p.connection.stop())
    await stop?.()
    rmSync(world, { recursive: true, force: true })
  })

  /** What a person's app does: encrypt to the bot's devices (forward secret to its prekey) and send. */
  async function sendTo(from: Person, to: string, content: DmContent) {
    const [theirs, ours] = await Promise.all([
      from.connection.request('dm.devices', { accountKey: to }), from.connection.request('dm.devices', { accountKey: from.key }),
    ])
    const envelope = encryptDm(from.identity, to, theirs.devices, ours.devices, content, Date.now(), { prekeys: [...(theirs.prekeys ?? []), ...(ours.prekeys ?? [])] })
    return { envelope, sent: await from.connection.request('dm.send', { accountKey: to, envelope, ...(content.files ? { files: content.files.map((f) => f.id) } : {}) }) }
  }

  const fromBot = (person: Person, bot: Bot, match: (text: string) => boolean) =>
    waitFor(() => person.dms.map((w) => (w.from === bot.me?.accountKey ? decryptDm(person.identity, w.envelope, w.from, w.to).text : null)).find((t) => t !== null && match(t)), 'a DM from the bot')

  it('a person DMs a bot, a typed command reaches its handler, and the bot answers and starts conversations', async () => {
    const { invite } = await owner.connection.request('bot.invite', {})
    const stateFile = join(world, 'dice.bot.json')
    const bot = new Bot({ name: 'Dice', invite: buildInviteLink('http://localhost:5173', { serverUrl: url, serverKey: owner.welcome.server.key, code: invite.code }), stateFile, log: () => undefined })
    const heard: IncomingDm[] = []
    bot.on('dm', (dm) => heard.push(dm))
    bot.commands([{
      name: 'roll', description: 'Rolls dice',
      options: [{ name: 'dice', description: 'Like 2d6', type: 'string', required: true }, { name: 'times', description: 'How often', type: 'integer' }],
      handler: ({ options, dm, userName, reply }) => reply({ text: `${userName} rolled ${options.dice} x${options.times ?? 1} (dm: ${dm})`, cards: [{ title: 'Total', description: '7' }] }),
    }])
    bots.push(bot)
    await bot.start()

    // The bot published a prekey (kept in its state file), so the person's message to it is forward secret.
    let bundle = await owner.connection.request('dm.devices', { accountKey: bot.me!.accountKey })
    for (let i = 0; i < 50 && !bundle.prekeys?.length; i++) {
      await new Promise((r) => setTimeout(r, 100))
      bundle = await owner.connection.request('dm.devices', { accountKey: bot.me!.accountKey })
    }
    expect(bundle.prekeys?.length).toBe(1)
    expect(loadState(stateFile)?.prekeys).toHaveLength(1)
    const { envelope } = await sendTo(owner, bot.me!.accountKey, { text: '/roll 2d6 3' })
    expect(envelope.v).toBe(2)
    expect(envelope.keys.some((k) => 'seal' in k)).toBe(true)

    expect(await fromBot(owner, bot, (t) => t.startsWith('Host rolled'))).toBe('Host rolled 2d6 x3 (dm: true)\n\n**Total**\n7')
    expect(heard[0]).toMatchObject({ text: '/roll 2d6 3', authorName: 'Host', from: owner.key })

    // Wrong options get a usage hint instead of a run; /help is built in.
    await sendTo(owner, bot.me!.accountKey, { text: '/roll 2d6 lots' })
    expect(await fromBot(owner, bot, (t) => t.includes('times'))).toMatch(/`times` isn't right. Try `\/roll <dice> \[times\]`/)
    await sendTo(owner, bot.me!.accountKey, { text: '/help' })
    expect(await fromBot(owner, bot, (t) => t.includes('can do'))).toContain('/roll')

    // A bot may start a conversation with someone on the server, unless they turned bot DMs off.
    const { invite: memberInvite } = await owner.connection.request('invite.create', {})
    const alice = await connect(memberInvite.code, url, owner.welcome.server.key, 'Alice')
    await waitFor(() => bot.members.get(alice.key), 'the bot sees Alice')
    await bot.sendDm(alice.key, 'Game night at 8?')
    expect(await fromBot(alice, bot, () => true)).toBe('Game night at 8?')
    await alice.connection.request('dm.bots.set', { allow: false, at: Date.now() })
    await expect(bot.sendDm(alice.key, 'Still on?')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a bot opens a file someone attached to a DM', async () => {
    const bot = bots[0]
    const plain = new TextEncoder().encode('ID3 pretend this is a song')
    const { ciphertext, key, hash } = encryptFile(plain)
    const ticket = await owner.connection.request('dm.upload.begin', { accountKey: bot.me!.accountKey, size: ciphertext.length })
    const put = await fetch(url + ticket.url, { method: 'PUT', body: ciphertext })
    const { file } = (await put.json()) as { file: { id: string } }
    const dmFile = { server: owner.welcome.server.key, id: file.id, key, hash, name: 'song.mp3', type: 'audio/mpeg', size: plain.length }
    const heard: IncomingDm[] = []
    bot.on('dm', (dm) => heard.push(dm))
    await sendTo(owner, bot.me!.accountKey, { text: '', files: [dmFile] })
    const dm = await waitFor(() => heard.find((d) => d.files.length > 0), 'the DM with a file')
    expect(dm.files[0]).toMatchObject({ name: 'song.mp3', size: plain.length })
    expect(new TextDecoder().decode(await bot.downloadDmFile(dm.files[0]))).toBe('ID3 pretend this is a song')
  })
})

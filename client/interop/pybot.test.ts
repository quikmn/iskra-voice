// The Python bot SDK (bots/python) against the real .NET server, driven by the app's own client code: the Python Dice
// example joins with a bot invite and answers a command, a button, a text command and an end-to-end encrypted DM. Then
// the Node SDK takes over the same <name>.bot.json, as a bot that switches languages would. And the any-language bridge
// (bots/sdk/src/bridge.ts) with a plain Python program (bots/examples/bridge/roll.py).
// Needs Python with the SDK installed: bots/python/.venv (see docs/bots.md → Python), or ISKRA_PYTHON. Skipped without.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bot } from '../../bots/sdk/src/index'
import { Bridge, spawnProgram } from '../../bots/sdk/src/bridge'
import { Connection } from '../src/core/connection'
import { ready } from '../src/core/crypto'
import { decryptDm, encryptDm } from '../src/core/dm'
import { createIdentity } from '../src/core/identity'
import { buildInviteLink, parseInvite } from '../src/core/invite'
import type { Events, Message, Welcome } from '../src/core/protocol'
import { freePort } from './ports'

const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const PYTHON_DIR = resolve(__dirname, '../../bots/python')
const PYTHON = process.env.ISKRA_PYTHON
  ?? [join(PYTHON_DIR, '.venv/Scripts/python.exe'), join(PYTHON_DIR, '.venv/bin/python')].find((p) => existsSync(p))

async function waitFor<T>(check: () => T | undefined | null | false, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

describe.skipIf(!PYTHON)('Python bot SDK ↔ server', () => {
  let world: string
  let url: string
  let stop: () => Promise<void>
  let owner: Connection
  const identity = createIdentity()
  const events: { type: keyof Events; body: unknown }[] = []
  let welcome: Welcome | null = null
  let python: ChildProcess | null = null
  const output: string[] = []
  const bots: Bot[] = []

  beforeAll(async () => {
    await ready()
    world = mkdtempSync(join(tmpdir(), 'iskra-pybot-'))
    const port = await freePort()
    writeFileSync(join(world, 'server.json'), JSON.stringify({ Name: 'Python', Port: port, LocalOnly: true, Voice: { Enabled: false } }))
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
    owner = new Connection({
      serverUrl: link.serverUrl, expectedServerKey: link.serverKey, invite: link.code, identity,
      name: () => 'Host', onStatus: () => undefined, onWelcome: (w) => (welcome = w),
      onEvent: (type, body) => events.push({ type, body }),
    })
    owner.start()
    await waitFor(() => welcome, 'owner online')
  })

  afterAll(async () => {
    python?.kill()
    bots.forEach((b) => b.stop())
    owner?.stop()
    await stop?.()
    rmSync(world, { recursive: true, force: true })
  })

  const message = (match: (m: Message) => boolean) =>
    waitFor(() => events.map((e) => (e.type === 'chat.message' ? (e.body as Events['chat.message']).message : null)).find((m) => m && match(m)),
      'a chat message').then((m) => m!)

  it('the Python Dice bot joins, answers a command, a click, a text command and a DM; Node takes over its keys', async () => {
    const { invite } = await owner.request('bot.invite', {})
    const link = buildInviteLink('http://localhost:5173', { serverUrl: url, serverKey: welcome!.server.key, code: invite.code })
    const stateFile = join(world, 'dice.bot.json')
    python = spawn(PYTHON!, [join(PYTHON_DIR, 'examples/dice.py')], {
      cwd: world, env: { ...process.env, ISKRA_INVITE: link, ISKRA_BOT_STATE: stateFile, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    python.stdout!.on('data', (d: Buffer) => output.push(d.toString()))
    python.stderr!.on('data', (d: Buffer) => output.push(d.toString()))
    await waitFor(() => output.join('').includes('Online in "Python" as Dice (member)'), `the Python bot online (${output.join('')})`, 30_000)

    // It registered its commands, with interactions, like the Node SDK does.
    const listed = await waitFor(() => events.map((e) => (e.type === 'bot.commands' ? e.body as Events['bot.commands'] : null))
      .find((b) => b && b.commands.length > 0 && b.interactions), 'bot.commands')
    expect(listed.commands.map((c) => c.name).sort()).toEqual(['coin', 'echo', 'help', 'pick', 'roll'])
    const botKey = listed.bot
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    expect(state).toMatchObject({ v: 1, server: { url, key: welcome!.server.key } })
    expect(state.prekeys).toHaveLength(1)

    // A command from the app, as an interaction: a public answer with a card and a "Roll again" button.
    const general = welcome!.channels.find((c) => c.name === 'general')!
    await owner.request('interaction.invoke', { bot: botKey, channelId: general.id, command: 'roll', options: { dice: '2d6' }, args: '2d6' })
    const rolled = await message((m) => m.author === botKey && m.text.startsWith('Host rolled'))
    expect(rolled.cards?.[0]).toMatchObject({ title: '🎲 2d6' })
    expect(rolled.components?.[0].items[0]).toMatchObject({ type: 'button', customId: 'roll:2d6', label: 'Roll again' })

    // The button: whoever clicks rolls again.
    await owner.request('interaction.invoke', { messageId: rolled.id, customId: 'roll:2d6' })
    await waitFor(() => events.filter((e) => e.type === 'chat.message'
      && (e.body as Events['chat.message']).message.author === botKey && (e.body as Events['chat.message']).message.text.startsWith('Host rolled')).length >= 2,
    'a second roll')

    // A private answer goes only to the asker, never into the channel.
    await owner.request('interaction.invoke', { bot: botKey, channelId: general.id, command: 'roll', options: { dice: 'd20', secret: true } })
    const secret = await waitFor(() => events.find((e) => e.type === 'interaction.response')?.body as { text: string } | undefined, 'interaction.response')
    expect(secret.text).toMatch(/^Host rolled \*\*\d+\*\*$/)

    // Typed as text (the convention for older apps): the answer replies to the message.
    const { message: typed } = await owner.request('chat.send', { channelId: general.id, text: '/pick pizza, tacos' })
    const picked = await message((m) => m.author === botKey && m.replyTo?.id === typed.id)
    expect(picked.text).toMatch(/^I pick \*\*(pizza|tacos)\*\*$/)

    // A DM, end-to-end encrypted by the app's code (forward secret to the bot's prekey), opened by Python; the answer
    // is encrypted by Python and opened by the app's code.
    const [theirs, ours] = await Promise.all([
      owner.request('dm.devices', { accountKey: botKey }), owner.request('dm.devices', { accountKey: welcome!.you.accountKey })])
    expect(theirs.prekeys).toHaveLength(1)
    const envelope = encryptDm(identity, botKey, theirs.devices, ours.devices, { text: '/roll 3d6' }, Date.now(),
      { prekeys: [...(theirs.prekeys ?? []), ...(ours.prekeys ?? [])] })
    expect(envelope.v).toBe(2)
    await owner.request('dm.send', { accountKey: botKey, envelope })
    const answer = await waitFor(() => events.map((e) => {
      if (e.type !== 'dm.message') return null
      const wire = (e.body as Events['dm.message']).message
      return wire.from === botKey ? decryptDm(identity, wire.envelope, wire.from, wire.to).text : null
    }).find((t) => t), 'a DM from the Python bot')
    expect(answer).toMatch(/^Host rolled \*\*\d+\*\*/)
    expect(answer).toContain('**🎲 3d6**') // the card, as text

    // The same keys in Node: no invite needed, the same account.
    python.kill()
    await new Promise((r) => python!.once('exit', r))
    const node = new Bot({ name: 'Dice', stateFile, log: () => undefined })
    bots.push(node)
    await node.start()
    expect(node.me?.accountKey).toBe(botKey)
  }, 90_000)

  it('the bridge runs a bot written without any SDK, over its stdin and stdout', async () => {
    const { invite } = await owner.request('bot.invite', {})
    const link = buildInviteLink('http://localhost:5173', { serverUrl: url, serverKey: welcome!.server.key, code: invite.code })
    const bot = new Bot({ name: 'Roll', invite: link, stateFile: join(world, 'roll.bot.json'), log: () => undefined })
    bots.push(bot)
    const logs: string[] = []
    let markStarted!: () => void
    const started = new Promise<void>((done) => (markStarted = done))
    // What `iskra-bots bridge --name Roll -- python roll.py` does.
    const program = spawnProgram(PYTHON!, [resolve(__dirname, '../../bots/examples/bridge/roll.py')], (write) => {
      const bridge = new Bridge(bot, { write, log: (l) => logs.push(l), started })
      bridge.hello()
      return bridge
    }, { ...process.env, PYTHONIOENCODING: 'utf-8' })
    try {
      await bot.start()
      markStarted()
      const botKey = bot.me!.accountKey
      await waitFor(() => events.some((e) => e.type === 'bot.commands' && (e.body as Events['bot.commands']).bot === botKey
        && (e.body as Events['bot.commands']).commands.some((c) => c.name === 'roll')), 'the program registered /roll')

      const general = welcome!.channels.find((c) => c.name === 'general')!
      await owner.request('interaction.invoke', { bot: botKey, channelId: general.id, command: 'roll', options: { dice: '3d6' } })
      const rolled = await message((m) => m.author === botKey)
      expect(rolled.text).toMatch(/^Host rolled \*\*\d+\*\* \(\d, \d, \d\)$/)

      // A message that mentions it: the program reacts through its ref.
      const { message: praise } = await owner.request('chat.send', { channelId: general.id, text: `good bot <@${botKey}>` })
      await waitFor(() => events.some((e) => e.type === 'chat.reactions' && (e.body as Events['chat.reactions']).id === praise.id
        && (e.body as Events['chat.reactions']).reactions.some((r) => r.emoji === '🤖')), 'the reaction')
      expect(logs).toEqual([])
    } finally {
      program.kill()
      await program.exited
    }
  }, 60_000)
})

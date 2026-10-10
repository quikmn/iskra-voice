// The bot SDK (bots/sdk) and webhooks against the real .NET server. Run with `npm run test:interop`.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bot, loadState } from '../../bots/sdk/src/index'
import { describe as describeRoll, pick, roll } from '../../bots/examples/dice-rules'
import { Connection, type ConnectionStatus } from '../src/core/connection'
import { ready } from '../src/core/crypto'
import { createIdentity } from '../src/core/identity'
import { buildInviteLink, parseInvite } from '../src/core/invite'
import type { Events, Message, Welcome } from '../src/core/protocol'

const SERVER_DLL = resolve(__dirname, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')

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

describe('dice rules', () => {
  const fixed = (value: number) => () => value
  it('rolls dice notation within limits', () => {
    expect(roll('2d6', fixed(0.99))).toMatchObject({ count: 2, sides: 6, rolls: [6, 6], total: 12 })
    expect(roll('d20+3', fixed(0))).toMatchObject({ total: 4, modifier: 3 })
    expect(roll('', fixed(0))?.sides).toBe(6)
    expect(roll('101d6')).toBeNull()
    expect(roll('2d1')).toBeNull()
    expect(roll('hello')).toBeNull()
    expect(describeRoll(roll('2d6+1', fixed(0))!)).toBe('2d6+1: 1 + 1 + 1 = **3**')
    expect(describeRoll(roll('d20', fixed(0))!)).toBe('1d20: **1**')
  })

  it('picks one of several options', () => {
    expect(pick('pizza, tacos, sushi', fixed(0.5))).toBe('tacos')
    expect(pick('this or that', fixed(0))).toBe('this')
    expect(pick('only one')).toBeNull()
  })
})

describe('bot SDK ↔ server', () => {
  let world: string
  let url: string
  let stop: () => Promise<void>
  let owner: Connection
  const events: { type: keyof Events; body: unknown }[] = []
  let welcome: Welcome | null = null
  const bots: Bot[] = []

  beforeAll(async () => {
    await ready()
    world = mkdtempSync(join(tmpdir(), 'iskra-bots-'))
    const port = await freePort()
    writeFileSync(join(world, 'server.json'), JSON.stringify({ Name: 'Bots', Port: port, Voice: { Enabled: false } }))
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
    const statuses: ConnectionStatus[] = []
    owner = new Connection({
      serverUrl: link.serverUrl, expectedServerKey: link.serverKey, invite: link.code, identity: createIdentity(),
      name: () => 'Host', onStatus: (s) => statuses.push(s), onWelcome: (w) => (welcome = w),
      onEvent: (type, body) => events.push({ type, body }),
    })
    owner.start()
    await waitFor(() => welcome, 'owner online')
  })

  afterAll(async () => {
    bots.forEach((b) => b.stop())
    owner?.stop()
    await stop?.()
    rmSync(world, { recursive: true, force: true })
  })

  const message = (match: (m: Message) => boolean) =>
    waitFor(() => events.find((e) => e.type === 'chat.message' && match((e.body as Events['chat.message']).message))
      ?.body as Events['chat.message'] | undefined, 'a chat message').then((b) => b.message)

  it('a bot joins with a bot invite, answers commands and remembers the server', async () => {
    const { invite } = await owner.request('bot.invite', {})
    const link = buildInviteLink('http://localhost:5173', { serverUrl: url, serverKey: welcome!.server.key, code: invite.code })
    const stateFile = join(world, 'dice.bot.json')
    const logs: string[] = []

    const bot = new Bot({ name: 'Dice', invite: link, stateFile, log: (l) => logs.push(l) })
    bot.command('roll', 'Rolls dice', async ({ args, message: m, reply }) => {
      await m.react('🎲')
      await reply(`rolled ${args}`)
    })
    bots.push(bot)
    await bot.start()
    expect(bot.me?.bot).toBe(true)
    expect(loadState(stateFile)?.server?.key).toBe(welcome!.server.key)

    const joined = await waitFor(() => events.find((e) => e.type === 'member.joined')?.body as Events['member.joined'] | undefined, 'member.joined')
    expect(joined.member).toMatchObject({ name: 'Dice', bot: true })

    const general = welcome!.channels.find((c) => c.name === 'general')!
    const { message: sent } = await owner.request('chat.send', { channelId: general.id, text: '/roll 2d6' })
    const answer = await message((m) => m.author === bot.me!.accountKey)
    expect(answer.text).toBe('rolled 2d6')
    expect(answer.replyTo).toMatchObject({ id: sent.id })
    await waitFor(() => events.find((e) => e.type === 'chat.reactions' && (e.body as Events['chat.reactions']).id === sent.id), 'reaction')

    // Commands aimed at another bot, and unknown commands, are left alone; /help is built in.
    await owner.request('chat.send', { channelId: general.id, text: '/roll@Other d6' })
    await owner.request('chat.send', { channelId: general.id, text: '/help@Dice' })
    const help = await message((m) => m.author === bot.me!.accountKey && m.text.includes('can do'))
    expect(help.text).toContain('/roll')
    expect(events.filter((e) => e.type === 'chat.message' && (e.body as Events['chat.message']).message.text === 'rolled d6')).toHaveLength(0)

    // Bots can't join voice.
    const voice = (await owner.request('channel.create', { name: 'lounge', kind: 'voice' })).channel
    await expect(bot.request('voice.join', { channelId: voice.id })).rejects.toMatchObject({ code: 'forbidden' })

    // Restarting needs no invite: the state file has the keys and the server.
    bot.stop()
    const again = new Bot({ name: 'Dice', stateFile, log: () => undefined })
    bots.push(again)
    await again.start()
    expect(again.me?.accountKey).toBe(bot.me?.accountKey)
  })

  it('a bot that is not invited as a bot is turned away', async () => {
    const { invite } = await owner.request('invite.create', {})
    const link = buildInviteLink('http://localhost:5173', { serverUrl: url, serverKey: welcome!.server.key, code: invite.code })
    const bot = new Bot({ name: 'Sneaky', invite: link, stateFile: join(world, 'sneaky.bot.json'), log: () => undefined })
    bots.push(bot)
    await expect(bot.start()).rejects.toThrow(/invite/)
  })

  it('a webhook posts with its own name, and the owner sees it live', async () => {
    const general = welcome!.channels.find((c) => c.name === 'general')!
    const { path, webhook } = await owner.request('webhook.create', { channelId: general.id, name: 'Grafana' })
    const response = await fetch(url + path + '?wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'CPU high @everyone', embeds: [{ title: 'Alert', color: 0xff0000 }] }),
    })
    expect(response.status).toBe(200)
    const posted = await message((m) => m.webhook?.id === webhook.id)
    expect(posted.webhook).toMatchObject({ name: 'Grafana', embeds: [{ title: 'Alert', color: 0xff0000 }] })
    expect(posted.text).toBe('CPU high @‍everyone')
  })
})

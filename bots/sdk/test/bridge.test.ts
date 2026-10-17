// The any-language bridge's line protocol, with a fake bot and a fake program (a child process). Run: npm test (in bots/).
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import type { BridgeBot } from '../src/bridge'
import { Bridge, MAX_LINE_BYTES, readLines, spawnProgram } from '../src/bridge'
import { RequestError } from '../../../client/src/core/protocol'

type Listener = (...args: unknown[]) => void

/** Just enough of a Bot: records what the bridge asks of it, and lets the test play the server's part. */
class FakeBot {
  name = 'Fake'
  me = { accountKey: 'B'.repeat(43), name: 'Fake', role: 'member', online: true, bot: true }
  channels = [{ id: 1, name: 'general', kind: 'text', position: 0, readRole: 'guest', writeRole: 'guest' }]
  members = new Map<string, unknown>()
  listeners = new Map<string, Listener[]>()
  commandsByName = new Map<string, { description: string; handler: (ctx: unknown) => unknown; details: unknown }>()
  components: ((ctx: unknown) => unknown)[] = []
  modals: ((ctx: unknown) => unknown)[] = []
  calls: unknown[][] = []

  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  emit(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) l(...args)
  }

  command(name: string, description: string, handler: (ctx: unknown) => unknown, details: unknown) {
    if (!/^[a-z0-9][\w-]{0,31}$/.test(name.toLowerCase())) throw new Error(`Invalid command name "${name}"`)
    this.commandsByName.set(name.toLowerCase(), { description, handler, details })
    return this
  }

  removeCommand(name: string) {
    this.commandsByName.delete(name)
    return this
  }

  onComponent(_: unknown, handler: (ctx: unknown) => unknown) {
    this.components.push(handler)
    return this
  }

  onModalSubmit(_: unknown, handler: (ctx: unknown) => unknown) {
    this.modals.push(handler)
    return this
  }

  get commandList() {
    return [{ name: 'help', description: 'Lists what this bot can do' }, ...[...this.commandsByName].map(([name, c]) => ({ name, description: c.description }))]
  }

  async request(type: string, body: unknown) {
    this.calls.push(['request', type, body])
    if (type === 'nope') throw new RequestError('forbidden', 'Not for bots.', type, 'bot_no_read')
    return { echoed: body }
  }

  async send(channelId: number, content: unknown) {
    this.calls.push(['send', channelId, content])
    return { id: 99, channelId, text: (content as { text?: string }).text ?? '' }
  }

  async sendDm(accountKey: string, content: unknown) {
    this.calls.push(['sendDm', accountKey, content])
  }

  async upload(file: { name: string; data: Uint8Array }) {
    this.calls.push(['upload', file.name, Buffer.from(file.data).toString()])
    return { id: 'f1', name: file.name, size: file.data.length, type: 'text/plain', width: null, height: null, url: '/files/f1/x' }
  }

  async downloadDmFile() {
    return new Uint8Array([1, 2, 3])
  }

  /** What the SDK does when someone uses a command: the handler gets a context to answer with. */
  invoke(name: string, extra: Record<string, unknown> = {}) {
    const answers: unknown[][] = []
    const ctx = {
      command: { name, target: null, args: '2d6' }, args: '2d6', options: { dice: '2d6' }, user: 'U'.repeat(43), userName: 'Viktor', channelId: 1,
      dm: false, interaction: { id: 'i1', private: false }, ...extra,
      reply: async (content: unknown, options: unknown) => {
        answers.push(['reply', content, options])
        return { id: 7 }
      },
      defer: async () => void answers.push(['defer']),
      showModal: async (modal: unknown) => void answers.push(['modal', modal]),
      react: async (emoji: string) => void answers.push(['react', emoji]),
    }
    void this.commandsByName.get(name)!.handler(ctx)
    return answers
  }
}

function harness() {
  const bot = new FakeBot()
  const lines: Record<string, unknown>[] = []
  const logs: string[] = []
  const bridge = new Bridge(bot as unknown as BridgeBot, { write: (l) => lines.push(JSON.parse(l)), log: (l) => logs.push(l), version: 'test' })
  const ask = async (frame: unknown) => {
    await bridge.line(typeof frame === 'string' ? frame : JSON.stringify(frame))
    return lines.at(-1)!
  }
  return { bot, bridge, lines, logs, ask }
}

describe('bridge line protocol', () => {
  it('says hello, passes protocol requests through and answers in the documented shapes', async () => {
    const { bridge, lines, ask } = harness()
    bridge.hello()
    assert.deepEqual(lines[0], { event: 'hello', body: { v: 1, bridge: 'test', name: 'Fake' } })
    assert.deepEqual(await ask({ id: 1, type: 'chat.history', body: { channelId: 1 } }), { id: 1, ok: true, body: { echoed: { channelId: 1 } } })
    assert.deepEqual(await ask({ id: 'a', type: 'nope' }),
      { id: 'a', ok: false, error: { code: 'forbidden', message: 'Not for bots.', key: 'bot_no_read' } })
    assert.deepEqual(await ask('{"id": 2, "type": "chat.send", "body": []}'), { id: 2, ok: false, error: { code: 'bad_request', message: '"body" must be an object.' } })
    assert.equal(((await ask('{oops')) as { error: { code: string } }).error.code, 'bad_request')
    assert.equal(((await ask({ id: 3, type: 'bridge.nothing' })) as { error: { code: string } }).error.code, 'unknown_type')
    assert.equal(((await ask({ id: {}, type: 'ping' })) as { id: unknown }).id, null)
  })

  it('registers commands, forwards them with a ref, and answers through it', async () => {
    const { bot, lines, ask } = harness()
    const set = await ask({ id: 1, type: 'bridge.commands', body: { commands: [
      { name: 'roll', description: 'Rolls dice', options: [{ name: 'dice', description: 'Like 2d6', type: 'string' }] },
      { name: 'coin', description: 'Flips a coin' }] } })
    assert.deepEqual(set, { id: 1, ok: true, body: { commands: ['help', 'roll', 'coin'] } })
    // Setting the list again replaces it (help stays built in).
    await ask({ id: 2, type: 'bridge.commands', body: { commands: [{ name: 'roll', description: 'Rolls dice' }] } })
    assert.deepEqual([...bot.commandsByName.keys()], ['roll'])
    assert.equal(((await ask({ id: 3, type: 'bridge.commands', body: { commands: [{ name: 'help', description: 'x' }] } })) as { ok: boolean }).ok, false)
    assert.equal(((await ask({ id: 4, type: 'bridge.commands', body: { commands: [{ name: '/bad', description: 'x' }] } })) as { ok: boolean }).ok, false)

    const answers = bot.invoke('roll')
    const event = lines.at(-1) as { event: string; ref: string; body: Record<string, unknown> }
    assert.equal(event.event, 'command')
    assert.deepEqual(event.body, { command: 'roll', args: '2d6', options: { dice: '2d6' }, user: 'U'.repeat(43), userName: 'Viktor', channelId: 1, dm: false, private: false })
    assert.deepEqual(await ask({ id: 5, type: 'bridge.defer', body: { ref: event.ref } }), { id: 5, ok: true, body: {} })
    assert.deepEqual(await ask({ id: 6, type: 'bridge.reply', body: { ref: event.ref, text: 'rolled 7', private: true } }),
      { id: 6, ok: true, body: { message: { id: 7 } } })
    assert.deepEqual(answers, [['defer'], ['reply', { text: 'rolled 7' }, { private: true }]])
    assert.equal(((await ask({ id: 7, type: 'bridge.reply', body: { ref: 'r999', text: 'x' } })) as { error: { code: string } }).error.code, 'unknown_ref')
    assert.equal(((await ask({ id: 8, type: 'bridge.update', body: { ref: event.ref, text: 'x' } })) as { error: { code: string } }).error.code, 'bad_request')
  })

  it('forwards messages, clicks and DMs, and answers each the right way', async () => {
    const { bot, lines, ask } = harness()
    const reacted: string[] = []
    bot.emit('message', { id: 3, channelId: 1, author: 'U', text: 'hi @Fake', authorName: 'Viktor', channel: bot.channels[0],
      reply: async (c: unknown) => ({ id: 4, replied: c }), react: async (e: string) => void reacted.push(e) })
    const message = lines.at(-1) as { event: string; ref: string; body: { message: Record<string, unknown>; authorName: string } }
    assert.equal(message.event, 'message')
    assert.deepEqual(message.body, { message: { id: 3, channelId: 1, author: 'U', text: 'hi @Fake' }, authorName: 'Viktor' })
    await ask({ id: 1, type: 'bridge.react', body: { ref: message.ref, emoji: '👋' } })
    assert.deepEqual(reacted, ['👋'])
    assert.deepEqual(await ask({ id: 2, type: 'bridge.reply', body: { ref: message.ref, text: 'hello' } }),
      { id: 2, ok: true, body: { message: { id: 4, replied: { text: 'hello' } } } })

    const updates: unknown[] = []
    void bot.components[0]({ customId: 'roll:2d6', values: [], user: 'U', userName: 'Viktor', channelId: 1, messageId: 9, interaction: { private: false },
      update: async (c: unknown) => void updates.push(c) })
    const click = lines.at(-1) as { event: string; ref: string; body: Record<string, unknown> }
    assert.deepEqual([click.event, click.body.customId, click.body.messageId], ['component', 'roll:2d6', 9])
    await ask({ id: 3, type: 'bridge.update', body: { ref: click.ref, text: 'again', components: [] } })
    assert.deepEqual(updates, [{ text: 'again', components: [] }])

    const dmReplies: unknown[] = []
    bot.emit('dm', { id: 'd1', from: 'U', authorName: 'Viktor', text: 'hi', sentAt: 1, files: [], reply: async (c: unknown) => void dmReplies.push(c) })
    const dm = lines.at(-1) as { event: string; ref: string; body: Record<string, unknown> }
    assert.deepEqual(dm.body, { id: 'd1', from: 'U', authorName: 'Viktor', text: 'hi', sentAt: 1, files: [] })
    await ask({ id: 4, type: 'bridge.reply', body: { ref: dm.ref, text: 'hey' } })
    assert.deepEqual(dmReplies, [{ text: 'hey' }])

    await ask({ id: 5, type: 'bridge.send', body: { channelId: 1, text: 'news', cards: [{ title: 'x' }] } })
    await ask({ id: 6, type: 'bridge.upload', body: { name: 'a.txt', data: Buffer.from('hello').toString('base64') } })
    assert.deepEqual(bot.calls.slice(-2), [['send', 1, { text: 'news', cards: [{ title: 'x' }] }], ['upload', 'a.txt', 'hello']])
    assert.deepEqual(await ask({ id: 7, type: 'bridge.dmFile', body: { file: { id: 'x' } } }), { id: 7, ok: true, body: { data: 'AQID' } })
  })

  it('passes stray prints to the log and refuses lines that are too long', async () => {
    const { bridge, lines, logs } = harness()
    await bridge.line('hello from print()')
    assert.deepEqual(logs, ['(program) hello from print()'])
    assert.equal(lines.length, 0)

    const input = new PassThrough()
    const got: string[] = []
    let tooLong = 0
    const done = readLines(input, (l) => got.push(l), () => tooLong++, 10)
    input.write('one\r\ntw')
    input.write('o\n0123456789ABC')
    input.write('DEF\nthree')
    input.end()
    await done
    assert.deepEqual(got, ['one', 'two', 'three'])
    assert.equal(tooLong, 1)
    bridge.tooLong()
    assert.deepEqual(lines.at(-1), { id: null, ok: false, error: { code: 'too_large', message: `A line can be at most ${MAX_LINE_BYTES} bytes.` } })
  })

  it('runs a program and talks to it over its stdin and stdout', async () => {
    const bot = new FakeBot()
    // A tiny bot in "another language": registers /roll, answers it, then exits.
    const program = `
      const rl = require('node:readline').createInterface({ input: process.stdin })
      rl.on('line', (line) => {
        const msg = JSON.parse(line)
        if (msg.event === 'hello') {
          console.log('not json: ignored')
          console.log(JSON.stringify({ id: 1, type: 'bridge.commands', body: { commands: [{ name: 'roll', description: 'Rolls dice' }] } }))
        } else if (msg.id === 1) {
          console.error('registered')
        } else if (msg.event === 'command') {
          console.log(JSON.stringify({ id: 2, type: 'bridge.reply', body: { ref: msg.ref, text: 'rolled ' + msg.body.args } }))
        } else if (msg.id === 2) {
          process.exit(msg.ok ? 7 : 1)
        }
      })`
    const logs: string[] = []
    const { exited } = spawnProgram(process.execPath, ['-e', program], (write) => {
      const bridge = new Bridge(bot as unknown as BridgeBot, { write, log: (l) => logs.push(l), version: 'test' })
      bridge.hello()
      return bridge
    })
    for (let i = 0; i < 200 && !bot.commandsByName.has('roll'); i++) await new Promise((r) => setTimeout(r, 25))
    const answers = bot.invoke('roll')
    assert.equal(await exited, 7)
    assert.deepEqual(answers, [['reply', { text: 'rolled 2d6' }, { private: false }]])
    assert.deepEqual(logs, ['(program) not json: ignored'])
  })
})

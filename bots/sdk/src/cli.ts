#!/usr/bin/env node
// The iskra-bots command line. One command for now: the any-language bridge (docs/bots.md, "Other languages").
//   iskra-bots bridge --name Dice [--invite <link>] [--state dice.bot.json] [--hear-bots] [--raw] [-- program args...]
import { Bot } from './bot'
import { BRIDGE_PROTOCOL, Bridge, connect, lineWriter, spawnProgram } from './bridge'

declare const ISKRA_BOTS_VERSION: string | undefined
const version = typeof ISKRA_BOTS_VERSION === 'string' ? ISKRA_BOTS_VERSION : 'dev'

const USAGE = `iskra-bots ${version}

  iskra-bots bridge --name <bot name> [options] [-- <program> [args...]]

Logs in as a bot (the normal signed handshake) and talks newline-delimited JSON (protocol v${BRIDGE_PROTOCOL}) with a program:
over that program's stdin and stdout when you give one after "--", or over this process's own stdin and stdout
otherwise. No HTTP, no listening sockets. See docs/bots.md, "Other languages".

Options:
  --name <name>     The bot's display name (or ISKRA_BOT_NAME)
  --invite <link>   A bot invite link, only needed the first time (or ISKRA_INVITE)
  --state <file>    Where the keys are kept (default: <name>.bot.json; or ISKRA_BOT_STATE)
  --hear-bots       Also hear other bots and webhooks
  --raw             Also forward every server event ({"event":"server","type":...})
`

interface Args {
  name?: string
  invite?: string
  state?: string
  hearBots: boolean
  raw: boolean
  program: string[]
}

export function parseArgs(argv: string[]): Args | string {
  const args: Args = { hearBots: false, raw: false, program: [], name: process.env.ISKRA_BOT_NAME, invite: process.env.ISKRA_INVITE, state: process.env.ISKRA_BOT_STATE }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value.`)
      return v
    }
    try {
      if (arg === '--') {
        args.program = argv.slice(i + 1)
        break
      } else if (arg === '--name') args.name = value()
      else if (arg === '--invite') args.invite = value()
      else if (arg === '--state') args.state = value()
      else if (arg === '--hear-bots') args.hearBots = true
      else if (arg === '--raw') args.raw = true
      else return `Unknown option ${arg}.`
    } catch (e) {
      return (e as Error).message
    }
  }
  if (!args.name) return 'Give the bot a name: --name <name> (or ISKRA_BOT_NAME).'
  return args
}

async function bridge(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (typeof args === 'string') {
    process.stderr.write(`${args}\n\n${USAGE}`)
    return 2
  }
  // The program's channel is stdout (ours, or the program's stdin): the bridge's own notes go to stderr.
  const log = (line: string) => void process.stderr.write(`${line}\n`)
  const bot = new Bot({ name: args.name!, invite: args.invite, stateFile: args.state, hearBots: args.hearBots, log })
  // Requests from the program wait until the bot is online.
  let markStarted: (ok: boolean, reason?: string) => void = () => undefined
  const gate = new Promise<void>((done, fail) => {
    markStarted = (ok, reason) => (ok ? done() : fail(Object.assign(new Error(reason ?? 'The bot stopped.'), { code: 'disconnected' })))
  })
  gate.catch(() => undefined)
  let current: Bridge | null = null
  const makeBridge = (write: (line: string) => void) => {
    current = new Bridge(bot, { write, log, raw: args.raw, version: `iskra-bots ${version}`, started: gate })
    current.hello()
    return current
  }

  const stopBot = () => bot.stop()
  let program: ReturnType<typeof spawnProgram> | null = null
  let inputDone: Promise<void> | null = null
  if (args.program.length) {
    program = spawnProgram(args.program[0], args.program.slice(1), makeBridge)
  } else {
    const b = makeBridge(lineWriter(process.stdout))
    inputDone = connect(b, process.stdin)
  }
  process.once('SIGINT', () => {
    program?.kill()
    stopBot()
    process.exit(130)
  })

  try {
    await bot.start()
    markStarted(true)
  } catch (e) {
    const reason = (e as Error).message
    markStarted(false, reason)
    current!.stopped(reason)
    log(`${args.name} couldn't start: ${reason}`)
    if (program) {
      // Give the program a moment to read "stopped" and exit by itself.
      const timer = setTimeout(() => program!.kill(), 2000)
      await program.exited
      clearTimeout(timer)
    }
    return 1
  }
  // Turned away later (removed from the server, banned): say so and end.
  let ended: (code: number) => void = () => undefined
  const turnedAway = new Promise<number>((done) => (ended = done))
  bot.on('status', (status) => {
    if (status.state !== 'rejected') return
    current?.stopped(status.message)
    if (program) setTimeout(() => program!.kill(), 2000)
    ended(1)
  })

  const code = await Promise.race([program ? program.exited : inputDone!.then(() => 0), turnedAway])
  stopBot()
  return code
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'bridge') return bridge(rest)
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${version}\n`)
    return 0
  }
  process.stderr.write(USAGE)
  return command === undefined || command === '--help' || command === '-h' ? 0 : 2
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e: Error) => {
  process.stderr.write(`${e.message}\n`)
  process.exit(1)
})

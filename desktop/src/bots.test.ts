import assert from 'node:assert/strict'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { after, test } from 'node:test'
import {
  BotRunner, botEnv, cleanSettings, findEntry, isInvite, LOG_LINES_PER_SECOND, MAX_LOG_BYTES, ONLINE_LINE, parseGallery, resolvePython,
  type Confirm, type GalleryBot, type RunnerOptions,
} from './bots'

const root = mkdtempSync(path.join(tmpdir(), 'iskra-bots-test-'))
after(() => rmSync(root, { recursive: true, force: true }))

const INVITE = 'http://localhost:47070/#/join/abc.def.ghi'
const ONLINE = (name: string) => `[${name}] Online in "Friends" as ${name} (member)\n`
const gallery: GalleryBot[] = parseGallery({
  bots: [
    { id: 'trivia', name: 'Trivia', settings: [{ env: 'TRIVIA_SECONDS', kind: 'number', default: '20' }] },
    { id: 'feeds-advanced', name: 'Feeds Plus', settings: [{ env: 'TWITCH_CLIENT_ID', kind: 'text' }, { env: 'TWITCH_CLIENT_SECRET', kind: 'secret' }] },
    { id: '../evil', name: 'x' },
  ],
})

/** A child process the test drives: what it prints, and when it exits. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
  pid: number
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  exit(code: number | null, signal: string | null = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

function runner(dir: string, platform: NodeJS.Platform = 'linux', extra: Partial<RunnerOptions> = {}) {
  const spawned: { command: string; args: string[]; options: SpawnOptions; child: FakeChild }[] = []
  const events: string[] = []
  const killed: number[] = []
  const r = new BotRunner({
    root: dir,
    execPath: '/app/iskra',
    galleryDir: '/app/resources/app.asar.unpacked/dist/gallery',
    gallery,
    platform,
    env: { PATH: '/bin', NODE_OPTIONS: '--inspect', ELECTRON_ENABLE_LOGGING: '1', ISKRA_INVITE: 'stale', ISKRA_BOT_STATE: '/x.json', HOME: '/home/me' },
    spawn: (command, args, options) => {
      const child = new FakeChild(5000 + spawned.length)
      spawned.push({ command, args, options, child })
      return child as unknown as ChildProcess
    },
    killTree: (pid) => killed.push(pid),
    where: () => [],
    onEvent: (event, id, detail) => events.push(`${event} ${id} ${detail}`),
    ...extra,
  })
  return { r, spawned, events, killed }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('the gallery manifest: only well-formed bots and settings, never variables that change what runs', () => {
  assert.deepEqual(gallery.map((g) => g.id), ['trivia', 'feeds-advanced'])
  assert.deepEqual(gallery[0].settings, [{ env: 'TRIVIA_SECONDS', kind: 'number', default: '20' }])
  assert.deepEqual(parseGallery(null), [])
  const denied = parseGallery({ bots: [{ id: 'x', name: 'X', settings: ['PATH', 'NODE_PATH', 'PYTHONPATH', 'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'ISKRA_BOT_STATE', 'OK_ONE']
    .map((env) => ({ env, kind: 'text' })) }] })
  assert.deepEqual(denied[0].settings.map((s) => s.env), ['OK_ONE'])
  // The real one parses, and every bot in it has a bot.ts in the repository.
  const real = parseGallery(JSON.parse(readFileSync(path.join(__dirname, '..', 'assets', 'gallery.json'), 'utf8')))
  assert.ok(real.length >= 4)
  for (const g of real) assert.ok(existsSync(path.join(__dirname, '..', '..', 'bots', 'gallery', g.id, 'bot.ts')), g.id)
  assert.equal(real.find((g) => g.id === 'server-stats')?.readAll, true)
})

test('a gallery bot runs with the app\'s Node, in its own folder, with its settings and the invite', async () => {
  const dir = path.join(root, 'gallery')
  const { r, spawned, events } = runner(dir)
  const bot = r.add({ gallery: 'trivia' }, '  Quiz\nMaster ')!
  assert.equal(bot.name, 'QuizMaster')
  assert.deepEqual(bot.settings, { TRIVIA_SECONDS: '20' })
  assert.equal(bot.needsInvite, true)
  await r.update(bot.id, { settings: { TRIVIA_SECONDS: '45', OTHER: 'x' } })
  assert.deepEqual(r.list()[0].settings, { TRIVIA_SECONDS: '45' }) // only declared settings

  await r.start(bot.id, INVITE)
  const [run] = spawned
  assert.equal(run.command, '/app/iskra')
  assert.deepEqual(run.args, [path.join('/app/resources/app.asar.unpacked/dist/gallery', 'trivia.cjs')])
  assert.equal(run.options.cwd, path.join(dir, 'trivia'))
  const env = run.options.env as Record<string, string>
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.ISKRA_INVITE, INVITE)
  assert.equal(env.BOT_NAME, 'QuizMaster')
  assert.equal(env.TRIVIA_SECONDS, '45')
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.ISKRA_BOT_STATE, undefined)
  assert.equal(env.ELECTRON_ENABLE_LOGGING, undefined)
  assert.equal(r.list()[0].state, 'starting')
  // The invite never reaches the disk.
  assert.ok(!readFileSync(path.join(dir, 'bots.json'), 'utf8').includes('join'))

  // Only the SDK's exact line counts as online (not a message that happens to contain the words).
  run.child.stdout.write('someone said: Online in "Friends" as a joke\n')
  await tick()
  assert.equal(r.list()[0].online, false)
  run.child.stdout.write(ONLINE('QuizMaster'))
  await tick()
  assert.equal(r.list()[0].state, 'running')
  assert.equal(r.list()[0].online, true)
  writeFileSync(path.join(dir, 'trivia', 'quizmaster.bot.json'), JSON.stringify({ server: { url: 'http://localhost', key: 'k' } }))
  assert.equal(r.list()[0].needsInvite, false)
  r.flush()
  assert.ok(!readFileSync(path.join(dir, 'trivia', 'bot.log'), 'utf8').includes('join/'))

  let killed = 0
  const stopped = r.stop(bot.id, (child) => {
    killed++
    ;(child as unknown as FakeChild).exit(null, 'SIGTERM')
  })
  assert.equal((await stopped)?.state, 'stopped')
  assert.equal(killed, 1)
  await r.start(bot.id)
  assert.equal((spawned[1].options.env as Record<string, string>).ISKRA_INVITE, undefined)
  assert.deepEqual(events.slice(0, 2), ['started trivia node', 'stopped trivia null'])
})

test('the exact online line of both SDKs', () => {
  assert.ok(ONLINE_LINE.test('[Trivia] Online in "My \\"server\\"" as Trivia (member)'))
  assert.ok(!ONLINE_LINE.test('x [Trivia] Online in "S" as Trivia (member)'))
  assert.ok(!ONLINE_LINE.test('[Trivia] Online in "S" as Trivia (admin)'))
})

test('secrets never reach the page, survive edits, and are encrypted at rest when there is a keychain', async () => {
  const dir = path.join(root, 'secrets')
  const box = { encrypt: (t: string) => Buffer.from(t).toString('base64').split('').reverse().join(''), decrypt: (t: string) => Buffer.from(t.split('').reverse().join(''), 'base64').toString() }
  const { r, spawned } = runner(dir, 'linux', { secrets: box })
  const bot = r.add({ gallery: 'feeds-advanced' })!
  await r.update(bot.id, { settings: { TWITCH_CLIENT_ID: 'abc', TWITCH_CLIENT_SECRET: 's3cret' } })
  const shown = r.list()[0]
  assert.deepEqual(shown.settings, { TWITCH_CLIENT_ID: 'abc' })
  assert.deepEqual(shown.secretsSet, ['TWITCH_CLIENT_SECRET'])
  assert.ok(!JSON.stringify(r.list()).includes('s3cret'))
  const file = readFileSync(path.join(dir, 'bots.json'), 'utf8')
  assert.ok(!file.includes('s3cret') && file.includes('"enc:'))
  // The page saves other settings without the secret (it never had it): the secret stays.
  await r.update(bot.id, { settings: { TWITCH_CLIENT_ID: 'xyz' } })
  await r.update(bot.id, { settings: { TWITCH_CLIENT_ID: 'xyz', TWITCH_CLIENT_SECRET: '' } })
  // After the app restarts it's still there, decrypted for the bot only.
  const again = runner(dir, 'linux', { secrets: box })
  await again.r.start(bot.id)
  assert.equal((again.spawned[0].options.env as Record<string, string>).TWITCH_CLIENT_SECRET, 's3cret')
  assert.equal((again.spawned[0].options.env as Record<string, string>).TWITCH_CLIENT_ID, 'xyz')
  // null clears it.
  await again.r.update(bot.id, { settings: { TWITCH_CLIENT_SECRET: null } })
  assert.deepEqual(again.r.list()[0].secretsSet, [])
  assert.equal(spawned.length, 0)
  // Without a keychain it's kept as-is, in a file only this user can read.
  const plain = runner(path.join(root, 'secrets-plain'))
  const b = plain.r.add({ gallery: 'feeds-advanced' })!
  await plain.r.update(b.id, { settings: { TWITCH_CLIENT_SECRET: 'pw' } })
  assert.ok(readFileSync(path.join(root, 'secrets-plain', 'bots.json'), 'utf8').includes('"pw"'))
})

test('cleanSettings merges onto what is stored', () => {
  const declared = gallery[1].settings.concat(gallery[0].settings)
  const current = { TWITCH_CLIENT_SECRET: 'keep', TRIVIA_SECONDS: '20' }
  assert.deepEqual(cleanSettings({ TRIVIA_SECONDS: 'abc' }, declared, current), { TWITCH_CLIENT_SECRET: 'keep', TRIVIA_SECONDS: '20' })
  assert.deepEqual(cleanSettings({ TWITCH_CLIENT_SECRET: ' new\n ' }, declared, current), { TWITCH_CLIENT_SECRET: 'new', TRIVIA_SECONDS: '20' })
  assert.deepEqual(cleanSettings({ TWITCH_CLIENT_SECRET: null, TRIVIA_SECONDS: '' }, declared, current), { TRIVIA_SECONDS: '' })
})

test('files only this user can read', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const dir = path.join(root, 'modes')
  const { r, spawned } = runner(dir)
  const bot = r.add({ gallery: 'trivia' })!
  await r.start(bot.id)
  spawned[0].child.stdout.write('hello\n')
  await tick()
  r.flush()
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(path.join(dir, 'bots.json')).mode & 0o777, 0o600)
  assert.equal(statSync(path.join(dir, 'trivia')).mode & 0o777, 0o700)
  assert.equal(statSync(path.join(dir, 'trivia', 'bot.log')).mode & 0o777, 0o600)
  assert.equal(statSync(path.join(dir, 'trivia', 'bot.pid')).mode & 0o777, 0o600)
})

test('a bot that ends by itself is reported, and its log keeps the last lines', async () => {
  const dir = path.join(root, 'crash')
  const { r, spawned, events } = runner(dir)
  const bot = r.add({ gallery: 'feeds-advanced' })!
  await r.start(bot.id)
  const child = spawned[0].child
  child.stdout.write('\u001b[32mhello\u001b[0m\npart')
  child.stdout.write('ial line\n')
  child.stderr.write('Feeds Plus couldn\'t start: no server\n')
  for (let i = 0; i < 150; i++) child.stdout.write(`line ${i}\n`)
  child.stdout.write('last words without newline')
  await tick()
  child.exit(1)
  const status = r.list()[0]
  assert.equal(status.state, 'failed')
  assert.equal(status.problem, '1')
  assert.ok(events.includes('exited feeds-advanced 1'))
  assert.ok(!existsSync(path.join(dir, bot.id, 'bot.pid')))
  const tail = r.tail(bot.id, 1000)
  assert.equal(tail.at(-2), 'last words without newline')
  assert.match(tail.at(-1)!, /ended by itself \(exit 1\)/)
  assert.equal(r.tail(bot.id, 5).length, 5)
  // After the app restarts, the log comes from bot.log, colours gone.
  const again = runner(dir).r
  assert.deepEqual(again.tail(bot.id, 1000), tail.slice(-300))
  const file = readFileSync(path.join(r.dataDir(bot.id), 'bot.log'), 'utf8').split('\n')
  assert.ok(file.includes('hello'))
  assert.ok(file.includes('partial line'))
})

test('a chatty bot: lines over the rate are skipped and counted, and bot.log stays under its cap while running', async () => {
  const dir = path.join(root, 'chatty')
  const { r, spawned } = runner(dir)
  const bot = r.add({ gallery: 'trivia' })!
  await r.start(bot.id)
  const child = spawned[0].child
  const long = 'x'.repeat(900)
  // Enough to pass 1 MB many times over, in bursts over many "seconds" (Date.now moves on between bursts).
  const realNow = Date.now
  let fake = realNow()
  Date.now = () => fake
  try {
    for (let s = 0; s < 20; s++) {
      fake += 1000
      child.stdout.write(Array.from({ length: LOG_LINES_PER_SECOND + 50 }, (_, i) => `${s}:${i} ${long}`).join('\n') + '\n')
      await tick()
      r.flush()
    }
  } finally {
    Date.now = realNow
  }
  const size = statSync(path.join(dir, bot.id, 'bot.log')).size
  assert.ok(size <= MAX_LOG_BYTES, `bot.log is ${size} bytes`)
  assert.ok(r.tail(bot.id, 300).some((l) => /── 50 lines skipped/.test(l)))
  child.exit(0)
})

test('autostart is opt-in and remembered; removing a gallery bot deletes its folder', async () => {
  const dir = path.join(root, 'auto')
  const { r } = runner(dir)
  const a = r.add({ gallery: 'trivia' })!
  const b = r.add({ gallery: 'trivia' })!
  assert.notEqual(a.id, b.id)
  assert.deepEqual(r.autostartIds(), [])
  await r.update(b.id, { autostart: true })
  await r.update(a.id, { autostart: 'yes' }) // not a boolean: ignored
  assert.deepEqual(runner(dir).r.autostartIds(), [b.id])
  mkdirSync(r.dataDir(b.id), { recursive: true })
  writeFileSync(path.join(r.dataDir(b.id), 'trivia.bot.json'), '{}')
  assert.ok(await r.remove(b.id))
  assert.ok(!existsSync(r.dataDir(b.id)))
  assert.deepEqual(r.list().map((x) => x.id), [a.id])
})

test('a folder bot runs only after a native confirm, and autostart for it asks too', async () => {
  const folder = path.join(root, 'trusty')
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'bot.js'), '')
  const asked: string[] = []
  let answer = false
  const confirm: Confirm = async (kind, b) => {
    asked.push(`${kind} ${b.name}`)
    return answer
  }
  const { r, spawned } = runner(path.join(root, 'trust'), 'linux', { confirm })
  const bot = r.add({ folder })!
  await r.start(bot.id)
  assert.equal(spawned.length, 0)
  assert.equal(r.list()[0].problem, 'not-trusted')
  await r.update(bot.id, { autostart: true })
  assert.equal(r.list()[0].autostart, false)
  assert.deepEqual(asked, ['trust-folder trusty', 'autostart-folder trusty'])
  answer = true
  await r.start(bot.id)
  assert.equal(spawned.length, 1)
  assert.deepEqual(spawned[0].args, [path.join(folder, 'bot.js')])
  await r.start(bot.id) // already running: no second ask
  assert.equal(asked.length, 3)
  await r.update(bot.id, { autostart: true })
  assert.equal(r.list()[0].autostart, true)
  assert.deepEqual(r.autostartIds(), [bot.id])
  // Without a way to ask (no confirm), nothing from a folder runs.
  const quiet = runner(path.join(root, 'trust2'), 'linux', { confirm: undefined })
  const other = quiet.r.add({ folder })!
  await quiet.r.start(other.id)
  assert.equal(quiet.spawned.length, 0)
})

test('Python: an absolute interpreter, never the Store stub or one in the bot\'s folder', async () => {
  const where = (found: Record<string, string[]>) => (name: string) => found[name] ?? []
  const stub = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'
  assert.deepEqual(resolvePython('win32', where({ py: ['C:\\Windows\\py.exe'], python: [stub] })), { command: 'C:\\Windows\\py.exe', args: ['-3'] })
  assert.deepEqual(resolvePython('win32', where({ python: [stub, 'C:\\Python312\\python.exe'] })), { command: 'C:\\Python312\\python.exe', args: [] })
  assert.equal(resolvePython('win32', where({ python: [stub, 'python.exe'] })), null)
  assert.deepEqual(resolvePython('linux', where({ python3: ['/usr/bin/python3'] })), { command: '/usr/bin/python3', args: [] })
  assert.equal(resolvePython('darwin', where({})), null)

  const folder = path.join(root, 'my-bot')
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'bot.py'), 'print(1)')
  const yes: Confirm = async () => true
  // No Python: the bot isn't started at all.
  const none = runner(path.join(root, 'nopy'), 'win32', { confirm: yes, where: where({ python: [stub] }) })
  const a = none.r.add({ folder })!
  await none.r.start(a.id)
  assert.equal(none.spawned.length, 0)
  assert.equal(none.r.list()[0].problem, 'no-python')
  // With the launcher: py -3 bot.py, the bot's own folder as working directory, detached only off Windows.
  const { r, spawned, events } = runner(path.join(root, 'folders'), 'win32', { confirm: yes, where: where({ py: ['C:\\Windows\\py.exe'] }) })
  const bot = r.add({ folder })!
  await r.start(bot.id, INVITE)
  assert.equal(spawned[0].command, 'C:\\Windows\\py.exe')
  assert.deepEqual(spawned[0].args, ['-3', path.join(folder, 'bot.py')])
  assert.equal(spawned[0].options.cwd, folder)
  assert.equal((spawned[0].options.env as Record<string, string>).ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(spawned[0].options.detached, false)
  // Windows' "not found" exit code reads as Python missing.
  spawned[0].child.exit(9009)
  assert.equal(r.list()[0].problem, 'no-python')
  assert.ok(events.includes('exited my-bot 9009'))

  const empty = path.join(root, 'empty-bot')
  mkdirSync(empty)
  const nothing = r.add({ folder: empty })!
  await r.start(nothing.id)
  assert.equal(r.list()[1].problem, 'no-entry')
  assert.equal(spawned.length, 1)
  assert.equal(r.add({ folder: 'relative/path' }), null)
})

test('bots never outlive the app: killed at quit, and leftovers from a crash are killed before autostart', async () => {
  const dir = path.join(root, 'quit')
  const { r, spawned, killed, events } = runner(dir)
  const a = r.add({ gallery: 'trivia' })!
  const b = r.add({ gallery: 'feeds-advanced' })!
  await r.update(a.id, { autostart: true })
  await r.start(a.id)
  await r.start(b.id)
  const pidA = JSON.parse(readFileSync(path.join(dir, a.id, 'bot.pid'), 'utf8'))
  assert.deepEqual(pidA, { pid: spawned[0].child.pid, script: spawned[0].args[0] })
  // The app quits: both ended right away (no timers), and their exits aren't reported as crashes.
  r.killAll()
  assert.deepEqual(killed, [spawned[0].child.pid, spawned[1].child.pid])
  spawned[0].child.exit(null, 'SIGKILL')
  assert.ok(!events.some((e) => e.startsWith('exited')))

  // A crash instead: bot.pid files stay behind; at the next start, only processes still running that bot are killed.
  writeFileSync(path.join(dir, a.id, 'bot.pid'), JSON.stringify({ pid: 777, script: spawned[0].args[0] }))
  writeFileSync(path.join(dir, b.id, 'bot.pid'), JSON.stringify({ pid: 778, script: spawned[1].args[0] }))
  const lines: Record<number, string> = { 777: `/app/iskra ${spawned[0].args[0]}`, 778: '/usr/bin/some-other-program' }
  const next = runner(dir, 'linux', { commandLine: (pid) => lines[pid] ?? null })
  assert.equal(next.r.killLeftovers(), 1)
  assert.deepEqual(next.killed, [777])
  assert.ok(!existsSync(path.join(dir, a.id, 'bot.pid')) && !existsSync(path.join(dir, b.id, 'bot.pid')))
  assert.deepEqual(next.r.autostartIds(), [a.id])
})

test('finding a folder bot\'s entry', () => {
  const files = new Set(['/b/dist/main.js', '/b/bot.py', '/c/index.ts', '/outside.js'].map((f) => path.resolve(f)))
  const exists = (p: string) => files.has(path.resolve(p))
  const pkg = (main: string) => () => JSON.stringify({ main })
  assert.deepEqual(findEntry(path.resolve('/b'), exists, pkg('dist/main.js')), { file: path.resolve('/b/dist/main.js'), runtime: 'node' })
  assert.deepEqual(findEntry(path.resolve('/b'), exists, pkg('../outside.js')), { file: path.resolve('/b/bot.py'), runtime: 'python' }) // never outside the folder
  assert.deepEqual(findEntry(path.resolve('/c'), exists, () => { throw new Error('none') }), { file: path.resolve('/c/index.ts'), runtime: 'node' })
  assert.equal(findEntry(path.resolve('/d'), exists, () => '{}'), null)
})

test('invites and the environment', () => {
  assert.ok(isInvite(INVITE))
  assert.ok(isInvite('https://chat.example.com/#/join/x'))
  assert.ok(!isInvite('https://chat.example.com/'))
  assert.ok(!isInvite('javascript:alert(1)#/join/x'))
  assert.ok(!isInvite(42))
  const env = botEnv({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', ISKRA_LOCAL_ONLY: '1', ISKRA_BOT_STATE: 's' }, 'python', { BOT_NAME: 'X' })
  assert.deepEqual(env, { PATH: 'p', ISKRA_LOCAL_ONLY: '1', PYTHONUNBUFFERED: '1', FORCE_COLOR: '0', BOT_NAME: 'X' })
  assert.deepEqual(readdirSync(root).filter((f) => f.endsWith('.json')), [])
})

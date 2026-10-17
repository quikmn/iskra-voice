import assert from 'node:assert/strict'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { after, test } from 'node:test'
import { BotRunner, botEnv, cleanSettings, findEntry, isInvite, parseGallery, type GalleryBot } from './bots'

const root = mkdtempSync(path.join(tmpdir(), 'iskra-bots-test-'))
after(() => rmSync(root, { recursive: true, force: true }))

const INVITE = 'http://localhost:47070/#/join/abc.def.ghi'
const gallery: GalleryBot[] = parseGallery({
  bots: [
    { id: 'trivia', name: 'Trivia', settings: [{ env: 'TRIVIA_SECONDS', kind: 'number', default: '20' }] },
    { id: 'feeds-advanced', name: 'Feeds Plus', settings: [{ env: 'TWITCH_CLIENT_SECRET', kind: 'secret' }] },
    { id: '../evil', name: 'x' },
  ],
})

/** A child process the test drives: what it prints, and when it exits. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
  pid = 4242
  exit(code: number | null, signal: string | null = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

function runner(dir: string, platform: NodeJS.Platform = 'linux') {
  const spawned: { command: string; args: string[]; options: SpawnOptions; child: FakeChild }[] = []
  const events: string[] = []
  const r = new BotRunner({
    root: dir,
    execPath: '/app/iskra',
    galleryDir: '/app/resources/app.asar.unpacked/dist/gallery',
    gallery,
    platform,
    env: { PATH: '/bin', NODE_OPTIONS: '--inspect', ELECTRON_ENABLE_LOGGING: '1', ISKRA_INVITE: 'stale', HOME: '/home/me' },
    spawn: (command, args, options) => {
      const child = new FakeChild()
      spawned.push({ command, args, options, child })
      return child as unknown as ChildProcess
    },
    onEvent: (event, id, detail) => events.push(`${event} ${id} ${detail}`),
  })
  return { r, spawned, events }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('the gallery manifest: only well-formed bots and settings', () => {
  assert.deepEqual(gallery.map((g) => g.id), ['trivia', 'feeds-advanced'])
  assert.deepEqual(gallery[0].settings, [{ env: 'TRIVIA_SECONDS', kind: 'number', default: '20' }])
  assert.deepEqual(parseGallery(null), [])
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
  r.update(bot.id, { settings: { TRIVIA_SECONDS: '45', OTHER: 'x' } })
  assert.deepEqual(r.list()[0].settings, { TRIVIA_SECONDS: '45' }) // only declared settings

  r.start(bot.id, INVITE)
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
  assert.equal(env.ELECTRON_ENABLE_LOGGING, undefined)
  assert.equal(r.list()[0].state, 'starting')
  // The invite never reaches the disk.
  assert.ok(!readFileSync(path.join(dir, 'bots.json'), 'utf8').includes('join'))

  // Online: the invite is used up, so a restart doesn't pass it again.
  run.child.stdout.write('[QuizMaster] Online in "Friends" as QuizMaster (member)\n')
  await tick()
  assert.equal(r.list()[0].state, 'running')
  assert.equal(r.list()[0].online, true)
  writeFileSync(path.join(dir, 'trivia', 'quizmaster.bot.json'), JSON.stringify({ server: { url: 'http://localhost', key: 'k' } }))
  assert.equal(r.list()[0].needsInvite, false)
  assert.ok(!readFileSync(path.join(dir, 'trivia', 'bot.log'), 'utf8').includes('join/'))

  let killed = 0
  const stopped = r.stop(bot.id, (child) => {
    killed++
    ;(child as unknown as FakeChild).exit(null, 'SIGTERM')
  })
  assert.equal((await stopped)?.state, 'stopped')
  assert.equal(killed, 1)
  r.start(bot.id)
  assert.equal((spawned[1].options.env as Record<string, string>).ISKRA_INVITE, undefined)
  assert.deepEqual(events.slice(0, 2), ['started trivia node', 'stopped trivia null'])
})

test('a bot that ends by itself is reported, and its log keeps the last lines', async () => {
  const dir = path.join(root, 'crash')
  const { r, spawned, events } = runner(dir)
  const bot = r.add({ gallery: 'feeds-advanced' })!
  r.start(bot.id)
  const child = spawned[0].child
  child.stdout.write('\u001b[32mhello\u001b[0m\npart')
  child.stdout.write('ial line\n')
  child.stderr.write('Feeds Plus couldn\'t start: no server\n')
  for (let i = 0; i < 400; i++) child.stdout.write(`line ${i}\n`)
  child.stdout.write('last words without newline')
  await tick()
  child.exit(1)
  const status = r.list()[0]
  assert.equal(status.state, 'failed')
  assert.equal(status.problem, '1')
  assert.ok(events.includes('exited feeds-advanced 1'))
  const tail = r.tail(bot.id, 1000)
  assert.equal(tail.length, 300)
  assert.equal(tail.at(-2), 'last words without newline')
  assert.match(tail.at(-1)!, /ended by itself \(exit 1\)/)
  assert.equal(r.tail(bot.id, 5).length, 5)
  // After the app restarts, the log comes from bot.log, colours gone.
  const again = runner(dir).r
  assert.deepEqual(again.tail(bot.id, 1000), tail)
  const file = readFileSync(path.join(r.dataDir(bot.id), 'bot.log'), 'utf8').split('\n')
  assert.ok(file.includes('hello'))
  assert.ok(file.includes('partial line'))
})

test('autostart is opt-in and remembered; removing a gallery bot deletes its folder', async () => {
  const dir = path.join(root, 'auto')
  const { r } = runner(dir)
  const a = r.add({ gallery: 'trivia' })!
  const b = r.add({ gallery: 'trivia' })!
  assert.notEqual(a.id, b.id)
  assert.deepEqual(r.autostartIds(), [])
  r.update(b.id, { autostart: true })
  r.update(a.id, { autostart: 'yes' }) // not a boolean: ignored
  assert.deepEqual(runner(dir).r.autostartIds(), [b.id])
  mkdirSync(r.dataDir(b.id), { recursive: true })
  writeFileSync(path.join(r.dataDir(b.id), 'trivia.bot.json'), '{}')
  assert.ok(await r.remove(b.id))
  assert.ok(!existsSync(r.dataDir(b.id)))
  assert.deepEqual(r.list().map((x) => x.id), [a.id])
})

test('a folder bot: its entry file decides the runtime; Python is the computer\'s own', async () => {
  const folder = path.join(root, 'my-bot')
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'bot.py'), 'print(1)')
  const { r, spawned, events } = runner(path.join(root, 'folders'), 'win32')
  const bot = r.add({ folder })!
  assert.equal(bot.kind, 'folder')
  assert.equal(bot.needsInvite, false)
  r.start(bot.id, INVITE)
  assert.equal(spawned[0].command, 'python')
  assert.equal(spawned[0].options.cwd, folder)
  assert.equal((spawned[0].options.env as Record<string, string>).ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(spawned[0].options.detached, false) // Windows: taskkill /T stops it
  // Python isn't installed.
  spawned[0].child.emit('error', Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' }))
  assert.equal(r.list()[0].problem, 'no-python')
  assert.ok(events.includes('failed my-bot no-python'))

  const empty = path.join(root, 'empty-bot')
  mkdirSync(empty)
  const none = r.add({ folder: empty })!
  r.start(none.id)
  assert.equal(r.list()[1].problem, 'no-entry')
  assert.equal(spawned.length, 1)
  assert.equal(r.add({ folder: 'relative/path' }), null)
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

test('invites, settings and the environment', () => {
  assert.ok(isInvite(INVITE))
  assert.ok(isInvite('https://chat.example.com/#/join/x'))
  assert.ok(!isInvite('https://chat.example.com/'))
  assert.ok(!isInvite('javascript:alert(1)#/join/x'))
  assert.ok(!isInvite(42))
  assert.deepEqual(cleanSettings({ TRIVIA_SECONDS: 'abc' }, gallery[0].settings), {})
  assert.deepEqual(cleanSettings({ TWITCH_CLIENT_SECRET: ' s3cret\n ' }, gallery[1].settings), { TWITCH_CLIENT_SECRET: 's3cret' })
  const env = botEnv({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', ISKRA_LOCAL_ONLY: '1' }, 'python', { BOT_NAME: 'X' })
  assert.deepEqual(env, { PATH: 'p', ISKRA_LOCAL_ONLY: '1', PYTHONUNBUFFERED: '1', FORCE_COLOR: '0', BOT_NAME: 'X' })
  assert.deepEqual(readdirSync(root).filter((f) => f.endsWith('.json')), [])
})

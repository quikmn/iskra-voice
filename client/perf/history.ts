// Long histories: #general with 50k messages (written straight into the world's database), then timings for
// scroll-back, catch-up (paging forward), jump-to-message and search, plus SQLite's query plans for them.
//   cd bots && node build.mjs ../client/perf/history.ts && node dist/history.js [messages]
// The server listens on localhost only (LocalOnly).
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Connection } from '../src/core/connection'
import { randomBytes, ready, signingKeyPairFromSeed } from '../src/core/crypto'
import { certifyDevice } from '../src/core/identity'
import { parseInvite } from '../src/core/invite'
import type { Welcome } from '../src/core/protocol'

const COUNT = Number(process.argv[2] ?? 50_000)
const HERE = dirname(fileURLToPath(import.meta.url))
const DLL = resolve(HERE, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const WORDS = 'the a game tonight anyone up for some raid later lol nice gg pizza movie stream music link check this out what time works'.split(' ')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => done(port))
    })
  })
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]

async function main() {
  await ready()
  const world = mkdtempSync(join(tmpdir(), 'iskra-history-'))
  const port = await freePort()
  writeFileSync(join(world, 'server.json'), JSON.stringify({ Name: 'History', Port: port, LocalOnly: true, Voice: { Enabled: false } }))
  const server = spawn('dotnet', [DLL, world], { stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env, Logging__LogLevel__Default: 'Warning' } })
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://localhost:${port}`)).ok) break
    } catch {
      /* starting */
    }
    if (i > 300) throw new Error('server did not start')
    await sleep(100)
  }

  const owner = parseInvite(readFileSync(join(world, 'owner-invite.txt'), 'utf8').trim())!
  const account = signingKeyPairFromSeed(randomBytes(32))
  const device = signingKeyPairFromSeed(randomBytes(32))
  let welcome!: Welcome
  const welcomed = new Promise<void>((done) => {
    const conn = new Connection({
      serverUrl: owner.serverUrl, expectedServerKey: owner.serverKey, invite: owner.code,
      identity: { account, device, cert: certifyDevice(account, device.publicKey, Date.now()) },
      name: () => 'Owner', onStatus: () => undefined, onEvent: () => undefined, requestTimeoutMs: 120_000,
      onWelcome: (w) => {
        welcome = w
        done()
      },
    })
    conn.start()
    void welcomed.then(() => run(conn))
  })
  await welcomed

  async function run(conn: Connection) {
    const general = welcome.channels.find((c) => c.name === 'general')!.id
    const me = welcome.you.accountKey

    // Seed: COUNT messages over the last 60 days, every 10th a reply, every 50th with a link, a reaction on every 20th.
    const db = new DatabaseSync(join(world, 'iskra.db'))
    db.exec('PRAGMA busy_timeout = 10000;')
    const t0 = performance.now()
    db.exec('BEGIN')
    const insert = db.prepare('INSERT INTO messages (channel_id, author_key, text, created_at, reply_to) VALUES (?, ?, ?, ?, ?)')
    const react = db.prepare('INSERT OR IGNORE INTO reactions (message_id, account_key, emoji, created_at) VALUES (?, ?, ?, ?)')
    const start = Date.now() - 60 * 24 * 3600_000
    let first = 0
    for (let i = 0; i < COUNT; i++) {
      const words = Array.from({ length: 4 + (i % 12) }, (_, k) => WORDS[(i * 7 + k * 13) % WORDS.length])
      if (i % 50 === 0) words.push('https://example.com/page' + i)
      if (i % 997 === 0) words.push('zebracorn')
      const id = Number(insert.run(general, me, words.join(' '), start + i * 100_000, i % 10 === 5 && first ? first + i - 3 : null).lastInsertRowid)
      if (!first) first = id
      if (i % 20 === 0) {
        try {
          react.run(id, me, '👍', start + i * 100_000)
        } catch {
          /* no reactions table in this shape: skip */
        }
      }
    }
    db.exec('COMMIT')
    console.log(`seeded ${COUNT} messages in ${((performance.now() - t0) / 1000).toFixed(1)} s`)

    const last = first + COUNT - 1
    const timings: [string, number[]][] = []
    const measure = async (name: string, times: number, f: (i: number) => Promise<unknown>) => {
      const xs: number[] = []
      for (let i = 0; i < times; i++) {
        const t = performance.now()
        await f(i)
        xs.push(performance.now() - t)
      }
      timings.push([name, xs])
    }
    await measure('history: latest 50', 20, () => conn.request('chat.history', { channelId: general, limit: 50 }))
    await measure('history: 100 before (deep)', 20, (i) => conn.request('chat.history', { channelId: general, before: first + 1000 + i * 100, limit: 100 }))
    await measure('history: scroll back 50x100', 1, async () => {
      let before: number | undefined
      for (let i = 0; i < 50; i++) {
        const page = await conn.request('chat.history', { channelId: general, before, limit: 100 })
        before = page.messages[0].id
      }
    })
    await measure('catch-up: 5000 after, by 100', 1, async () => {
      let after = last - 5000
      for (let i = 0; i < 50; i++) {
        const page = await conn.request('chat.history', { channelId: general, after, limit: 100 })
        after = page.messages[page.messages.length - 1].id
      }
    })
    await measure('jump: around (middle)', 20, (i) => conn.request('chat.history', { channelId: general, around: first + COUNT / 2 + i, limit: 50 }))
    await measure('search: common word', 10, () => conn.request('search', { query: 'pizza', limit: 25 }))
    await measure('search: rare word', 10, () => conn.request('search', { query: 'zebracorn', limit: 25 }))
    await measure('search: two words', 10, () => conn.request('search', { query: 'raid tonight', limit: 25 }))
    await measure('search: has link', 10, () => conn.request('search', { has: ['link'], limit: 25 }))
    await measure('search: by author', 10, () => conn.request('search', { author: me, limit: 25 }))
    await measure('search: common, page 20', 10, async () => {
      let cursor: number | undefined
      for (let i = 0; i < 20; i++) {
        const r = await conn.request('search', { query: 'game', limit: 25, cursor })
        cursor = r.results[r.results.length - 1]?.message.id
      }
    })

    console.log('\nTimings (request to reply):')
    for (const [name, xs] of timings) console.log(`  ${name.padEnd(30)} p50 ${pct(xs, 0.5).toFixed(1)} ms  max ${Math.max(...xs).toFixed(1)} ms`)

    console.log('\nQuery plans:')
    const plans: [string, string, unknown[]][] = [
      ['history latest', 'SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT 50', [general, Number.MAX_SAFE_INTEGER]],
      ['history after', 'SELECT * FROM messages WHERE channel_id = ? AND id > ? ORDER BY id LIMIT 100', [general, last - 5000]],
      ['reactions of one', 'SELECT * FROM reactions WHERE message_id = ?', [first]],
      ['replies (thread summary)', 'SELECT * FROM threads WHERE root_id = ?', [first]],
      ['search fts', "SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH '\"pizza\"*' AND m.channel_id IN (SELECT value FROM json_each('[1]')) ORDER BY m.id DESC LIMIT 25", []],
      ['search author', "SELECT m.id FROM messages m WHERE m.channel_id IN (SELECT value FROM json_each('[1]')) AND m.author_key = ? ORDER BY m.id DESC LIMIT 25", [me]],
      ['search link', "SELECT m.id FROM messages m WHERE m.channel_id IN (SELECT value FROM json_each('[1]')) AND (m.text LIKE '%http://%' OR m.text LIKE '%https://%') ORDER BY m.id DESC LIMIT 25", []],
    ]
    for (const [name, sql, args] of plans) {
      try {
        const rows = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...(args as never[])) as { detail: string }[]
        console.log(`  ${name}: ${rows.map((r) => r.detail).join(' | ')}`)
      } catch (e) {
        console.log(`  ${name}: (${(e as Error).message})`)
      }
    }
    db.close()
    conn.stop()
    server.kill()
    await sleep(1000)
    rmSync(world, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    process.exit(0)
  }
  await new Promise(() => undefined)
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})

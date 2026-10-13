// A long session in the built app: a busy channel (a script posts all the time), voice joined and left, channels and
// servers switched, settings and the server room opened and closed, for ISKRA_PERF_MINUTES (default 10). Samples the
// JS heap (after a forced GC), DOM counters and live resources (audio contexts, workers, blob URLs, peer connections).
//   npm run build; ISKRA_E2E_PORT=5193 npx playwright test -c perf/perf.config.ts long-session
import { expect, test, type Page } from '@playwright/test'
import { Connection } from '../src/core/connection'
import { randomBytes, ready, signingKeyPairFromSeed } from '../src/core/crypto'
import { certifyDevice } from '../src/core/identity'
import { parseInvite } from '../src/core/invite'
import { createInviteLink, hasLiveKit, joinVia, openServerSettings, openSettings, startServer, type TestServer } from '../e2e/helpers'

const MINUTES = Number(process.env.ISKRA_PERF_MINUTES ?? 10)

let a: TestServer
let b: TestServer
test.beforeAll(async () => {
  a = await startServer('Perf A', hasLiveKit())
  b = await startServer('Perf B')
})
test.afterAll(async () => {
  await a?.stop()
  await b?.stop()
})

/** Counts what the page creates and releases, so leaks of things the heap doesn't show still show. */
const COUNTERS = () => {
  const c = { audioContexts: 0, audioContextsClosed: 0, workers: 0, workersEnded: 0, blobUrls: 0, blobUrlsRevoked: 0, peers: 0, peersClosed: 0 }
  ;(window as unknown as { __perf: typeof c }).__perf = c
  const AC = window.AudioContext
  if (AC) {
    window.AudioContext = class extends AC {
      constructor(...args: ConstructorParameters<typeof AudioContext>) {
        super(...args)
        c.audioContexts++
        let closed = false
        const close = this.close.bind(this)
        this.close = () => {
          if (!closed) c.audioContextsClosed++
          closed = true
          return close()
        }
      }
    }
  }
  const W = window.Worker
  window.Worker = class extends W {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args)
      c.workers++
      const terminate = this.terminate.bind(this)
      this.terminate = () => {
        c.workersEnded++
        terminate()
      }
    }
  }
  const create = URL.createObjectURL.bind(URL)
  const revoke = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = (o: Blob | MediaSource) => {
    c.blobUrls++
    return create(o)
  }
  URL.revokeObjectURL = (u: string) => {
    c.blobUrlsRevoked++
    revoke(u)
  }
  const PC = window.RTCPeerConnection
  if (PC) {
    window.RTCPeerConnection = class extends PC {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args)
        c.peers++
        const w = window as unknown as { __pcs?: { pc: RTCPeerConnection; stack: string }[] }
        ;(w.__pcs ??= []).push({ pc: this, stack: new Error().stack ?? '' })
        const close = this.close.bind(this)
        this.close = () => {
          if (this.signalingState !== 'closed') c.peersClosed++
          close()
        }
      }
    } as typeof RTCPeerConnection
  }
}

async function sample(page: Page, label: string) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const heap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }
  const dom = (await cdp.send('Memory.getDOMCounters')) as { documents: number; nodes: number; jsEventListeners: number }
  await cdp.detach()
  const counts = await page.evaluate(() => ({
    messages: document.querySelectorAll('.message').length,
    audio: document.querySelectorAll('audio, video').length,
    ...(window as unknown as { __perf: Record<string, number> }).__perf,
  }))
  return { label, heapMB: +(heap.usedSize / 2 ** 20).toFixed(1), nodes: dom.nodes, listeners: dom.jsEventListeners, documents: dom.documents, ...counts }
}

/** Detached DOM nodes (removed from the page but still referenced), from a heap snapshot. */
async function detachedNodes(page: Page): Promise<Record<string, number>> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  const chunks: string[] = []
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (e: { chunk: string }) => void chunks.push(e.chunk))
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  await cdp.detach()
  const snap = JSON.parse(chunks.join('')) as { snapshot: { meta: { node_fields: string[] } }; nodes: number[]; strings: string[] }
  const fields = snap.snapshot.meta.node_fields
  const nameAt = fields.indexOf('name')
  const counts: Record<string, number> = {}
  for (let i = 0; i < snap.nodes.length; i += fields.length) {
    const name = snap.strings[snap.nodes[i + nameAt]]
    if (name.startsWith('Detached ')) counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

test('long session', async ({ browser }) => {
  test.setTimeout((MINUTES + 5) * 60_000)
  const context = await browser.newContext()
  await context.addInitScript(COUNTERS)
  const page = await context.newPage()
  await joinVia(page, a.ownerLink(), 'Host')
  const voice = hasLiveKit()
  const lounge = page.locator('.voice-channel', { hasText: 'lounge' })
  for (const [kind, name] of [...(voice ? [['Voice', 'lounge']] : []), ['Text', 'random']] as const) {
    await page.getByRole('button', { name: 'Create voice channel' }).click()
    await page.getByRole('radio', { name: kind }).click()
    await page.getByLabel('Name').fill(name)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
  }
  const channel = (name: string) => page.locator('.channel', { has: page.locator('.channel-name', { hasText: new RegExp(`^${name}$`) }) })
  await expect(channel('random')).toBeVisible()

  // The busy channel: a script member posts about 1.4 messages a second and types now and then.
  await ready()
  const invite = parseInvite(await createInviteLink(page))!
  const account = signingKeyPairFromSeed(randomBytes(32))
  const device = signingKeyPairFromSeed(randomBytes(32))
  let botReady!: () => void
  const botWelcomed = new Promise<void>((r) => (botReady = r))
  let general = 0
  const bot = new Connection({
    serverUrl: invite.serverUrl, expectedServerKey: invite.serverKey, invite: invite.code,
    identity: { account, device, cert: certifyDevice(account, device.publicKey, Date.now()) },
    name: () => 'Chatty', onStatus: () => undefined, onEvent: () => undefined,
    onWelcome: (w) => {
      general = w.channels.find((c) => c.name === 'general')!.id
      botReady()
    },
  })
  bot.start()
  await botWelcomed
  let posting = true
  let posted = 0
  const poster = (async () => {
    while (posting) {
      posted++
      if (posted % 5 === 0) void bot.request('chat.typing', { channelId: general }).catch(() => undefined)
      await bot.request('chat.send', { channelId: general, text: `message ${posted}: the quick brown fox ${'jumps '.repeat(posted % 20)}` }).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 700))
    }
  })()

  // A second server to switch to.
  await page.goto(b.ownerLink())
  await page.getByRole('button', { name: 'Join server' }).click()
  await expect(page.locator('.server-icon[title="Perf B"]')).toBeVisible({ timeout: 15_000 })
  const rail = (name: string) => page.locator(`.server-icon[title="${name}"]`)

  const samples: Awaited<ReturnType<typeof sample>>[] = []
  const cycle = async () => {
    await rail('Perf A').click()
    await channel('random').click()
    await channel('general').click()
    if (voice) {
      await lounge.getByRole('button').first().click()
      await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
      await page.waitForTimeout(3000)
      await page.getByRole('button', { name: 'Leave voice' }).first().click()
      await expect(page.locator('.voice-status')).toHaveCount(0, { timeout: 10_000 })
    }
    await channel('general').click()
    await openSettings(page, 'Voice & audio')
    await page.keyboard.press('Escape')
    await openServerSettings(page, 'Roles')
    await page.keyboard.press('Escape')
    await rail('Perf B').click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
    await page.waitForTimeout(1500)
    await rail('Perf A').click()
    await channel('general').click()
    await page.waitForTimeout(2000) // reading the busy channel
  }

  await cycle() // warm-up: everything loaded once
  samples.push(await sample(page, 'after warm-up'))
  if (process.env.ISKRA_PERF_DEBUG) {
    await cycle()
    console.log(await page.evaluate(() => {
      const pcs = (window as unknown as { __pcs: { pc: RTCPeerConnection; stack: string }[] }).__pcs
      const media = [...document.querySelectorAll('audio, video')].map((e) => `${e.tagName} class=${e.className} parent=${e.parentElement?.className} src=${(e as HTMLMediaElement).src.slice(0, 40)} srcObject=${!!(e as HTMLMediaElement).srcObject}`)
      return JSON.stringify({ media, pcs: pcs.map((p) => `${p.pc.signalingState}/${p.pc.connectionState} ${p.stack.split(String.fromCharCode(10)).slice(2, 7).join(' <- ')}`) }, null, 1)
    }))
  }
  const start = Date.now()
  let cycles = 0
  while (Date.now() - start < MINUTES * 60_000) {
    await cycle()
    cycles++
    if (cycles % 3 === 0) samples.push(await sample(page, `${((Date.now() - start) / 60_000).toFixed(1)} min, ${cycles} cycles`))
  }
  posting = false
  await poster
  bot.stop()
  samples.push(await sample(page, `end, ${cycles} cycles, ${posted} messages posted`))
  const detached = await detachedNodes(page)

  console.log('\n' + ['label', 'heapMB', 'nodes', 'listeners', 'documents', 'messages', 'audio', 'audioContexts', 'audioContextsClosed', 'workers', 'workersEnded', 'blobUrls', 'blobUrlsRevoked', 'peers', 'peersClosed'].join('\t'))
  for (const s of samples) console.log(Object.values(s).join('\t'))
  const top = Object.entries(detached).sort((x, y) => y[1] - x[1]).slice(0, 10)
  console.log(`\ndetached DOM nodes: ${Object.values(detached).reduce((x, y) => x + y, 0)} ${JSON.stringify(Object.fromEntries(top))}`)
})

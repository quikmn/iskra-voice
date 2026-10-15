import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type BrowserContext, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { APP_PORT } from '../playwright.config'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DLL = resolve(HERE, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const LIVEKIT = resolve(HERE, '../../.tools', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server')
export const SHOTS = resolve(HERE, 'screenshots')

export const hasLiveKit = () => existsSync(LIVEKIT)
/** The captions model as scripts/get-models.mjs writes it; test servers serve it from here. */
export const CAPTION_MODELS = resolve(HERE, '../.models/models')

/** Chromium's fake mic plays someone talking (e2e/fixtures/speech.wav, looped) instead of beeping. */
export const FAKE_SPEECH_ARGS = [
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  '--auto-select-desktop-capture-source=Entire screen', `--use-file-for-fake-audio-capture=${resolve(HERE, 'fixtures/speech.wav')}`,
]

/** Ports already handed out in this test process. */
const handedOut = new Set<number>()
/** Each parallel worker has its own range (below the OSes' ephemeral ports), so two workers never pick the same port. */
const RANGE = 1500
const rangeStart = 20000 + (Number(process.env.TEST_PARALLEL_INDEX) || 0) * RANGE

const isFree = (port: number) =>
  new Promise<boolean>((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, () => probe.close(() => done(true)))
  })

export async function freePort(): Promise<number> {
  for (let i = 0; i < RANGE * 2; i++) {
    const port = rangeStart + Math.floor(Math.random() * RANGE)
    if (handedOut.has(port) || !(await isFree(port))) continue
    handedOut.add(port)
    return port
  }
  throw new Error('no free port')
}

export interface TestServer {
  world: string
  url: string
  ownerLink: () => string
  stop: () => Promise<void>
  /**
   * Stops the server cleanly and starts it again on the same port and world after `downMs`. `as: 'restart'` (the
   * default) is a restart members are told about ("restarting, hold on"); `'stop'` is a plain stop ("went offline")
   * that happens to come back; `'marker'` is a plain stop after `iskra-server expect-restart` (what an update script
   * does before `systemctl restart`), so members hear "restarting". Needs `ISKRA_STOP_ON_STDIN_CLOSE: '1'` in the env
   * given to startServer, like the desktop host.
   */
  restart: (downMs?: number, as?: 'restart' | 'stop' | 'marker') => Promise<void>
}

/**
 * Browser contexts that joined a server, by the spec file run that made them. Specs don't close their contexts, so
 * without this every page of every earlier spec stays open in the worker's browser for the rest of the run, retrying
 * its stopped server (and, after a call, running its voice processing until LiveKit gives up): a few hundred pages by
 * the end, which starves the voice and screen-share specs that come late on a small CI machine.
 * A file run is the file plus its --repeat-each copy: repeats of one file follow each other in a worker, and keeping
 * every repeat's pages open made later repeats time out (servers slow to start, trace teardown over 60 s).
 */
const opened: { context: BrowserContext; file: string }[] = []

const currentFile = (): string | null => {
  try {
    const info = test.info()
    return `${info.file}#${info.repeatEachIndex}`
  } catch {
    return null
  }
}

/** Closes the contexts earlier spec files left open (this worker runs one file at a time, so they're done). */
async function closeEarlierContexts(): Promise<void> {
  const file = currentFile()
  if (!file) return
  const done = opened.filter((o) => o.file !== file)
  for (const o of done) opened.splice(opened.indexOf(o), 1)
  await Promise.all(done.map((o) => o.context.close().catch(() => undefined)))
}

/** A real iskra-server on a fresh world; with voice if the LiveKit binary is in .tools. `settings` go into server.json. */
export async function startServer(name: string, voice = false, env: Record<string, string> = {}, settings: Record<string, unknown> = {}): Promise<TestServer> {
  await closeEarlierContexts()
  const world = mkdtempSync(join(tmpdir(), 'iskra-e2e-'))
  // Other workers pick ports too, so a port can be taken by the time the server binds it: then it exits, and
  // this tries again on new ports.
  for (let attempt = 1; ; attempt++) {
    const started = await startIn(world, name, voice, env, settings)
    if (started) return started
    if (attempt === 5) throw new Error('server did not start')
  }
}

async function startIn(world: string, name: string, voice: boolean, env: Record<string, string>, settings: Record<string, unknown>): Promise<TestServer | null> {
  const port = await freePort()
  const voicePort = await freePort()
  const rtcTcp = await freePort()
  const rtcUdp = 40000 + Math.floor(Math.random() * 20000)
  writeFileSync(
    join(world, 'server.json'),
    JSON.stringify({
      Name: name,
      Port: port,
      AppUrl: `http://localhost:${APP_PORT}`,
      LocalOnly: true,
      Voice: { Enabled: voice, Port: voicePort, RtcTcpPort: rtcTcp, RtcUdpPort: rtcUdp, LiveKitPath: voice ? LIVEKIT : null },
      // The captions model from the local copy (node scripts/get-models.mjs), never from the internet.
      Captions: { ModelSource: CAPTION_MODELS },
      // Translation models too (node scripts/get-models.mjs --translate), when a test turns translation on.
      Translate: { ModelSource: resolve(CAPTION_MODELS, 'translate') },
      ...settings,
    }),
  )
  const url = `http://localhost:${port}`
  // The server's last lines of output, for the error when it doesn't come up. ISKRA_E2E_SERVER_LOG keeps all of it: a
  // file (every server appends), or a folder (one <world>.log per server, for parallel workers).
  const tail: string[] = []
  const launch = () => {
    // stdin stays open: with ISKRA_STOP_ON_STDIN_CLOSE closing it is a clean stop (see restart).
    const logTo = process.env.ISKRA_E2E_SERVER_LOG
    const log = logTo ? openSync(existsSync(logTo) && statSync(logTo).isDirectory() ? join(logTo, `${basename(world)}.log`) : logTo, 'a') : null
    const proc: ChildProcess = spawn('dotnet', [SERVER_DLL, world], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    const keep = (chunk: Buffer) => {
      if (log !== null) writeSync(log, chunk)
      tail.push(...chunk.toString().split(/\r?\n/).filter((l) => l.trim()))
      tail.splice(0, Math.max(0, tail.length - 40))
    }
    proc.stdout?.on('data', keep)
    proc.stderr?.on('data', keep)
    const run = { proc, exited: false }
    proc.once('exit', () => (run.exited = true))
    return run
  }
  const startError = (what: string, last: string, run: { exited: boolean }) =>
    new Error(`${what} did not start in 30 s (last answer: ${last}; the server ${run.exited ? 'exited' : 'is running'}). Its last output:\n${tail.join('\n')}`)
  /** One look at a URL, never longer than 5 s (a stalled connection must not eat the test). */
  const probe = async (target: string): Promise<{ ok: boolean; body: { iskra?: number; name?: string }; said: string }> => {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(5_000) })
      const body = (await response.json().catch(() => ({}))) as { iskra?: number; name?: string }
      return { ok: response.ok, body, said: `${response.status}${body.name ? ` from "${body.name}"` : ''}` }
    } catch (e) {
      return { ok: false, body: {}, said: (e as Error).name === 'TimeoutError' ? 'no answer in 5 s' : 'refused' }
    }
  }
  const ready = async (run: { exited: boolean }): Promise<boolean> => {
    const until = Date.now() + 30_000
    for (let last = 'none'; ; ) {
      if (run.exited) return false
      // This test's server, not another worker's that got the same port first.
      const { ok, body, said } = await probe(url)
      last = said
      if (ok && body.iskra && body.name === name && !run.exited) break
      if (Date.now() > until) throw startError('The server', last, run)
      await new Promise((r) => setTimeout(r, 100))
    }
    if (voice) {
      // LiveKit starts a moment after the server.
      const lkUntil = Date.now() + 30_000
      for (let last = 'none'; ; ) {
        const { ok, said } = await probe(`http://127.0.0.1:${voicePort}`)
        last = said
        if (ok) break
        if (Date.now() > lkUntil) throw startError('LiveKit', last, run)
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    return true
  }
  /** Ends the process: cleanly through stdin (saying "restart" first, as the desktop host does), or killed. */
  const end = async (run: { proc: ChildProcess; exited: boolean }, how: 'restart' | 'stop' | 'kill') => {
    if (run.exited) return
    const done = new Promise((r) => run.proc.once('exit', r))
    if (how === 'restart') run.proc.stdin?.end('restart' + String.fromCharCode(10))
    else if (how === 'stop') run.proc.stdin?.end()
    else run.proc.kill()
    // A clean stop takes a moment; don't let a stuck one eat the hook timeout.
    const force = setTimeout(() => run.proc.kill('SIGKILL'), 10_000)
    await done
    clearTimeout(force)
  }

  let current = launch()
  if (!(await ready(current))) return null
  let stopping: Promise<void> | null = null
  return {
    world,
    url,
    ownerLink: () => readFileSync(join(world, 'owner-invite.txt'), 'utf8').trim(),
    // Idempotent: later calls share the first one. On Windows a killed process keeps exitCode null
    // (signalCode is set instead), so 'exit' is tracked from the start rather than read from exitCode.
    stop: () => (stopping ??= (async () => {
      await end(current, 'kill')
      rmSync(world, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    })()),
    restart: async (downMs = 0, as = 'restart') => {
      if (env.ISKRA_STOP_ON_STDIN_CLOSE !== '1') throw new Error('restart needs ISKRA_STOP_ON_STDIN_CLOSE=1')
      if (as === 'marker') {
        const cli = spawnSync('dotnet', [SERVER_DLL, 'expect-restart', world, '--reason', 'update', '--eta', '30'], { encoding: 'utf8' })
        if (cli.status !== 0) throw new Error(`expect-restart failed: ${cli.stderr}`)
      }
      await end(current, as === 'marker' ? 'stop' : as)
      await new Promise((r) => setTimeout(r, downMs))
      current = launch()
      if (!(await ready(current))) throw new Error('server did not come back (port taken?)')
    },
  }
}

/** Joins with an invite link as someone new; `landing` is the channel the server opens first (a template's first text channel). */
export async function joinVia(page: Page, link: string, name: string, landing = 'general') {
  const file = currentFile()
  if (file && !opened.some((o) => o.context === page.context())) opened.push({ context: page.context(), file })
  await page.goto(link)
  await expect(page.getByText("You've been invited")).toBeVisible()
  await agreeToTerms(page)
  await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByRole('heading', { name: landing, exact: true })).toBeVisible({ timeout: 15_000 })
}

/**
 * Records every status banner (`role="status"`) the page shows from now on, with when it appeared. For banners that
 * are only up for a moment (the restart banner's "<Server> is back." shows for 2.5 s): asserting on them live races
 * whatever the test waits for first, so check the record instead.
 */
export async function recordStatusBanners(page: Page): Promise<() => Promise<{ text: string; at: number }[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __statusSeen?: { text: string; at: number }[]; __statusObserver?: MutationObserver }
    w.__statusObserver?.disconnect()
    const seen: { text: string; at: number }[] = []
    const showing = new Set<string>()
    w.__statusSeen = seen
    const look = () => {
      const now = new Set<string>()
      for (const el of document.querySelectorAll('[role="status"]')) {
        const text = (el.textContent ?? '').trim()
        if (!text) continue
        now.add(text)
        if (!showing.has(text)) seen.push({ text, at: Date.now() })
      }
      showing.clear()
      for (const text of now) showing.add(text)
    }
    w.__statusObserver = new MutationObserver(look)
    w.__statusObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
    look()
  })
  return () => page.evaluate(() => (window as unknown as { __statusSeen?: { text: string; at: number }[] }).__statusSeen ?? [])
}

/**
 * Notes whether an element matching `selector` ever shows on the page from now on (a progress bar that may come and go
 * before a live check gets to it). Returns a check for `expect.poll`.
 */
export async function recordSeen(page: Page, selector: string): Promise<() => Promise<boolean>> {
  await page.evaluate((selector) => {
    const w = window as unknown as { __seen?: Record<string, boolean> }
    const seen = (w.__seen ??= {})
    seen[selector] = !!document.querySelector(selector)
    if (seen[selector]) return
    const observer = new MutationObserver(() => {
      if (!document.querySelector(selector)) return
      seen[selector] = true
      observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }, selector)
  return () => page.evaluate((selector) => !!(window as unknown as { __seen?: Record<string, boolean> }).__seen?.[selector], selector)
}

/** The first-run screen asks to agree to the terms before either choice (once per device and terms version). */
export async function agreeToTerms(page: Page) {
  await expect(page.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible({ timeout: 15_000 })
  const box = page.getByRole('checkbox', { name: /I agree to the Terms of Use/ })
  if (await box.isVisible()) await box.check()
}

export async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('Message #general')
  await box.fill(text)
  await box.press('Enter')
}

export async function createInviteLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Invite friends' }).click()
  const linkInput = page.locator('.copy-row input')
  await expect(linkInput).toHaveValue(/#\/join\//)
  const link = await linkInput.inputValue()
  await page.keyboard.press('Escape')
  return link
}

/** Opens My settings (the gear by your name), then a section by its name in the sidebar (or list, on phones). */
export async function openSettings(page: Page, section?: string) {
  await page.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  if (section) await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click()
}

/** A server's settings room ("<name> · Server settings"), or any open one. */
export const serverRoom = (page: Page, name?: string) =>
  page.getByRole('dialog', { name: name ? `${name} · Server settings` : /· Server settings$/ })

/**
 * Opens the settings room of the server you're looking at (the server-name dropdown → Server settings), then a
 * section by its name. On phones, open the channels drawer first.
 */
export async function openServerSettings(page: Page, section?: string): Promise<Locator> {
  await page.locator('.server-header-button').click()
  await page.getByRole('menuitem', { name: 'Server settings', exact: true }).click()
  const room = serverRoom(page)
  await expect(room).toBeVisible()
  if (section) await room.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click()
  return room
}

/** Press and hold with a finger (pointer events), as on a phone. */
export async function longPress(page: Page, target: Locator) {
  const box = (await target.boundingBox())!
  const at = { pointerType: 'touch', isPrimary: true, button: 0, clientX: box.x + Math.min(40, box.width / 2), clientY: box.y + Math.min(12, box.height / 2) }
  await target.dispatchEvent('pointerdown', at)
  await page.waitForTimeout(600)
  await target.dispatchEvent('pointerup', at)
}

/** The desktop app's main window (app://), not the splash window that opens first. */
export async function appWindow(app: ElectronApplication): Promise<Page> {
  const isApp = (p: Page) => p.url().startsWith('app://')
  await expect.poll(() => app.windows().some(isApp), { timeout: 30_000 }).toBe(true)
  return app.windows().find(isApp)!
}

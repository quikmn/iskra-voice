import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
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
}

/**
 * Browser contexts that joined a server, by the spec file that made them. Specs don't close their contexts, so
 * without this every page of every earlier spec stays open in the worker's browser for the rest of the run, retrying
 * its stopped server (and, after a call, running its voice processing until LiveKit gives up): a few hundred pages by
 * the end, which starves the voice and screen-share specs that come late on a small CI machine.
 */
const opened: { context: BrowserContext; file: string }[] = []

const currentFile = (): string | null => {
  try {
    return test.info().file
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

/** A real iskra-server on a fresh world; with voice if the LiveKit binary is in .tools. */
export async function startServer(name: string, voice = false, env: Record<string, string> = {}): Promise<TestServer> {
  await closeEarlierContexts()
  const world = mkdtempSync(join(tmpdir(), 'iskra-e2e-'))
  // Other workers pick ports too, so a port can be taken by the time the server binds it: then it exits, and
  // this tries again on new ports.
  for (let attempt = 1; ; attempt++) {
    const started = await startIn(world, name, voice, env)
    if (started) return started
    if (attempt === 5) throw new Error('server did not start')
  }
}

async function startIn(world: string, name: string, voice: boolean, env: Record<string, string>): Promise<TestServer | null> {
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
    }),
  )
  const proc: ChildProcess = spawn('dotnet', [SERVER_DLL, world], { stdio: 'ignore', env: { ...process.env, ...env } })
  let exited = false
  proc.once('exit', () => (exited = true))
  let stopping: Promise<void> | null = null
  const url = `http://localhost:${port}`
  for (let i = 0; ; i++) {
    if (exited) return null
    try {
      // This test's server, not another worker's that got the same port first.
      const response = await fetch(url)
      const body = (await response.json().catch(() => ({}))) as { iskra?: number; name?: string }
      if (response.ok && body.iskra && body.name === name && !exited) break
    } catch {
      /* starting */
    }
    if (i > 300) throw new Error('server did not start')
    await new Promise((r) => setTimeout(r, 100))
  }
  if (voice) {
    // LiveKit starts a moment after the server.
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${voicePort}`)).ok) break
      } catch {
        /* starting */
      }
      if (i > 300) throw new Error('LiveKit did not start')
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  return {
    world,
    url,
    ownerLink: () => readFileSync(join(world, 'owner-invite.txt'), 'utf8').trim(),
    // Idempotent: later calls share the first one. On Windows a killed process keeps exitCode null
    // (signalCode is set instead), so 'exit' is tracked from the start rather than read from exitCode.
    stop: () => (stopping ??= (async () => {
      if (!exited) {
        const done = new Promise((r) => proc.once('exit', r))
        proc.kill()
        // A clean stop takes a moment; don't let a stuck one eat the hook timeout.
        const force = setTimeout(() => proc.kill('SIGKILL'), 10_000)
        await done
        clearTimeout(force)
      }
      rmSync(world, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    })()),
  }
}

export async function joinVia(page: Page, link: string, name: string) {
  const file = currentFile()
  if (file && !opened.some((o) => o.context === page.context())) opened.push({ context: page.context(), file })
  await page.goto(link)
  await expect(page.getByText("You've been invited")).toBeVisible()
  await agreeToTerms(page)
  await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 15_000 })
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
  await page.locator('.me-bar').getByRole('button', { name: 'Settings', exact: true }).click()
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

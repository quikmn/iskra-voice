import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Locator, type Page } from '@playwright/test'
import { APP_PORT } from '../playwright.config'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DLL = resolve(HERE, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const LIVEKIT = resolve(HERE, '../../.tools', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server')
export const SHOTS = resolve(HERE, 'screenshots')

export const hasLiveKit = () => existsSync(LIVEKIT)

export async function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer().listen(0, () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => done(port))
    })
  })
}

export interface TestServer {
  world: string
  url: string
  ownerLink: () => string
  stop: () => Promise<void>
}

/** A real iskra-server on a fresh world; with voice if the LiveKit binary is in .tools. */
export async function startServer(name: string, voice = false, env: Record<string, string> = {}): Promise<TestServer> {
  const world = mkdtempSync(join(tmpdir(), 'iskra-e2e-'))
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
    }),
  )
  const proc: ChildProcess = spawn('dotnet', [SERVER_DLL, world], { stdio: 'ignore', env: { ...process.env, ...env } })
  let exited = false
  proc.once('exit', () => (exited = true))
  let stopping: Promise<void> | null = null
  const url = `http://localhost:${port}`
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url)).ok) break
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
        await done
      }
      rmSync(world, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    })()),
  }
}

export async function joinVia(page: Page, link: string, name: string) {
  await page.goto(link)
  await expect(page.getByText("You've been invited")).toBeVisible()
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 15_000 })
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

/** Opens Settings from the bar under the channel list, then a section by its name in the sidebar (or list, on phones). */
export async function openSettings(page: Page, section?: string) {
  await page.locator('.me-bar').getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  if (section) await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click()
}

/** Press and hold with a finger (pointer events), as on a phone. */
export async function longPress(page: Page, target: Locator) {
  const box = (await target.boundingBox())!
  const at = { pointerType: 'touch', isPrimary: true, button: 0, clientX: box.x + Math.min(40, box.width / 2), clientY: box.y + Math.min(12, box.height / 2) }
  await target.dispatchEvent('pointerdown', at)
  await page.waitForTimeout(600)
  await target.dispatchEvent('pointerup', at)
}

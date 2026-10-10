// "Open to the internet" against a real server whose router is a stand-in (--Internet:TestRouter).
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { APP_PORT } from '../playwright.config'
import { createInviteLink, freePort, joinVia, SHOTS } from './helpers'

const SERVER_DLL = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')

interface Hosted {
  port: number
  ownerLink: () => string
  stop: () => Promise<void>
}

async function startServer(name: string, router: string): Promise<Hosted> {
  const world = mkdtempSync(join(tmpdir(), 'iskra-e2e-'))
  const port = await freePort()
  writeFileSync(join(world, 'server.json'), JSON.stringify({
    Name: name,
    Port: port,
    AppUrl: `http://localhost:${APP_PORT}`,
    LocalOnly: true,
    Voice: { Enabled: true, LiveKitPath: join(world, 'no-livekit'), RtcTcpPort: 7881, RtcUdpPort: 7882 },
    // Never the real Let's Encrypt from tests.
    Https: { AcmeDirectory: 'http://127.0.0.1:9/directory' },
  }))
  const proc: ChildProcess = spawn('dotnet', [SERVER_DLL, world, `--Internet:TestRouter=${router}`], { stdio: 'ignore' })
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://localhost:${port}`)).ok) break
    } catch {
      /* starting */
    }
    if (i > 300) throw new Error('server did not start')
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    port,
    ownerLink: () => readFileSync(join(world, 'owner-invite.txt'), 'utf8').trim(),
    stop: async () => {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r))
        proc.kill()
        await exited
      }
      rmSync(world, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    },
  }
}

const servers: Hosted[] = []
test.afterAll(async () => Promise.all(servers.map((s) => s.stop())))

async function openSettings(page: Page) {
  // On a phone the settings button lives in the channels drawer.
  const drawer = page.getByRole('button', { name: 'Open channels' })
  if (await drawer.isVisible()) await drawer.click()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Open to the internet' })).toBeVisible()
}

const step = (page: Page, id: string) => page.locator(`.checklist [data-step="${id}"]`)

test('owner opens the server to the internet; a router without port 80 gets honest fallbacks', async ({ browser }) => {
  const server = await startServer('Open House', '203.0.113.7,refuse-low')
  servers.push(server)
  const owner = await (await browser.newContext()).newPage()
  await joinVia(owner, server.ownerLink(), 'Owner')

  // Members don't see the panel.
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(owner), 'Friend')
  await friend.getByRole('button', { name: 'Settings' }).click()
  await expect(friend.getByRole('heading', { name: 'Profile' })).toBeVisible()
  await expect(friend.getByRole('heading', { name: 'Open to the internet' })).toHaveCount(0)

  await openSettings(owner)
  const toggle = owner.getByRole('switch', { name: 'Open to the internet' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(owner.getByText('Only people on your network can join.')).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  await expect(step(owner, 'router')).toHaveAttribute('data-state', 'done')
  await expect(step(owner, 'router')).toContainText('Found your router (UPnP)')
  await expect(step(owner, 'ports')).toHaveAttribute('data-state', 'problem')
  await expect(step(owner, 'address')).toContainText('203-0-113-7.sslip.io')
  await expect(step(owner, 'https')).toHaveAttribute('data-state', 'problem')
  await expect(step(owner, 'https')).toContainText('port 80')
  await expect(step(owner, 'reachable')).toContainText('Not confirmed from outside')
  await expect(owner.getByText('Open to the desktop app only')).toBeVisible()

  // Exact port to forward by hand.
  const forwards = owner.getByTestId('manual-forwards')
  await expect(forwards.locator('tbody tr')).toHaveCount(1)
  await expect(forwards.locator('tbody tr')).toContainText('80')
  await expect(forwards.locator('tbody tr')).toContainText(String(server.port))
  await expect(owner.locator('.internet-address')).toContainText(`http://203.0.113.7:${server.port}`)
  await owner.locator('.internet').scrollIntoViewIfNeeded()
  await owner.screenshot({ path: join(SHOTS, 'hosting-settings.png') })
  await owner.keyboard.press('Escape')

  // New invite links carry the public address, for owner and members alike.
  for (const page of [owner, friend]) {
    if (page === friend) await page.keyboard.press('Escape')
    const link = await createInviteLink(page)
    const serverUrl = Buffer.from(link.split('/join/')[1].split('.')[0], 'base64url').toString()
    expect(serverUrl).toBe(`http://203.0.113.7:${server.port}`)
  }

  // Closing it again.
  await openSettings(owner)
  await owner.getByRole('switch', { name: 'Open to the internet' }).click()
  await expect(owner.getByText('Only people on your network can join.')).toBeVisible()
  await expect(owner.locator('.checklist')).toHaveCount(0)
})

test('carrier-grade NAT gets a clear explanation and the VPS route (on a phone)', async ({ browser }) => {
  const server = await startServer('Behind CGNAT', '100.72.10.5')
  servers.push(server)
  const owner = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(owner, server.ownerLink(), 'Owner')
  await openSettings(owner)
  await owner.getByRole('switch', { name: 'Open to the internet' }).click()
  await expect(owner.getByText('Your provider shares one internet address between customers')).toBeVisible()
  await expect(owner.getByRole('link', { name: 'How to run it on a VPS' })).toHaveAttribute('href', /hosting\.md/)
  await expect(step(owner, 'address')).toHaveAttribute('data-state', 'problem')
  await expect(owner.getByTestId('manual-forwards')).toHaveCount(0)
  const overflow = await owner.locator('.internet').evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await owner.locator('.internet-callout').scrollIntoViewIfNeeded()
  await owner.screenshot({ path: join(SHOTS, 'hosting-cgnat-phone.png') })
})

test('no router: every port listed to forward by hand', async ({ browser }) => {
  const server = await startServer('No UPnP', 'none')
  servers.push(server)
  const owner = await (await browser.newContext()).newPage()
  await joinVia(owner, server.ownerLink(), 'Owner')
  await openSettings(owner)
  await owner.getByRole('switch', { name: 'Open to the internet' }).click()
  await expect(step(owner, 'router')).toHaveAttribute('data-state', 'problem')
  const rows = owner.getByTestId('manual-forwards').locator('tbody tr')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toContainText('80')
  await expect(rows.nth(1)).toContainText('443')
  await expect(rows.nth(3)).toContainText('UDP')
})

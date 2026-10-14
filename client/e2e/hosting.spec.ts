// "Open to the internet" against a real server whose router is a stand-in (--Internet:TestRouter).
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { APP_PORT } from '../playwright.config'
import { createInviteLink, freePort, joinVia, openServerSettings, SHOTS } from './helpers'

const LOGS = resolve(dirname(fileURLToPath(import.meta.url)), '../test-results')
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
  // The server's log goes to test-results (uploaded by CI when a test fails).
  mkdirSync(LOGS, { recursive: true })
  const log = openSync(join(LOGS, `server-${name.replace(/\W+/g, '-')}.log`), 'w')
  const proc: ChildProcess = spawn('dotnet', [SERVER_DLL, world, `--Internet:TestRouter=${router}`], { stdio: ['ignore', log, log] })
  closeSync(log)
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

/** Lets dialogs finish fading in before a screenshot. */
const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))))
test.afterAll(async () => Promise.all(servers.map((s) => s.stop())))

async function openSettings(page: Page) {
  // On a phone the settings button lives in the channels drawer.
  const drawer = page.getByRole('button', { name: 'Open channels' })
  if (await drawer.isVisible()) await drawer.click()
  await openServerSettings(page, 'Internet access')
  await expect(page.getByRole('heading', { name: 'Internet access' })).toBeVisible()
}

/** No serious or critical accessibility problems inside a dialog (axe, like a11y.spec.ts). */
async function expectAccessible(page: Page, dialog: Locator) {
  await settle(page)
  await dialog.evaluate((el) => el.setAttribute('data-audit', ''))
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).include('[data-audit]').analyze()
  await dialog.evaluate((el) => el.removeAttribute('data-audit'))
  const blocking = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}

const step = (page: Page, id: string) => page.locator(`.checklist [data-step="${id}"]`)

test('owner opens the server to the internet; without port 80 nothing plain HTTP is advertised', async ({ browser }) => {
  const server = await startServer('Open House', '203.0.113.7,refuse-low,model=AVM FRITZ!Box 7590')
  servers.push(server)
  const owner = await (await browser.newContext()).newPage()
  await joinVia(owner, server.ownerLink(), 'Owner')

  // Members don't see the panel.
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(owner), 'Friend')
  await friend.getByRole('button', { name: 'My settings', exact: true }).click()
  await expect(friend.getByRole('heading', { name: 'Profile' })).toBeVisible()
  await expect(friend.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Internet access' })).toHaveCount(0)
  await friend.keyboard.press('Escape')
  await friend.locator('.server-header-button').click()
  await expect(friend.getByRole('menuitem', { name: 'Server settings', exact: true })).toHaveCount(0)
  await friend.keyboard.press('Escape')

  await openSettings(owner)
  const toggle = owner.getByRole('switch', { name: 'Let friends anywhere join' })
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
  await expect(owner.locator('.internet-summary:not(.p2p-section .internet-summary)')).toHaveText(/^Waiting for HTTPS/)

  // What Iskra found out, in plain words: a public address, and the router said no to port 80.
  const findings = owner.getByTestId('host-findings')
  await expect(findings).toHaveAttribute('data-nat', 'public')
  await expect(findings).toContainText('Your router has its own public internet address (203.0.113.7)')
  await expect(findings).toContainText('refused to open some ports')
  await expect(findings).toContainText('Router: AVM FRITZ!Box 7590')
  await expect(findings).toContainText('Voice uses')

  // Exact port to forward by hand.
  const forwards = owner.getByTestId('manual-forwards')
  await expect(forwards.locator('tbody tr')).toHaveCount(1)
  await expect(forwards.locator('tbody tr')).toContainText('80')
  await expect(forwards.locator('tbody tr')).toContainText(String(server.port))
  await expect(owner.locator('.internet-address')).toContainText('Waiting for HTTPS')
  await owner.locator('.internet').scrollIntoViewIfNeeded()
  await owner.screenshot({ path: join(SHOTS, 'hosting-settings.png') })
  await owner.keyboard.press('Escape')

  // Without HTTPS, new invite links keep the address people connected to: no plain HTTP public address.
  for (const page of [owner, friend]) {
    if (page === friend) await page.keyboard.press('Escape')
    const link = await createInviteLink(page)
    const serverUrl = Buffer.from(link.split('/join/')[1].split('.')[0], 'base64url').toString()
    expect(serverUrl).not.toContain('203.0.113.7')
  }

  // Closing it again.
  await openSettings(owner)
  await owner.getByRole('switch', { name: 'Let friends anywhere join' }).click()
  await expect(owner.getByText('Only people on your network can join.')).toBeVisible()
  await expect(owner.locator('.checklist')).toHaveCount(0)
})

test('carrier-grade NAT gets a clear explanation and a rented server as the quickest fix (on a phone)', async ({ browser }) => {
  // Tailscale "is on" too (a stand-in address; the server itself stays on localhost).
  const server = await startServer('Behind CGNAT', '100.72.10.5,tailscale=100.101.102.103')
  servers.push(server)
  const owner = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(owner, server.ownerLink(), 'Owner')
  await openSettings(owner)
  await owner.getByRole('switch', { name: 'Let friends anywhere join' }).click()
  await expect(owner.getByText("You're behind CGNAT")).toBeVisible()
  await expect(owner.getByTestId('host-findings')).toHaveAttribute('data-nat', 'cgnat')
  const help = owner.getByTestId('cgnat-help')
  await expect(help.getByTestId('ownership-note')).toHaveText("Your server, your choice. Iskra gets nothing from this; it's just a guide.")
  await expect(help).toContainText("Port forwarding on your own router can't help")
  await expect(help).toContainText('only the person who hosts needs an open connection')
  // Quickest first: rent a small server, check, ask the provider, Tailscale, let a friend host.
  const options = help.locator('.cgnat-options > li')
  await expect(options).toHaveCount(5)
  await expect(options.nth(0)).toContainText('Rent a small server, ready in about 15 minutes')
  await expect(options.nth(1)).toContainText('Your router says 100.72.10.5, which is shared')
  await expect(options.nth(2)).toContainText('Ask your provider for a public IPv4 address')
  await expect(options.nth(3)).toContainText('Use Tailscale (free).')
  await expect(options.nth(4)).toContainText('Let someone in your group with an open connection host')
  await expect(help).not.toContainText('IPv6')
  await expect(step(owner, 'address')).toHaveAttribute('data-state', 'problem')
  await expect(owner.getByTestId('manual-forwards')).toHaveCount(0)
  const overflow = await owner.locator('.internet').evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await owner.locator('.internet-callout:not(.p2p-section)').scrollIntoViewIfNeeded()
  await owner.screenshot({ path: join(SHOTS, 'hosting-cgnat-phone.png') })

  // Rent a small server: plain steps, the setup text to paste, and the owner key that only this app knows.
  await options.nth(0).getByRole('button', { name: 'Rent a small server' }).click()
  const rent = owner.getByRole('dialog', { name: 'Rent a small server' })
  await expect(rent.getByTestId('ownership-note')).toBeVisible()
  await expect(rent.getByRole('link', { name: 'Hetzner' })).toHaveAttribute('href', 'https://www.hetzner.com/cloud')
  await expectAccessible(owner, rent)
  await rent.getByLabel('Server name').fill('Game Night')
  const setup = rent.getByTestId('rent-setup')
  await expect(setup).toHaveValue(/^#!\/bin\/bash/)
  await expect(setup).toHaveValue(/"Name": "Game Night"/)
  await expect(setup).toHaveValue(/"OwnerClaim": "[A-Za-z0-9_-]{43}"/)
  await rent.getByRole('button', { name: 'Copy setup text' }).click()
  await expect(rent.getByRole('button', { name: 'Copied' })).toBeVisible()
  await rent.getByLabel("The server's IPv4 address").fill('192.168.1.5')
  await rent.getByRole('button', { name: 'Connect' }).click()
  await expect(rent.getByRole('alert')).toContainText("doesn't look like a public IPv4 address")
  await rent.getByRole('button', { name: 'Copy a prompt for an AI assistant instead' }).click()
  await expect(rent.getByTestId('rent-ai-prompt').getByLabel('Prompt')).toHaveValue(/SHA256SUMS\.txt/)
  await owner.screenshot({ path: join(SHOTS, 'hosting-rent-phone.png') })
  const rentOverflow = await rent.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(rentOverflow).toBeLessThanOrEqual(0)
  await rent.getByRole('button', { name: 'Close' }).click()

  // Use Tailscale: why, what it sees, that it's free, the steps, and an invite with the Tailscale address.
  await options.nth(3).getByRole('button', { name: 'Show me how' }).click()
  const guide = owner.getByRole('dialog', { name: 'Use Tailscale (free)' })
  await expect(guide.getByTestId('ownership-note')).toHaveText("Your server, your choice. Iskra gets nothing from this; it's just a guide.")
  await expect(guide).toContainText('shares one internet address between many homes')
  await expect(guide).toContainText('as if they were on the same network')
  await expect(guide).toContainText('up to 6 people and as many devices as you like')
  await expect(guide).toContainText('which devices connect to which')
  await expect(guide).toContainText('sign in with Google, Microsoft, Apple or GitHub')
  await expect(guide).toContainText('presses Accept')
  const downloads = guide.getByRole('link', { name: 'tailscale.com/download' })
  await expect(downloads).toHaveCount(2)
  for (const link of await downloads.all()) await expect(link).toHaveAttribute('href', 'https://tailscale.com/download')
  await expect(guide.getByTestId('tailscale-found')).toContainText(`http://100.101.102.103:${server.port}`)
  await expectAccessible(owner, guide)
  const guideOverflow = await guide.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(guideOverflow).toBeLessThanOrEqual(0)
  await settle(owner)
  await owner.screenshot({ path: join(SHOTS, 'hosting-tailscale-phone.png') })

  await guide.getByRole('button', { name: 'Invite friends over Tailscale' }).click()
  const invite = owner.getByRole('dialog', { name: /Invite friends to/ })
  await expect(invite.getByRole('radio', { name: 'Over Tailscale' })).toHaveAttribute('aria-checked', 'true')
  const input = invite.locator('.copy-row input')
  await expect(input).toHaveValue(/#\/join\//)
  const serverUrl = (value: string) => Buffer.from(value.split('/join/')[1].split('.')[0], 'base64url').toString()
  expect(serverUrl(await input.inputValue())).toBe(`http://100.101.102.103:${server.port}`)
  await settle(owner)
  await owner.screenshot({ path: join(SHOTS, 'hosting-tailscale-invite-phone.png') })
  // The usual invite is one tap away.
  await invite.getByRole('radio', { name: 'Network or internet' }).click()
  await expect.poll(async () => serverUrl(await input.inputValue())).not.toContain('100.101.102.103')
})

test('no router: every port listed to forward by hand', async ({ browser }) => {
  const server = await startServer('No UPnP', 'none')
  servers.push(server)
  const owner = await (await browser.newContext()).newPage()
  await joinVia(owner, server.ownerLink(), 'Owner')
  await openSettings(owner)
  await owner.getByRole('switch', { name: 'Let friends anywhere join' }).click()
  await expect(step(owner, 'router')).toHaveAttribute('data-state', 'problem')
  const rows = owner.getByTestId('manual-forwards').locator('tbody tr')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toContainText('80')
  await expect(rows.nth(1)).toContainText('443')
  await expect(rows.nth(3)).toContainText('UDP')
  await expect(owner.getByTestId('manual-forwards')).toContainText('Find "Port forwarding"')

  // A prompt for an AI assistant: shown first, editable, and never with the public address or invite links.
  await owner.getByRole('button', { name: 'Copy a prompt for an AI assistant' }).click()
  const prompt = owner.getByTestId('ai-prompt').getByLabel('Prompt')
  await expect(prompt).toHaveValue(/outside port 7882 UDP|outside port \d+ UDP/)
  await expect(prompt).toHaveValue(/Ports to forward to that computer/)
  const text = await prompt.inputValue()
  expect(text).not.toMatch(/#\/join|sslip|https:\/\//)
  await prompt.fill(text + '\nMy router is in the hallway.')
  await owner.getByRole('button', { name: 'Copy prompt' }).click()
  await expect(owner.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await owner.evaluate(() => navigator.clipboard.readText())).toContain('My router is in the hallway.')
  // Not reachable and no router: honest options in case the connection is shared.
  await expect(owner.getByTestId('cgnat-help')).toContainText("You're probably behind CGNAT")
  await owner.getByTestId('ai-prompt').scrollIntoViewIfNeeded()
  await owner.screenshot({ path: join(SHOTS, 'hosting-forward-help.png') })
})

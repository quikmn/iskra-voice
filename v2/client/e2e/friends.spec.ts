import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { APP_PORT } from '../playwright.config'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DLL = resolve(HERE, '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')
const SHOTS = resolve(HERE, 'screenshots')

let world: string
let server: ChildProcess

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer().listen(0, () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => done(port))
    })
  })
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true })
  world = mkdtempSync(join(tmpdir(), 'iskra-e2e-'))
  const port = await freePort()
  writeFileSync(join(world, 'server.json'), JSON.stringify({ Name: 'Game Night', Port: port, AppUrl: `http://localhost:${APP_PORT}` }))
  server = spawn('dotnet', [SERVER_DLL, world], { stdio: 'ignore' })
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`http://localhost:${port}`)).ok) return
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not start')
})

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r))
    server.kill()
    await exited
  }
  rmSync(world, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

async function joinVia(page: Page, link: string, name: string) {
  await page.goto(link)
  await expect(page.getByText("You've been invited")).toBeVisible()
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible()
}

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('Message #general')
  await box.fill(text)
  await box.press('Enter')
}

test('two friends join with invite links and chat', async ({ browser }) => {
  const ownerLink = readFileSync(join(world, 'owner-invite.txt'), 'utf8').trim()
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, ownerLink, 'Host')
  await expect(host.locator('.me-text')).toContainText('owner')

  // The host makes an invite link from the UI.
  await host.getByRole('button', { name: '+ Invite friends' }).click()
  const linkInput = host.locator('.copy-row input')
  await expect(linkInput).toHaveValue(/#\/join\//)
  const friendLink = await linkInput.inputValue()
  await host.keyboard.press('Escape')

  const friendContext = await browser.newContext()
  const friend = await friendContext.newPage()
  await joinVia(friend, friendLink, 'Friend')

  await send(friend, 'hey! 👋 is this thing on? https://iskra.foo')
  await expect(host.getByText('is this thing on?')).toBeVisible()
  await expect(host.locator('.message-text a[href="https://iskra.foo"]')).toBeVisible()

  await send(host, 'loud and clear')
  await expect(friend.getByText('loud and clear')).toBeVisible()

  // Both are listed online.
  await expect(host.locator('.member-list')).toContainText('Friend')

  // Markup in messages is shown as text, never run.
  await send(friend, '<img src=x onerror="document.title=\'pwned\'">')
  await expect(host.getByText('<img src=x onerror')).toBeVisible()
  expect(await host.title()).toBe('Iskra')

  await host.screenshot({ path: join(SHOTS, 'desktop-host.png') })

  // Reloading keeps your identity and your servers.
  await friend.reload()
  await expect(friend.getByRole('heading', { name: '# general' })).toBeVisible()
  await expect(friend.getByText('loud and clear')).toBeVisible()

  // Phone size.
  await friend.setViewportSize({ width: 390, height: 844 })
  await friend.waitForTimeout(400) // drawers slide out
  await expect(friend.locator('.nav-column')).not.toBeInViewport()
  await friend.screenshot({ path: join(SHOTS, 'phone-chat.png') })
  await friend.getByRole('button', { name: 'Open channels' }).click()
  await friend.waitForTimeout(400)
  await expect(friend.getByRole('button', { name: '# general' })).toBeInViewport()
  await friend.screenshot({ path: join(SHOTS, 'phone-nav.png') })
})

test('a fresh browser starts at onboarding', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await host.goto('/')
  await expect(host.getByLabel('Your name')).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'onboarding.png') })
})

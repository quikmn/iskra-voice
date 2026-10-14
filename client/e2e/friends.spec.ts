import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Game Night')
})
test.afterAll(async () => server?.stop())

test('two friends join with invite links and chat', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await expect(host.locator('.me-text')).toContainText('owner')

  // The host makes an invite link from the UI.
  const friendLink = await createInviteLink(host)

  const friendContext = await browser.newContext()
  const friend = await friendContext.newPage()
  // Browsers on a computer can hand the invite to the desktop app instead.
  await friend.goto(friendLink)
  await expect(friend.getByRole('link', { name: 'Open in the app' })).toHaveAttribute('href', `iskra://join/${friendLink.split('/join/')[1]}`)
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
  await expect(friend.getByRole('heading', { name: 'general' })).toBeVisible()
  await expect(friend.getByText('loud and clear')).toBeVisible()

  // Phone size.
  await friend.setViewportSize({ width: 390, height: 844 })
  await friend.waitForTimeout(400) // drawers slide out
  await expect(friend.locator('.nav-column')).not.toBeInViewport()
  await friend.screenshot({ path: join(SHOTS, 'phone-chat.png') })
  await friend.getByRole('button', { name: 'Open channels' }).click()
  await friend.waitForTimeout(400)
  await expect(friend.getByRole('button', { name: 'general' })).toBeInViewport()
  await friend.screenshot({ path: join(SHOTS, 'phone-nav.png') })
})

test('a fresh browser starts at onboarding', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await host.goto('/')
  await expect(host.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'onboarding.png') })
})

test('with no servers, you can find out how to start one and change your name', async ({ browser }) => {
  // A Windows visitor is offered the Windows app first (others get theirs: see links.test.ts).
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  const page = await (await browser.newContext({ userAgent: windows })).newPage()
  await page.goto('/')
  await agreeToTerms(page)
  await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await page.getByLabel('Your name').fill('Newbie')
  await page.getByRole('button', { name: 'Continue' }).click()

  // Home is the Friends page, led by how to join or start a server (the Friends row is really where you are).
  await expect(page.getByRole('heading', { name: 'No servers yet' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Friends', level: 1 })).toBeVisible()
  await expect(page.getByText('No friends yet')).toHaveCount(0)
  await expect(page.locator('.channel-sidebar .channel.active')).toHaveText('Friends')

  await page.getByRole('button', { name: 'Start your own server' }).click()
  const guide = page.getByRole('dialog', { name: 'Start your own server' })
  await expect(guide.getByRole('note')).toHaveCount(0)
  await expect(guide.getByRole('link', { name: 'Download Iskra for Windows' })).toHaveAttribute('href', /Iskra-Setup-.*\.exe$/)
  await expect(guide.getByRole('link', { name: 'Linux', exact: true })).toHaveAttribute('href', /linux-x64\.tar\.gz$/)
  await expect(guide.getByRole('link', { name: 'Mac (Apple silicon)' })).toHaveAttribute('href', /-mac-arm64\.dmg$/)
  await page.keyboard.press('Escape')

  // A group needs a server: New group leads to joining one instead of a dead end.
  await page.getByRole('button', { name: 'New group' }).first().click()
  const group = page.getByRole('dialog', { name: 'New group' })
  await expect(group).toContainText("Join a friend's server first")
  await group.getByRole('button', { name: 'Join a server' }).click()
  await expect(page.getByRole('dialog', { name: 'Join a server' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Settings are reachable from Home too.
  await page.getByRole('button', { name: 'My settings', exact: true }).click()
  const name = page.getByRole('dialog', { name: 'Settings' }).getByLabel('Name', { exact: true })
  await name.fill('Veteran')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.me-text strong')).toHaveText('Veteran')
})

test('on a phone, starting a server says it needs a computer', async ({ browser }) => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  const page = await (await browser.newContext({ userAgent: iphone, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await page.goto('/')
  await agreeToTerms(page)
  await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await page.getByLabel('Your name').fill('Phone')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'No servers yet' })).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'no-servers-phone.png') })
  await page.getByRole('button', { name: 'Start your own server' }).click()
  const guide = page.getByRole('dialog', { name: 'Start your own server' })
  await expect(guide.getByRole('note')).toContainText('A server runs on a computer')
  await expect(guide.getByRole('link', { name: /^Download Iskra for/ })).toHaveCount(0)
  // No Windows or server downloads on a phone: the app goes on a computer, or rent a server from here.
  await expect(guide.getByRole('link', { name: /Windows|Linux|\.deb/ })).toHaveCount(0)
  await expect(guide.getByRole('heading', { name: 'On your computer: the Iskra app' })).toBeVisible()
  await expect(guide.getByRole('button', { name: 'Copy the download link' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expect(guide).toBeInViewport()
  await page.screenshot({ path: join(SHOTS, 'start-server-phone.png') })
  await guide.getByRole('button', { name: 'Rent a small server' }).click()
  await expect(page.getByRole('dialog', { name: 'Rent a small server' })).toBeVisible()
})

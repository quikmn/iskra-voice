// Starboard, Birthdays and Welcome: an admin turns them on and sets them up in Server settings → Bots; a newcomer gets
// the admin's welcome (and a private one), a starred message lands on #starboard with a way back, and a birthday
// shared with /birthday gets its greeting. The settings fit a phone.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Pizza Club')
})
test.afterAll(async () => {
  await server?.stop()
})

async function openBots(page: Page) {
  await page.getByRole('button', { name: /server options/ }).click()
  await page.getByRole('menuitem', { name: 'More settings' }).click()
  await page.getByRole('menuitem', { name: 'Bots & webhooks' }).click()
  await page.getByRole('tab', { name: 'Bots' }).click()
}

test('Starboard, Birthdays and Welcome: set up by an admin, then they do their thing', async ({ browser }) => {
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // Three more switches; Starboard makes its own read-only #starboard.
  await openBots(host)
  for (const name of ['Starboard', 'Birthdays', 'Welcome']) {
    const toggle = host.getByRole('switch', { name: `Turn ${name} on` })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  }

  // Starboard: 🔥 instead of ⭐, and one is enough here.
  await host.getByRole('button', { name: 'Starboard settings' }).click()
  const star = host.getByTestId('builtin-starboard-settings')
  await expect(star.getByLabel('Channel')).toHaveValue(/\d+/)
  await expect(star.getByLabel('Channel').locator('option:checked')).toHaveText('#starboard')
  await star.getByRole('radio', { name: '🔥' }).click()
  await star.getByLabel('Reactions needed').fill('1')
  await star.getByRole('button', { name: 'Save' }).click()
  await expect(star.getByRole('status')).toHaveText('Saved.')

  // Birthdays: greetings from midnight, so today's birthday shows right away.
  await host.getByRole('button', { name: 'Birthdays settings' }).click()
  const birthdays = host.getByTestId('builtin-birthdays-settings')
  await birthdays.getByLabel('Time of day').fill('00:00')
  await birthdays.getByRole('button', { name: 'Save' }).click()
  await expect(birthdays.getByRole('status')).toHaveText('Saved.')

  // Welcome: the admin's own words, previewed as they'll look.
  await host.getByRole('button', { name: 'Welcome settings' }).click()
  const welcome = host.getByTestId('builtin-welcome-settings')
  await welcome.getByLabel('Welcome message').fill('Hi {name}, welcome to **{server}**! 🍕')
  await expect(welcome.locator('.welcome-preview')).toContainText('Hi @Host, welcome to Pizza Club!')
  await welcome.getByLabel('Private welcome (optional)').fill('Psst {name}, the pizza votes happen in #general.')
  await welcome.getByRole('button', { name: 'Save' }).click()
  await expect(welcome.getByRole('status')).toHaveText('Saved.')
  await host.screenshot({ path: join(SHOTS, 'more-bots-settings.png') })
  await host.keyboard.press('Escape')
  await expect(host.locator('.channel', { hasText: 'starboard' })).toBeVisible()

  // A friend joins: greeted in #general by name, and privately.
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  await expect(host.locator('.welcome-post', { hasText: 'Hi @Friend, welcome to Pizza Club! 🍕' })).toBeVisible()
  await expect(friend.locator('.welcome-post', { hasText: 'Psst @Friend, the pizza votes happen in #general.' })).toBeVisible({ timeout: 15_000 })

  // A 🔥 from someone else puts the message on the board; the card leads back to it.
  await send(host, 'pizza night was great')
  const message = friend.locator('.message', { hasText: 'pizza night was great' })
  await message.hover()
  await message.getByRole('button', { name: 'Add reaction' }).click()
  await friend.getByRole('menuitem', { name: '🔥' }).click()
  await host.locator('.channel', { hasText: 'starboard' }).click()
  const card = host.getByTestId('starboard-card')
  await expect(card).toContainText('Host in #general')
  await expect(card).toContainText('pizza night was great')
  await expect(card.locator('.starboard-count')).toContainText('1')
  await host.screenshot({ path: join(SHOTS, 'more-bots-starboard.png') })
  await card.getByRole('button', { name: 'Jump to message' }).click()
  await expect(host.getByPlaceholder('Message #general')).toBeVisible()

  // Birthdays: shared with /birthday (answered privately), greeted today, listed as coming up.
  const today = new Date()
  const month = today.toLocaleString('en-US', { month: 'long' })
  await send(friend, `/birthday set ${today.getDate()} ${month}`)
  await expect(friend.locator('.builtin-reply', { hasText: `Saved: ${month} ${today.getDate()}` })).toBeVisible()
  await expect(host.locator('.birthday-greeting', { hasText: "It's Friend's birthday today!" })).toBeVisible({ timeout: 30_000 })
  await send(friend, '/birthday list')
  await expect(friend.locator('.birthday-list li', { hasText: 'Friend' })).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'more-bots-birthday.png') })

  // In the friend's profile for this server: the same date, removable there.
  await friend.getByRole('button', { name: /server options/ }).click()
  await friend.getByRole('menuitem', { name: 'Server nickname…' }).click()
  const field = friend.getByTestId('birthday-field')
  await expect(field.getByLabel('Day')).toHaveValue(String(today.getDate()))
  await expect(field.getByLabel('Month')).toHaveValue(String(today.getMonth() + 1))
  await field.getByRole('button', { name: 'Remove' }).click()
  await expect(field.getByRole('status')).toHaveText('Removed.')
  await friend.keyboard.press('Escape')

  // At phone width the settings fit the screen.
  await openBots(host)
  await host.getByRole('button', { name: 'Welcome settings' }).click()
  await host.setViewportSize({ width: 390, height: 844 })
  const narrow = host.getByTestId('builtin-welcome-settings')
  await expect(narrow).toBeVisible()
  const box = await narrow.boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect(await host.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await host.screenshot({ path: join(SHOTS, 'more-bots-mobile.png') })
})

// Built-in bots: an admin turns Dice, Polls and Reminders on with one click; they show as built-in bot members, their
// commands are suggested on "/", and the server answers them. Turned off, they're gone. In an encrypted channel the app
// says why no command is offered.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Bot Shelf Test')
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

test('built-in bots: one click on, commands answered by the server, one click off', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // Server settings → Bots: three switches, all off.
  await openBots(host)
  await expect(host.getByRole('heading', { name: 'Built-in bots' })).toBeVisible()
  for (const name of ['Dice', 'Polls', 'Reminders']) {
    const toggle = host.getByRole('switch', { name: `Turn ${name} on` })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  }
  await host.screenshot({ path: join(SHOTS, 'builtin-bots-settings.png') })
  // They're managed here, not listed with the bots people add.
  await expect(host.getByText('No bots yet.')).toBeVisible()
  await host.keyboard.press('Escape')

  // Each is an online member with a BUILT-IN badge.
  const dice = host.locator('.member-list .member', { hasText: 'Dice' })
  await expect(dice.locator('.bot-badge.builtin')).toHaveText('BUILT-IN')
  await expect(host.locator('.member-list .member .bot-badge.builtin')).toHaveCount(3)

  // "/" suggests their commands, described in the app's words.
  const box = host.getByPlaceholder('Message #general')
  await box.fill('/')
  const list = host.getByRole('listbox', { name: 'Bot commands' })
  await expect(list.getByRole('option')).toHaveCount(3)
  await expect(list.getByRole('option', { name: /\/roll/ })).toContainText('Roll dice, like 2d6+3')
  await expect(list.getByRole('option', { name: /\/poll/ })).toContainText('Start a poll')
  await expect(list.getByRole('option', { name: /\/remind/ })).toContainText('Get a reminder later')
  await host.screenshot({ path: join(SHOTS, 'builtin-bots-commands.png') })

  // Dice: every die shown, then the total.
  await box.fill('/roll 2d6+3')
  await box.press('Enter')
  const roll = host.locator('.builtin-roll').last()
  await expect(roll).toContainText('Host rolled 2d6+3')
  await expect(roll.locator('.die')).toHaveCount(2)
  const faces = await roll.locator('.die').allTextContents()
  await expect(roll.locator('.dice-total')).toHaveText(String(faces.reduce((sum, f) => sum + Number(f), 3)))
  await expect(host.locator('.message', { has: roll }).locator('.bot-badge.builtin')).toBeVisible()

  // Polls: a real poll anyone can vote on.
  await box.fill('/poll Pizza or tacos? | Pizza | Tacos')
  await box.press('Enter')
  const poll = host.locator('.poll', { hasText: 'Pizza or tacos?' })
  await expect(host.locator('.message', { has: poll }).locator('.author')).toHaveText('Polls')
  await poll.getByRole('radio', { name: 'Tacos' }).click()
  await poll.getByRole('button', { name: 'Vote' }).click()
  await expect(poll.locator('.poll-result.mine')).toContainText('Tacos')

  // Reminders: confirmed in the app's words with the local time, and listed with your other reminders.
  await box.fill('/remind me in 10m take the pizza out')
  await box.press('Enter')
  await expect(host.locator('.builtin-reply', { hasText: "OK Host, I'll remind you:" })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'builtin-bots-answers.png') })

  // Nonsense gets a friendly hint.
  await box.fill('/roll banana')
  await box.press('Enter')
  await expect(host.locator('.builtin-reply', { hasText: '"banana" isn\'t dice notation' })).toBeVisible()

  // A friend on a phone sees the same answers, and they fit the screen.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, await createInviteLink(host), 'Phone')
  const phoneRoll = phone.locator('.builtin-roll').first()
  await expect(phoneRoll).toBeVisible()
  const rollBox = await phoneRoll.boundingBox()
  expect(rollBox!.x + rollBox!.width).toBeLessThanOrEqual(390)
  await phone.screenshot({ path: join(SHOTS, 'builtin-bots-mobile.png') })

  // Off again: Dice leaves, and "/roll" gets no answer.
  await openBots(host)
  await host.getByRole('switch', { name: 'Turn Dice on' }).click()
  await expect(host.getByRole('switch', { name: 'Turn Dice on' })).toHaveAttribute('aria-checked', 'false')
  await host.keyboard.press('Escape')
  await expect(host.locator('.member-list .member', { hasText: 'Dice' })).toHaveCount(0)
  const rolls = await host.locator('.builtin-roll').count()
  await box.fill('/roll d20')
  await box.press('Enter')
  await expect(host.locator('.message-text').getByText('/roll d20', { exact: true })).toBeVisible()
  await host.waitForTimeout(1000)
  await expect(host.locator('.builtin-roll')).toHaveCount(rolls)
  // Its earlier answers still say who wrote them.
  await expect(host.locator('.message', { has: host.locator('.builtin-roll') }).first().locator('.author')).toHaveText('Dice')

  // An encrypted channel: no command is offered, and the app says why.
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByPlaceholder('game-night').fill('vault')
  await create.getByLabel('Who can see it').selectOption('trusted')
  await create.getByTestId('e2ee-toggle').check()
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(host.getByRole('heading', { name: 'vault' })).toBeVisible()
  const vaultBox = host.getByPlaceholder('Message #vault')
  await vaultBox.fill('/')
  await expect(host.getByText("Bots can't read encrypted channels, so /commands don't work here.")).toBeVisible()
  await expect(host.getByRole('listbox', { name: 'Bot commands' })).toHaveCount(0)
  await host.screenshot({ path: join(SHOTS, 'builtin-bots-encrypted.png') })
})

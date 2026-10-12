import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { Bot } from '../../bots/sdk/src/index'
import { describe as describeRoll, roll } from '../../bots/examples/dice-rules'
import { createInviteLink, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
let botDir: string
let bot: Bot | null = null
test.beforeAll(async () => {
  server = await startServer('Bots Test')
  botDir = mkdtempSync(join(tmpdir(), 'iskra-e2e-bot-'))
})
test.afterAll(async () => {
  bot?.stop()
  await server?.stop()
  rmSync(botDir, { recursive: true, force: true })
})

test('a webhook posts a card, and a bot answers a /command', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // An admin makes a webhook for #general and copies its secret URL.
  // The server menu → More settings → Bots & webhooks.
  await host.getByRole('button', { name: /server options/ }).click()
  await host.getByRole('menuitem', { name: 'More settings' }).click()
  await host.getByRole('menuitem', { name: 'Bots & webhooks' }).click()
  await host.getByLabel('Name').fill('Deploys')
  await host.getByRole('button', { name: 'Create webhook' }).click()
  const urlBox = host.getByLabel('Webhook URL')
  await expect(urlBox).toHaveValue(/\/hooks\/[\w-]+\/[\w-]+$/)
  const hookUrl = await urlBox.inputValue()
  await expect(host.locator('.hook-name')).toHaveText('Deploys')
  await host.screenshot({ path: join(SHOTS, 'webhooks-dialog.png') })

  // Some outside tool posts to it, Discord-style.
  const response = await fetch(hookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'Build **passed** @everyone',
      embeds: [{
        title: 'v1.4.2 is live', url: 'https://example.com/changelog', description: '3 fixes, 1 new map', color: 0x57f287,
        fields: [{ name: 'Region', value: 'EU', inline: true }, { name: 'Players', value: '12', inline: true }],
        footer: { text: 'deploy #812' }, image: { url: 'https://tracker.example/pixel.png' },
      }],
    }),
  })
  expect(response.status).toBe(204)

  // The bot tab: a single-use bot invite, used by a bot built with the SDK.
  await host.getByRole('tab', { name: 'Bots' }).click()
  await host.getByRole('button', { name: 'Create bot invite' }).click()
  const inviteBox = host.getByLabel('Bot invite link')
  await expect(inviteBox).toHaveValue(/#\/join\//)
  const invite = await inviteBox.inputValue()
  await host.keyboard.press('Escape')

  const webhookMessage = host.locator('.message', { hasText: 'Build passed' })
  await expect(webhookMessage.locator('.author')).toHaveText('Deploys')
  await expect(webhookMessage.locator('.bot-badge')).toBeVisible()
  await expect(webhookMessage.locator('.embed-title a')).toHaveText('v1.4.2 is live')
  await expect(webhookMessage.locator('.embed-field-name')).toHaveText(['Region', 'Players'])
  await expect(webhookMessage.locator('img[src*="tracker.example"]')).toHaveCount(0)
  await expect(webhookMessage.locator('.message-text')).not.toHaveText(/(^|\s)@everyone\b/)

  bot = new Bot({ name: 'Dice', invite, stateFile: join(botDir, 'dice.bot.json'), log: () => undefined })
  bot.command('roll', 'Rolls dice', async ({ args, message, reply }) => {
    const result = roll(args)
    if (!result) return
    await message.react('🎲')
    await reply(`${message.authorName} rolled ${describeRoll(result)}`)
  })
  await bot.start()
  await expect(host.locator('.member', { hasText: 'Dice' }).locator('.bot-badge')).toBeVisible()

  await send(host, '/roll d6')
  const answer = host.locator('.message', { hasText: 'Host rolled 1d6' })
  await expect(answer.locator('.author')).toHaveText('Dice')
  await expect(answer.locator('.bot-badge')).toBeVisible()
  await expect(answer.locator('strong')).toHaveText(/^[1-6]$/)
  await expect(host.locator('.message', { hasText: '/roll d6' }).locator('.reaction')).toContainText('🎲')
  await host.screenshot({ path: join(SHOTS, 'bots-chat.png') })

  // A friend on a phone: cards and badges fit the screen.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, await createInviteLink(host), 'Phone')
  const card = phone.locator('.message', { hasText: 'Build passed' }).locator('.embed')
  await expect(card).toBeVisible()
  const box = await card.boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await expect(phone.locator('.message', { hasText: 'Host rolled 1d6' }).locator('.bot-badge')).toBeVisible()
  await phone.screenshot({ path: join(SHOTS, 'bots-mobile.png') })
})

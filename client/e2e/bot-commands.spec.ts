// Bot commands: a bot registers its /commands, the composer suggests them as you type "/", and the bot answers
// with a card.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { Bot } from '../../bots/sdk/src/index'
import { roll, rollCard } from '../../bots/examples/dice-rules'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
let botDir: string
let bot: Bot | null = null
test.beforeAll(async () => {
  server = await startServer('Bot Commands Test')
  botDir = mkdtempSync(join(tmpdir(), 'iskra-e2e-cmd-'))
})
test.afterAll(async () => {
  bot?.stop()
  await server?.stop()
  rmSync(botDir, { recursive: true, force: true })
})

// A 1×1 PNG, as a card thumbnail (data: URLs and the server's own files are the only pictures cards may show).
const DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('typing "/" suggests bot commands, and the bot answers with a card', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // A bot invite from Bots & webhooks.
  await host.getByRole('button', { name: /server options/ }).click()
  await host.getByRole('menuitem', { name: 'More settings' }).click()
  await host.getByRole('menuitem', { name: 'Bots & webhooks' }).click()
  await host.getByRole('tab', { name: 'Bots' }).click()
  await host.getByRole('button', { name: 'Create bot invite' }).click()
  const inviteBox = host.getByLabel('Bot invite link')
  await expect(inviteBox).toHaveValue(/#\/join\//)
  const invite = await inviteBox.inputValue()
  await host.keyboard.press('Escape')

  bot = new Bot({ name: 'Dice', invite, stateFile: join(botDir, 'dice.bot.json'), log: () => undefined })
  bot.commands([
    {
      name: 'roll',
      description: 'Rolls dice',
      options: [{ name: 'dice', description: 'Like 2d6', type: 'string', required: true, choices: [
        { name: 'Twenty-sided', value: 'd20' }, { name: 'Two dice', value: '2d6' },
      ] }],
      handler: async ({ options, userName, reply }) => {
        const result = roll(String(options.dice), () => 0.5)
        if (!result) return
        await reply({ text: `${userName} rolled **${result.total}**`, cards: [{ ...rollCard(result), thumbnail: { url: DOT } }] })
      },
    },
    { name: 'coin', description: 'Flips a coin', handler: ({ reply }) => reply('Heads!') },
  ])
  await bot.start()
  await expect(host.locator('.member', { hasText: 'Dice' }).locator('.bot-badge')).toBeVisible()

  // "/" lists the bot's commands, with the bot and descriptions.
  const box = host.getByPlaceholder('Message #general')
  await box.fill('/')
  const list = host.getByRole('listbox', { name: 'Bot commands' })
  await expect(list).toBeVisible()
  await expect(list.getByRole('option')).toHaveCount(7) // roll, coin and the built-in help, plus the app's /teams, /lfg, /tts and /roles
  await expect(list.getByRole('option', { name: /\/roll/ })).toContainText('Rolls dice')
  await expect(list.getByRole('option', { name: /\/roll/ })).toContainText('Dice')
  await expect(box).toHaveAttribute('aria-controls', await list.getAttribute('id') as string)
  const first = await box.getAttribute('aria-activedescendant')
  await box.press('ArrowDown')
  expect(await box.getAttribute('aria-activedescendant')).not.toBe(first)
  await host.screenshot({ path: join(SHOTS, 'bot-commands-list.png') })

  // Esc closes it; typing narrows it; Tab completes.
  await box.press('Escape')
  await expect(list).toBeHidden()
  await box.fill('/roll') // "/ro" would still offer the app's /roles too
  await expect(list.getByRole('option')).toHaveCount(1)
  await expect(list.getByRole('option', { selected: true })).toContainText('/roll')
  await box.press('Tab')
  await expect(box).toHaveValue('/roll ')

  // Option hints: the parameter and its choices.
  await expect(host.locator('.command-param.current')).toHaveText('<dice>')
  const choices = host.getByRole('listbox', { name: 'Choices for dice' })
  await expect(choices.getByRole('option')).toHaveCount(2)
  await box.pressSequentially('2')
  await expect(choices.getByRole('option')).toHaveCount(1)
  await box.press('Enter')
  await expect(box).toHaveValue('/roll 2d6 ')
  await host.screenshot({ path: join(SHOTS, 'bot-commands-hint.png') })

  // Enter sends it to the bot (an interaction, not a message); the bot answers with a card.
  await box.press('Enter')
  const answer = host.locator('.message', { hasText: 'Host rolled 8' })
  await expect(answer.locator('.interaction-line')).toHaveText('Host used /roll')
  await expect(answer.locator('.embed-title')).toHaveText('🎲 2d6')
  await expect(answer.locator('.embed-field-value')).toHaveText('4, 4')
  await expect(answer.locator('.embed-thumbnail')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await host.screenshot({ path: join(SHOTS, 'bot-commands-card.png') })

  // A friend on a phone: the list and the card fit the screen.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, await createInviteLink(host), 'Phone')
  const phoneCard = phone.locator('.message', { hasText: 'Host rolled 8' }).locator('.embed')
  await expect(phoneCard).toBeVisible()
  const cardBox = await phoneCard.boundingBox()
  expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(390)
  const phoneBox = phone.getByPlaceholder('Message #general')
  await phoneBox.fill('/')
  const phoneList = phone.getByRole('listbox', { name: 'Bot commands' })
  await expect(phoneList).toBeVisible()
  const listBox = await phoneList.boundingBox()
  expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(390)
  await phone.screenshot({ path: join(SHOTS, 'bot-commands-mobile.png') })
})

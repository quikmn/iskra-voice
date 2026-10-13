// Bot interactions: a typed command goes to the bot (not into the channel), the bot answers in public with a
// "Roll again" button, in private (only the asker sees it), and with a form; and the admin chooses what a bot can read.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { Bot } from '../../bots/sdk/src/index'
import { roll, rollAgain, rollCard } from '../../bots/examples/dice-rules'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
let botDir: string
let bot: Bot | null = null
test.beforeAll(async () => {
  server = await startServer('Bot Interactions Test')
  botDir = mkdtempSync(join(tmpdir(), 'iskra-e2e-interactions-'))
})
test.afterAll(async () => {
  bot?.stop()
  await server?.stop()
  rmSync(botDir, { recursive: true, force: true })
})

test('commands, buttons, private answers and forms go between people and a bot', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // A bot invite: "Can read all messages" is off unless the admin turns it on.
  await host.getByRole('button', { name: /server options/ }).click()
  await host.getByRole('menuitem', { name: 'More settings' }).click()
  await host.getByRole('menuitem', { name: 'Bots & webhooks' }).click()
  await host.getByRole('tab', { name: 'Bots' }).click()
  await expect(host.getByRole('checkbox', { name: /Can read all messages/ })).not.toBeChecked()
  await host.getByRole('button', { name: 'Create bot invite' }).click()
  const inviteBox = host.getByLabel('Bot invite link')
  await expect(inviteBox).toHaveValue(/#\/join\//)
  const invite = await inviteBox.inputValue()

  const heard: string[] = []
  bot = new Bot({ name: 'Dice', invite, stateFile: join(botDir, 'dice.bot.json'), log: () => undefined })
  bot.on('message', (m) => heard.push(m.text))
  bot.commands([
    {
      name: 'roll',
      description: 'Rolls dice',
      options: [
        { name: 'dice', description: 'Like 2d6', type: 'string' },
        { name: 'secret', description: 'Only you see it', type: 'boolean' },
      ],
      handler: async ({ options, userName, reply }) => {
        const result = roll(String(options.dice ?? 'd6'), () => 0.5)!
        await reply({ text: `${userName} rolled ${result.total}`, cards: [rollCard(result)], components: rollAgain(result) },
          { private: options.secret === true })
      },
    },
    {
      name: 'plan',
      description: 'Plans a game night',
      handler: ({ showModal }) => showModal({
        customId: 'plan', title: 'Plan a game night',
        fields: [{ customId: 'title', label: 'Title', maxLength: 40 }, { customId: 'notes', label: 'Notes', style: 'paragraph', required: false }],
      }),
    },
  ])
  bot.onComponent(/^roll:/, async ({ customId, userName, responseId, reply }) => {
    const result = roll(customId.slice(5), () => 0.9)!
    await reply({ text: `${userName} rolled ${result.total}`, components: rollAgain(result) }, { private: responseId !== undefined })
  })
  bot.onModalSubmit('plan', ({ fields, reply }) => reply(`📅 ${fields.title} is planned`))
  await bot.start()

  // The bot list says what it can read; the admin can change it.
  const row = host.locator('.bot-row').filter({ has: host.getByLabel('What Dice can read') }) // not the built-in Dice
  await expect(row).toContainText('Commands and mentions only')
  await host.screenshot({ path: join(SHOTS, 'bot-interactions-scope.png') })
  await host.keyboard.press('Escape')

  const box = host.getByPlaceholder('Message #general')
  await box.fill('just chatting')
  await box.press('Enter')

  // A command goes to the bot; the channel shows only the answer, saying who asked.
  await box.fill('/roll 2d6')
  await box.press('Enter')
  await expect(box).toHaveValue('')
  const answer = host.locator('.message', { hasText: 'Host rolled 8' })
  await expect(answer.locator('.interaction-line')).toHaveText('Host used /roll')
  await expect(answer.locator('.embed-title')).toHaveText('🎲 2d6')
  await expect(host.locator('.message-text', { hasText: '/roll 2d6' })).toHaveCount(0)
  await host.screenshot({ path: join(SHOTS, 'bot-interactions-answer.png') })

  // "Roll again": a click becomes an interaction too.
  await answer.getByRole('button', { name: 'Roll again' }).click()
  await expect(host.locator('.message', { hasText: 'Host rolled 12' })).toBeVisible()
  await expect(host.locator('.message', { hasText: 'Host rolled 12' }).locator('.interaction-line')).toHaveText('Answer to Host')

  // A wrong option is caught before sending, and the text stays.
  await box.fill('/roll d6 maybe')
  await box.press('Enter')
  await expect(host.getByRole('alert').filter({ hasText: 'secret should be yes or no' })).toBeVisible()
  await expect(box).toHaveValue('/roll d6 maybe')

  // A private answer: only the asker sees it, above the composer.
  await box.fill('/roll d6 yes')
  await box.press('Enter')
  const secret = host.locator('.private-answer', { hasText: 'Host rolled 4' })
  await expect(secret).toBeVisible()
  await expect(secret).toContainText('Only you can see this')
  await host.screenshot({ path: join(SHOTS, 'bot-interactions-private.png') })
  // Buttons, the private answer and its labels pass axe (contrast, names, roles).
  const axe = await new AxeBuilder({ page: host }).include('.interaction-tray').include('.bot-components')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice']).analyze()
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])

  // A friend on a phone sees the public answers and buttons, never the private one.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, await createInviteLink(host), 'Phone')
  const phoneButton = phone.locator('.message', { hasText: 'Host rolled 8' }).getByRole('button', { name: 'Roll again' })
  await expect(phoneButton).toBeVisible()
  const buttonBox = await phoneButton.boundingBox()
  expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(390)
  await expect(phone.locator('.private-answer')).toHaveCount(0)
  await phoneButton.tap()
  await expect(phone.locator('.message', { hasText: 'Phone rolled 12' })).toBeVisible()
  await phone.screenshot({ path: join(SHOTS, 'bot-interactions-mobile.png') })

  // Its button works privately; then it's dismissed.
  await secret.getByRole('button', { name: 'Roll again' }).click()
  await expect(host.locator('.private-answer', { hasText: 'Host rolled 6' })).toBeVisible()
  await secret.getByRole('button', { name: 'Dismiss' }).click()
  await expect(host.locator('.private-answer', { hasText: 'Host rolled 4' })).toHaveCount(0)

  // A form from the bot.
  await box.fill('/plan ')
  await box.press('Enter')
  const form = host.getByRole('dialog', { name: 'Plan a game night' })
  await expect(form).toBeVisible()
  await form.getByLabel('Title').fill('Game night')
  await host.screenshot({ path: join(SHOTS, 'bot-interactions-form.png'), animations: 'disabled' })
  await form.getByRole('button', { name: 'Send' }).click()
  await expect(form).toBeHidden()
  await expect(host.locator('.message', { hasText: '📅 Game night is planned' })).toBeVisible()

  // The bot never heard the chat: it reads only what's meant for it.
  expect(heard).not.toContain('just chatting')
})

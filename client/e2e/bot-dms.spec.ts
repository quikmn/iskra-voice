// Bot DMs: a member opens a DM with a bot from the member list, the app suggests the bot's commands on "/", the command
// goes to the bot end-to-end encrypted and its answer comes back as a DM; the bot can write first; built-in bots take no
// DMs; and "DMs from bots" can be turned off in My settings → Privacy & data.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { Bot } from '../../bots/sdk/src/index'
import { roll } from '../../bots/examples/dice-rules'
import { joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
let botDir: string
let bot: Bot | null = null
let other: Bot | null = null
test.beforeAll(async () => {
  server = await startServer('Bot DMs Test')
  botDir = mkdtempSync(join(tmpdir(), 'iskra-e2e-botdms-'))
})
test.afterAll(async () => {
  bot?.stop()
  other?.stop()
  await server?.stop()
  rmSync(botDir, { recursive: true, force: true })
})

async function openBots(page: Page) {
  await page.getByRole('button', { name: /server options/ }).click()
  await page.getByRole('menuitem', { name: 'More settings' }).click()
  await page.getByRole('menuitem', { name: 'Bots & webhooks' }).click()
  await page.getByRole('tab', { name: 'Bots' }).click()
}

async function botInvite(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Create bot invite' }).click()
  const inviteBox = page.getByLabel('Bot invite link')
  await expect(inviteBox).toHaveValue(/#\/join\//)
  return inviteBox.inputValue()
}

test('a member DMs a bot, uses its commands there, and can turn bot DMs off', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  await openBots(host)
  await host.getByRole('switch', { name: 'Turn Polls on' }).click() // a built-in bot, for later
  bot = new Bot({ name: 'Dice', invite: await botInvite(host), stateFile: join(botDir, 'dice.bot.json'), log: () => undefined })
  bot.commands([{
    name: 'roll',
    description: 'Rolls dice',
    options: [{ name: 'dice', description: 'Like 2d6', type: 'string', required: true }],
    handler: ({ options, userName, dm, reply }) => reply(`${userName} rolled ${roll(String(options.dice), () => 0.5)!.total}${dm ? ' (in a DM)' : ''}`),
  }])
  bot.on('dm', (dm) => {
    if (!dm.text.startsWith('/')) void dm.reply(`You said: ${dm.text}`)
  })
  await bot.start()
  await host.keyboard.press('Escape')
  const hostKey = [...bot.members.values()].find((m) => m.name === 'Host')!.accountKey

  // Built-in bots run inside the server and take no DMs: their card has no Message button.
  await host.locator('.member-list .member', { hasText: 'Polls' }).click()
  await expect(host.getByRole('dialog').getByRole('button', { name: 'Message', exact: true })).toHaveCount(0)
  await host.keyboard.press('Escape')

  // From the member list: the bot's card has Message, and no friend request (bots don't take those).
  await host.locator('.member-list .member', { hasText: 'Dice' }).click()
  const card = host.getByRole('dialog')
  await expect(card.getByRole('button', { name: 'Add friend' })).toHaveCount(0)
  await card.getByRole('button', { name: 'Message', exact: true }).click()
  await expect(host.locator('.chat-header .bot-badge')).toBeVisible()
  await expect(host.locator('.channel-start')).toContainText('whoever runs it can read them')

  // "/" suggests the bot's commands; the command is the DM's text, end-to-end encrypted to the bot.
  const box = host.getByPlaceholder('Message Dice')
  await box.fill('/ro')
  await expect(host.locator('.command-suggest')).toContainText('/roll')
  await host.screenshot({ path: join(SHOTS, 'bot-dms-commands.png') })
  await box.press('Enter')
  await expect(box).toHaveValue('/roll ')
  await box.pressSequentially('2d6')
  await expect(host.locator('.command-hint')).toContainText('dice')
  await box.press('Enter')
  await expect(host.locator('.message-text', { hasText: 'Host rolled 8 (in a DM)' })).toBeVisible()
  await box.fill('hello bot')
  await box.press('Enter')
  await expect(host.locator('.message-text', { hasText: 'You said: hello bot' })).toBeVisible()

  // The bot can write first too (DMs from bots are allowed by default).
  await bot.sendDm(hostKey, 'Game night at 8?')
  await expect(host.locator('.message-text', { hasText: 'Game night at 8?' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'bot-dms.png') })

  // Turned off in My settings → Privacy & data.
  await openSettings(host, 'Privacy & data')
  const setting = host.getByRole('checkbox', { name: 'Bots on my servers can send me direct messages' })
  await expect(setting).toBeChecked()
  await setting.uncheck()
  await host.getByTestId('bot-dm-settings').screenshot({ path: join(SHOTS, 'bot-dms-setting.png') })
  await host.keyboard.press('Escape')

  // A bot Host never wrote to can't start a conversation now...
  await host.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: 'Bot DMs Test' }).click()
  await openBots(host)
  other = new Bot({ name: 'Echo', invite: await botInvite(host), stateFile: join(botDir, 'echo.bot.json'), log: () => undefined })
  await other.start()
  await expect.poll(() => other!.sendDm(hostKey, 'hi').then(() => 'sent', (e: { code?: string }) => e.code ?? 'error')).toBe('forbidden')
  // ...but Dice may still answer in the conversation Host started.
  await bot.sendDm(hostKey, 'still here')
})

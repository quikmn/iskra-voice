// Message translation on the device: "Translate" explains when the server doesn't offer models, the owner turns them
// on in Server settings → Translation, the app asks before downloading, then the translation shows under the message,
// and auto-translate does the same by itself. The models aren't in git: `node scripts/get-models.mjs --translate`
// puts English and Swedish into client/.models (the test server serves them from there, never from the internet);
// without them the steps after the download prompt are skipped.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { CAPTION_MODELS, createInviteLink, joinVia, longPress, openServerSettings, send, SHOTS, startServer, type TestServer } from './helpers'

const pins = JSON.parse(readFileSync(new URL('../src/state/translate/models.json', import.meta.url), 'utf8')) as { models: { name: string; dir: string }[] }
const haveModels = ['en-sv', 'sv-en'].every((name) => {
  const pin = pins.models.find((m) => m.name === name)!
  return existsSync(join(CAPTION_MODELS, 'translate', pin.dir, 'vocab.spm.gz.part0.bin'))
})

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Translate')
})
test.afterAll(async () => server?.stop())

async function translateFromMenu(page: Page, text: string) {
  const message = page.locator('.message', { hasText: text }).first()
  await message.hover()
  await message.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Translate' }).click()
  return message
}

test('translate a message on the device, with models from your own server', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  await send(friend, 'Hej! Kommer du på spelkvällen ikväll? Jag tar med snacks.')
  const swedish = await translateFromMenu(host, 'spelkvällen')

  // Off by default: the button explains why nothing happens.
  await expect(swedish.getByTestId('translation-notice')).toContainText('don’t offer translation yet', { timeout: 30_000 })

  // The owner offers it in Server settings → Translation, with what each language weighs.
  const room = await openServerSettings(host, 'Translation')
  const section = room.getByTestId('translate-section')
  await expect(section.getByRole('row', { name: /Swedish/ })).toContainText('MB')
  await section.getByRole('checkbox', { name: 'Offer translation to members' }).check()
  await expect(section.getByRole('checkbox', { name: 'Offer translation to members' })).toBeChecked()
  await host.screenshot({ path: join(SHOTS, 'translate-server-settings.png') })
  await host.keyboard.press('Escape')
  await expect(room).toBeHidden()

  // Asked again: first the download, with its size.
  await translateFromMenu(host, 'spelkvällen')
  const prompt = swedish.getByTestId('translation-download')
  await expect(prompt).toContainText('Translating from Swedish needs a one-time')
  await expect(prompt).toContainText('MB')
  await host.screenshot({ path: join(SHOTS, 'translate-download.png') })

  test.skip(!haveModels, 'the translation models are not downloaded: run node scripts/get-models.mjs --translate from the repo root')

  await prompt.getByRole('button', { name: 'Download' }).click()
  const translation = swedish.getByTestId('translation')
  await expect(translation).toContainText(/tonight/i, { timeout: 60_000 })
  await expect(translation).toContainText('Translated from Swedish')
  // The original stays, the translation is plain text under it.
  await expect(swedish.locator('.message-text')).toContainText('spelkvällen')
  await host.screenshot({ path: join(SHOTS, 'translate-message.png') })

  // "Show original" hides it; the menu offers it again.
  await translation.getByRole('button', { name: 'Show original' }).click()
  await expect(swedish.getByTestId('translation')).toHaveCount(0)

  // Auto-translate here: new messages not in English are translated as they come (the models are on the device now).
  await host.getByTestId('auto-translate-button').click()
  const popover = host.getByRole('dialog', { name: 'Translation' })
  await popover.getByRole('checkbox', { name: 'Auto-translate messages not in my language' }).check()
  await host.screenshot({ path: join(SHOTS, 'translate-auto.png') })
  await host.keyboard.press('Escape')
  await send(friend, 'Servern ligger nere igen, kan någon starta om den?')
  await send(friend, 'ok')
  await send(host, 'Thanks, restarting it now')
  const auto = host.locator('.message', { hasText: 'Servern ligger nere' }).getByTestId('translation')
  await expect(auto).toContainText(/server/i, { timeout: 30_000 })
  // Nothing under English or too-short messages.
  await expect(host.locator('.message', { hasText: 'Thanks, restarting' }).locator('.translation')).toHaveCount(0)
  await expect(host.locator('.message', { hasText: /^ok$/ }).locator('.translation')).toHaveCount(0)

  // On a phone: press and hold → Translate, with a word about mobile data before the download.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, await createInviteLink(host), 'Phone')
  const onPhone = phone.locator('.message', { hasText: 'spelkvällen' }).first()
  await longPress(phone, onPhone.locator('.message-text'))
  await phone.getByRole('menuitem', { name: 'Translate' }).click()
  const phonePrompt = onPhone.getByTestId('translation-download')
  await expect(phonePrompt).toContainText('mobile data', { timeout: 30_000 })
  await phonePrompt.getByRole('button', { name: 'Download' }).click()
  await expect(onPhone.getByTestId('translation')).toContainText(/tonight/i, { timeout: 60_000 })
  await phone.screenshot({ path: join(SHOTS, 'translate-phone.png') })
})

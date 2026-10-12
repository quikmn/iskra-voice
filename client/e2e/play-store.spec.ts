// Google Play store graphics: phone screenshots (1080×1920, 9:16) of the key screens in English and Swedish, with demo
// content, plus the feature graphic and the 512 px icon. Not part of the normal run:
//   cd server; dotnet build src/Iskra.Server
//   cd client; $env:PLAY_SHOTS=1; $env:ISKRA_E2E_PORT=5299; npx playwright test e2e/play-store.spec.ts
// Output (git-ignored): docs/store/play/screenshots/<en-US|sv-SE>/*.png and docs/store/play/graphics/*.png.
// See docs/store/play/app-content.md. Everyone in the screenshots is made up.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { agreeToTerms, hasLiveKit, joinVia, send, startServer, type TestServer } from './helpers'

test.skip(!process.env.PLAY_SHOTS, 'Play store screenshots: set PLAY_SHOTS=1')
test.use({ actionTimeout: 10_000 })

const PLAY = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/store/play')
const GRAPHICS = join(PLAY, 'graphics')

/** 360×640 CSS pixels at 3x: 1080×1920, Play's 9:16 phone size. */
const PHONE = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }

type Lang = 'en' | 'sv'

/** Demo content per language. Names are made up. */
const CONTENT = {
  en: {
    folder: 'en-US',
    locale: 'en-US',
    server: 'Game Night',
    lounge: 'lounge',
    chat: [
      ['Alex', "Who's in for Valheim on Friday? 🛡️"],
      ['Sam', "Me! I'll bring the mead 🍺"],
      ['Noor', 'Count me in. Starting at 8?'],
      ['Maja', "8 works. I'll have the server up, the world is called **Ashlands** 🔥"],
      ['Alex', 'Patch notes are out, the new biome looks wild'],
    ],
    poll: { question: 'What do we play after?', answers: ['Lethal Company', 'Deep Rock Galactic'] },
    pronouns: 'she/her',
    bio: 'Builder of very questionable bases. Ask me about boats ⛵',
    dm: [
      ['Noor', 'Hey! Are you bringing the boat on Friday?'],
      ['Maja', 'Of course, it’s ready to sail ⛵'],
      ['Noor', 'You’re the best 🙌'],
    ],
  },
  sv: {
    folder: 'sv-SE',
    locale: 'sv-SE',
    server: 'Spelkväll',
    lounge: 'häng',
    chat: [
      ['Alex', 'Vem är med på Valheim på fredag? 🛡️'],
      ['Sam', 'Jag! Jag tar med mjödet 🍺'],
      ['Noor', 'Räkna med mig. Kör vi vid åtta?'],
      ['Maja', 'Åtta funkar. Jag har servern igång, världen heter **Ashlands** 🔥'],
      ['Alex', 'Patchnoterna är ute, den nya biomen ser helt galen ut'],
    ],
    poll: { question: 'Vad kör vi efteråt?', answers: ['Lethal Company', 'Deep Rock Galactic'] },
    pronouns: 'hon/henne',
    bio: 'Bygger väldigt tveksamma baser. Fråga mig om båtar ⛵',
    dm: [
      ['Noor', 'Hej! Tar du med båten på fredag?'],
      ['Maja', 'Självklart, den är redo att segla ⛵'],
      ['Noor', 'Du är bäst 🙌'],
    ],
  },
} as const

/**
 * The phone is driven in English (so the steps below match one set of labels) and switched to the screenshot's
 * language just for the picture, through the app's own language setting (the Vite dev server shares the module).
 */
async function setLanguage(page: Page, lang: Lang) {
  await page.evaluate(async (l) => {
    const url = '/src/i18n/index.ts'
    const i18n = (await import(/* @vite-ignore */ url)) as { setLanguageChoice: (choice: string) => void }
    i18n.setLanguageChoice(l)
  }, lang)
  await expect(page.locator('html')).toHaveAttribute('lang', lang)
}

async function shot(page: Page, lang: Lang, name: string) {
  const file = join(PLAY, 'screenshots', CONTENT[lang].folder, `${name}.png`)
  mkdirSync(dirname(file), { recursive: true })
  if (lang !== 'en') await setLanguage(page, lang)
  await page.waitForTimeout(400) // let transitions settle
  await page.screenshot({ path: file, animations: 'disabled' })
  if (lang !== 'en') await setLanguage(page, 'en')
}

/** A phone running the Android app: Capacitor's bridge stands in, as in ios-app.spec.ts. */
async function androidPhone(browser: Browser, lang: Lang): Promise<Page> {
  const context = await browser.newContext({ ...PHONE, locale: CONTENT[lang].locale })
  await context.addInitScript(() => {
    ;(window as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' }
    delete (window as { PushManager?: unknown }).PushManager
    // Android's web view has no screen capture, so the app hides screen sharing.
    delete (MediaDevices.prototype as { getDisplayMedia?: unknown }).getDisplayMedia
    try {
      localStorage.setItem('iskra.language', 'en')
    } catch {
      /* no storage */
    }
  })
  return context.newPage()
}

/** A friend on a computer, posting the demo content (English UI; the text they write is in the shot's language). */
async function friend(browser: Browser, invite: string, name: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })).newPage()
  await page.addInitScript(() => {
    try {
      localStorage.setItem('iskra.language', 'en')
    } catch {
      /* no storage */
    }
  })
  await joinVia(page, invite, name)
  return page
}

/** Opens the phone's channel drawer if it's closed. */
async function drawer(page: Page) {
  const open = page.getByRole('button', { name: /^Open (channels|menu)$/ }).first()
  if (await open.isVisible()) await open.click()
}

/** Closes whatever is open (dialogs, drawers) on the phone. */
async function closeAll(page: Page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
}

for (const lang of ['en', 'sv'] as const) {
  test.describe(`Play screenshots (${lang})`, () => {
    const c = CONTENT[lang]
    let server: TestServer
    test.beforeAll(async () => {
      server = await startServer(c.server, hasLiveKit())
    })
    test.afterAll(async () => server?.stop())

    test(`phone screens in ${c.folder}`, async ({ browser }) => {
      test.setTimeout(300_000)

      // Maja owns the server, on her phone.
      const phone = await androidPhone(browser, lang)
      await joinVia(phone, server.ownerLink(), 'Maja')
      await drawer(phone)
      await phone.getByRole('button', { name: 'Invite friends' }).first().click()
      const linkInput = phone.locator('.copy-row input')
      await expect(linkInput).toHaveValue(/#\/join\//)
      const invite = await linkInput.inputValue()
      await closeAll(phone)
      // The recovery key nudge is for real accounts; the screenshots don't need it.
      await phone.locator('.nudge').getByRole('button', { name: 'Later' }).click()

      const friends = {
        Alex: await friend(browser, invite, 'Alex'),
        Sam: await friend(browser, invite, 'Sam'),
        Noor: await friend(browser, invite, 'Noor'),
      }

      // Noor's profile: pronouns and a line about her.
      const noor = friends.Noor
      await noor.locator('.me-bar').getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = noor.getByRole('dialog', { name: 'Settings' })
      await settings.getByLabel('Pronouns').fill(c.pronouns)
      await settings.getByLabel(/About me/).fill(c.bio)
      await settings.getByRole('button', { name: 'Save profile' }).click()
      await noor.keyboard.press('Escape')

      // The conversation in #general, a reaction and a poll.
      for (const [who, text] of c.chat) {
        if (who === 'Maja') await send(phone, text)
        else await send(friends[who], text)
        await expect(phone.locator('.message-text').last()).toContainText(text.replace(/\*\*/g, '').slice(0, 12))
      }
      const mine = friends.Sam.locator('.message', { hasText: 'Ashlands' }).first()
      await mine.hover()
      await mine.getByRole('button', { name: 'Add reaction' }).click()
      await friends.Sam.locator('.reaction-picker button').first().click()
      const alex = friends.Alex
      await alex.getByRole('button', { name: 'Create a poll' }).click()
      const pollDialog = alex.getByRole('dialog', { name: 'Create a poll' })
      await pollDialog.getByLabel('Question').fill(c.poll.question)
      await pollDialog.getByRole('textbox', { name: 'Answer 1' }).fill(c.poll.answers[0])
      await pollDialog.getByRole('textbox', { name: 'Answer 2' }).fill(c.poll.answers[1])
      await pollDialog.getByRole('button', { name: 'Post poll' }).click()
      for (const [who, answer] of [['Alex', 0], ['Sam', 0], ['Noor', 1]] as const) {
        const poll = friends[who].locator('.poll', { hasText: c.poll.question })
        await poll.getByRole('radio', { name: c.poll.answers[answer] }).click()
        await poll.getByRole('button', { name: 'Vote' }).click()
      }
      const phonePoll = phone.locator('.poll', { hasText: c.poll.question })
      await phonePoll.getByRole('radio', { name: c.poll.answers[0] }).click()
      await phonePoll.getByRole('button', { name: 'Vote' }).click()
      await expect(phonePoll).toContainText('4')
      await phonePoll.scrollIntoViewIfNeeded()
      await expect(phone.locator('.message', { hasText: 'Ashlands' }).locator('.reaction')).toHaveCount(1)
      await shot(phone, lang, '1-text-channel')

      // A DM from Noor (end-to-end encrypted), answered on the phone.
      await noor.locator('.member-list').getByRole('button', { name: /Maja/ }).click()
      await noor.getByRole('button', { name: 'Add friend' }).click()
      await noor.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
      const noorBox = noor.getByPlaceholder('Message Maja')
      await noorBox.fill(c.dm[0][1])
      await noorBox.press('Enter')
      await drawer(phone)
      await phone.getByRole('button', { name: 'Direct messages' }).click()
      const row = phone.locator('.dm-row', { hasText: 'Noor' })
      const menu = phone.getByRole('button', { name: 'Open menu' }).first()
      if (await menu.isVisible()) await menu.click()
      await row.click()
      // Friends: accept Noor's request (the header is tidier without the request buttons).
      await phone.getByRole('button', { name: /^Accept( friend request)?$/ }).first().click()
      const phoneBox = phone.getByPlaceholder('Message Noor')
      await phoneBox.fill(c.dm[1][1])
      await phoneBox.press('Enter')
      await noorBox.fill(c.dm[2][1])
      await noorBox.press('Enter')
      await expect(phone.locator('.message-text', { hasText: c.dm[2][1] })).toBeVisible()
      await phone.keyboard.press('Escape')
      await shot(phone, lang, '3-direct-messages')

      // Back to the server: Noor's profile card from the member list.
      await drawer(phone)
      await phone.locator(`.server-icon[title="${c.server}"]`).click()
      await drawer(phone)
      await phone.locator('.channel', { hasText: 'general' }).first().click()
      await closeAll(phone)
      await phone.getByRole('button', { name: 'Members' }).first().click()
      await phone.locator('.member-list').getByRole('button', { name: /Noor/ }).click()
      await expect(phone.getByText(c.pronouns).last()).toBeVisible()
      await shot(phone, lang, '4-profile-card')
      await closeAll(phone)

      // The server room: every server setting in one place.
      await drawer(phone)
      await phone.locator('.server-header-button').click()
      await phone.getByRole('menuitem', { name: 'Server settings', exact: true }).click()
      await expect(phone.getByRole('dialog', { name: /· Server settings$/ })).toBeVisible()
      await shot(phone, lang, '5-server-settings')
      await closeAll(phone)

      // Voice: a voice channel with friends in it.
      if (hasLiveKit()) {
        await drawer(phone)
        await phone.getByRole('button', { name: 'Create voice channel' }).click()
        await phone.getByRole('radio', { name: 'Voice' }).click()
        await phone.getByLabel('Name').fill(c.lounge)
        await phone.getByLabel('Name').press('Enter') // the Create button is below the fold at 640 px
        await expect(phone.locator('.voice-channel', { hasText: c.lounge })).toHaveCount(1)
        await closeAll(phone)
        for (const page of [alex, friends.Sam]) {
          await page.locator('.voice-channel', { hasText: c.lounge }).getByRole('button').first().click()
          await expect(page.locator('.stage')).toBeVisible({ timeout: 20_000 })
        }
        await drawer(phone)
        await phone.locator('.voice-channel', { hasText: c.lounge }).getByRole('button').first().click()
        await expect(phone.locator('.stage')).toBeVisible({ timeout: 20_000 })
        await expect(phone.locator('.stage .tile, .stage [data-participant]').first()).toBeVisible().catch(() => undefined)
        await phone.waitForTimeout(1500) // let the speaking rings show up
        await shot(phone, lang, '2-voice-channel')
      }
    })

    test(`start a server in ${c.folder}`, async ({ browser }) => {
      const phone = await androidPhone(browser, lang)
      await phone.goto('/')
      await agreeToTerms(phone)
      await phone.getByRole('button', { name: /I’m new to Iskra/ }).click()
      await phone.getByLabel('Your name').fill('Maja')
      await phone.getByRole('button', { name: 'Continue' }).click()
      await expect(phone.getByText('No servers yet')).toBeVisible()
      await phone.getByRole('button', { name: /Start your own server/ }).click()
      await expect(phone.getByRole('dialog')).toBeVisible()
      await shot(phone, lang, '6-start-a-server')
      await phone.context().close()
    })
  })
}

test('feature graphic and icon', async ({ browser }) => {
  mkdirSync(GRAPHICS, { recursive: true })
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 500 } })).newPage()
  for (const lang of ['en', 'sv'] as const) {
    await page.goto(`${pathToFileURL(join(PLAY, 'feature-graphic.html')).href}?lang=${lang}`)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: join(GRAPHICS, `feature-graphic-${lang}.png`) })
  }
  await page.setViewportSize({ width: 512, height: 512 })
  await page.goto(pathToFileURL(join(PLAY, 'icon.html')).href)
  await expect(page.locator('img')).toHaveJSProperty('complete', true)
  await page.screenshot({ path: join(GRAPHICS, 'icon-512.png') })
  await page.context().close()
})

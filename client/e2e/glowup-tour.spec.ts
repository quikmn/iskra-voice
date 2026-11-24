// Design tour: the main screens with demo content, shot at desktop sizes (and a few at phone width) in the default
// dark theme and the light one, for comparing the look before and after a visual change.
// Not part of the normal run:
//   cd server; dotnet build src/Iskra.Server
//   cd client; $env:GLOWUP_TAG='after'; $env:ISKRA_E2E_PORT=5395; npx playwright test e2e/glowup-tour.spec.ts
// Output: <GLOWUP_OUT or e2e/screenshots/glowup>/<tag>-<screen>-<dark|light|theme id>.png. Everyone in them is made up.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { BUILT_IN_THEMES } from '../src/theme/themes'
import { composerAction, createInviteLink, hasLiveKit, joinVia, openServerSettings, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

const TAG = process.env.GLOWUP_TAG
test.skip(!TAG, 'Design tour: set GLOWUP_TAG=before or after')
test.use({ actionTimeout: 8000 })

const OUT = process.env.GLOWUP_OUT || join(SHOTS, 'glowup')
const DESKTOP = { width: 1280, height: 800 }
const LARGE = { width: 1920, height: 1080 }
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
const SCHEMES = [['iskra', 'dark'], ['daylight', 'light']] as const

const problems: string[] = []
const pages: Page[] = []

/** Runs one part of the tour; a failure is noted, open dialogs are closed, and the tour goes on. */
async function part(name: string, fn: () => Promise<void>) {
  try {
    await fn()
  } catch (e) {
    problems.push(`${name}: ${(e as Error).message.split('\n').filter((l) => l.trim() && !l.includes('Call log')).slice(0, 3).join(' | ')}`)
    for (const page of pages) {
      if (page.isClosed()) continue
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => undefined)
    }
  }
}

/** Switches the theme in place, through the app's own theme module (the dev server shares the instance). */
async function setTheme(page: Page, id: string) {
  await page.evaluate(async (themeId) => {
    const path = '/src/theme/theme.ts'
    const m = (await import(/* @vite-ignore */ path)) as { chooseTheme(choice: { id: string }): void }
    m.chooseTheme({ id: themeId })
  }, id)
}

/** One screenshot per scheme (dark, light), or only the themes given. */
async function shot(page: Page, name: string, themes: readonly (readonly [string, string])[] = SCHEMES) {
  for (const [id, label] of themes) {
    await setTheme(page, id)
    await page.waitForTimeout(250) // let transitions settle
    await page.screenshot({ path: join(OUT, `${TAG}-${name}-${label}.png`), animations: 'disabled' })
  }
  await setTheme(page, 'iskra')
}

/** A picture to attach: a gradient with a few shapes, drawn in the page. */
async function picture(page: Page, width = 960, height = 540): Promise<Buffer> {
  const url = await page.evaluate(([w, h]) => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const g = canvas.getContext('2d')!
    const sky = g.createLinearGradient(0, 0, w, h)
    sky.addColorStop(0, '#1b1b4d'); sky.addColorStop(0.55, '#6a4bd8'); sky.addColorStop(1, '#f59e6c')
    g.fillStyle = sky
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#ffe7b0'
    g.beginPath(); g.arc(w * 0.72, h * 0.42, h * 0.14, 0, Math.PI * 2); g.fill()
    g.fillStyle = '#15153a'
    g.beginPath(); g.moveTo(0, h); g.lineTo(w * 0.25, h * 0.5); g.lineTo(w * 0.45, h * 0.78); g.lineTo(w * 0.62, h * 0.56); g.lineTo(w, h * 0.9); g.lineTo(w, h); g.fill()
    return canvas.toDataURL('image/png')
  }, [width, height] as const)
  return Buffer.from(url.split(',')[1], 'base64')
}

async function friend(browser: Browser, invite: string, name: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: DESKTOP })).newPage()
  pages.push(page)
  await joinVia(page, invite, name)
  return page
}

async function createChannel(page: Page, button: string, name: string, kind?: string) {
  await page.getByRole('button', { name: button, exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Create channel' })
  if (kind) await dialog.getByRole('radio', { name: kind, exact: true }).click()
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog).toBeHidden()
}

let server: TestServer
test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true })
  server = await startServer('Game Night', hasLiveKit())
})
test.afterAll(async () => {
  writeFileSync(join(OUT, `${TAG}-problems.json`), JSON.stringify(problems, null, 2))
  await server?.stop()
})

test('design tour', async ({ browser }) => {
  test.setTimeout(900_000)
  const host = await (await browser.newContext({ viewport: DESKTOP })).newPage()
  pages.push(host)
  await joinVia(host, server.ownerLink(), 'Maja')
  await host.locator('.nudge').getByRole('button', { name: 'Later' }).click().catch(() => undefined)
  const invite = await createInviteLink(host)
  const alex = await friend(browser, invite, 'Alex')
  const sam = await friend(browser, invite, 'Sam')
  const noor = await friend(browser, invite, 'Noor')

  // ── Channels: categories, more channels, a voice channel ──
  await part('channels', async () => {
    await host.getByRole('button', { name: 'Create category' }).click()
    await host.getByRole('dialog', { name: 'Create category' }).getByLabel('Name').fill('Games')
    await host.getByRole('button', { name: 'Create', exact: true }).click()
    await createChannel(host, 'Create channel in Games', 'valheim')
    await createChannel(host, 'Create channel in Games', 'screenshots')
    await createChannel(host, 'Create channel in Games', 'patch-notes')
    await host.locator('.channel', { hasText: 'general' }).first().click()
  })

  // ── Chat: a conversation with a reply, a reaction, a mention, a link, code and a picture ──
  await part('chat', async () => {
    await send(alex, "Who's in for Valheim on Friday? 🛡️")
    await send(sam, "Me! I'll bring the mead 🍺")
    await send(noor, 'Count me in. Starting at 8?')
    await send(host, "8 works. I'll have the server up, the world is called **Ashlands** 🔥")
    await send(host, '```\nserver: ashlands\nport: 2456\n```')
    await send(alex, 'Patch notes are out https://example.com/patch-notes and the new biome looks wild')
    await send(sam, '@Maja can you pin the server address?')
    await expect(host.locator('.message-text', { hasText: 'pin the server address' })).toBeVisible()
    await host.locator('input[type=file]').first().setInputFiles({ name: 'ashlands-base.png', mimeType: 'image/png', buffer: await picture(host) })
    await host.getByPlaceholder('Message #general').fill('The base so far')
    await host.waitForTimeout(600)
    await shot(host, '03-composer-attachment')
    await host.getByPlaceholder('Message #general').press('Enter')
    await expect(host.locator('.attachment-image img')).toBeVisible({ timeout: 15_000 })
    const mead = sam.locator('.message', { hasText: 'Ashlands' }).first()
    await mead.hover()
    await mead.getByRole('button', { name: 'Add reaction' }).click()
    await sam.locator('.reaction-picker button').first().click()
    const mine = noor.locator('.message', { hasText: 'Ashlands' }).first()
    await mine.locator('.reaction').first().click()
    // Unread and a mention in other channels.
    await alex.locator('.channel', { hasText: 'valheim' }).click()
    await alex.getByPlaceholder('Message #valheim').fill('Boss fight at 9, @Maja bring the good bow')
    await alex.getByPlaceholder('Message #valheim').press('Enter')
    await sam.locator('.channel', { hasText: 'screenshots' }).click()
    await sam.getByPlaceholder('Message #screenshots').fill('New base tour coming tonight')
    await sam.getByPlaceholder('Message #screenshots').press('Enter')
    await host.waitForTimeout(800)
    await host.mouse.move(700, 20)
    await shot(host, '01-chat')
    const msg = host.locator('.message', { hasText: 'Count me in' }).first()
    await msg.hover()
    await shot(host, '02-chat-message-hover')
    await host.locator('.channel', { hasText: 'patch-notes' }).hover()
    await shot(host, '02-channel-row-hover', SCHEMES.slice(0, 1))
  })

  await part('large window', async () => {
    await host.setViewportSize(LARGE)
    await host.mouse.move(900, 20)
    await shot(host, '01-chat-1920')
    await host.setViewportSize(DESKTOP)
  })

  // ── Composer: reply bar, emoji picker, the "+" menu ──
  await part('composer', async () => {
    const msg = host.locator('.message', { hasText: 'bring the mead' }).first()
    await msg.hover()
    await msg.getByRole('button', { name: 'Reply' }).click()
    await host.getByPlaceholder('Message #general').fill('Bring two, Noor is thirsty')
    await shot(host, '04-composer-reply')
    await host.getByPlaceholder('Message #general').press('Enter')
    await composerAction(host, 'Emoji')
    await host.waitForTimeout(500)
    await shot(host, '05-emoji-picker')
    await host.keyboard.press('Escape')
    await host.locator('.composer').getByRole('button', { name: 'Add to your message' }).click()
    await shot(host, '06-composer-menu')
    await host.keyboard.press('Escape')
  })

  // ── Menus: the server menu, a channel's menu, a message's menu, a member's menu ──
  await part('menus', async () => {
    await host.locator('.server-header-button').click()
    await shot(host, '07-server-menu')
    await host.keyboard.press('Escape')
    await host.locator('.channel', { hasText: 'valheim' }).click({ button: 'right' })
    await shot(host, '08-channel-context-menu')
    await host.keyboard.press('Escape')
    await host.locator('.member-list').getByRole('button', { name: /Noor/ }).click({ button: 'right' })
    await shot(host, '09-member-context-menu')
    await host.keyboard.press('Escape')
    const msg = host.locator('.message', { hasText: 'Count me in' }).first()
    await msg.hover()
    await msg.getByRole('button', { name: /^More/ }).click()
    await shot(host, '10-message-menu')
    await host.keyboard.press('Escape')
  })

  await part('profile card', async () => {
    await host.locator('.member-list').getByRole('button', { name: /Noor/ }).click()
    await host.waitForTimeout(400)
    await shot(host, '11-profile-card')
    await host.keyboard.press('Escape')
  })

  // ── Dialogs ──
  await part('dialogs', async () => {
    await host.getByRole('button', { name: 'Create channel in Games', exact: true }).first().click()
    await host.getByRole('dialog', { name: 'Create channel' }).getByLabel('Name').fill('raid-planning')
    await shot(host, '12-dialog-create-channel')
    await host.keyboard.press('Escape')
    await host.getByRole('button', { name: 'Invite friends' }).first().click()
    await expect(host.locator('.copy-row input')).toHaveValue(/#\/join\//)
    await shot(host, '13-dialog-invite')
    await host.keyboard.press('Escape')
    await host.keyboard.press('Control+k')
    await host.keyboard.type('val')
    await shot(host, '14-quick-switcher')
    await host.keyboard.press('Escape')
    await composerAction(host, 'Create a poll')
    const poll = host.getByRole('dialog', { name: 'Create a poll' })
    await poll.getByLabel('Question').fill('What do we play after?')
    await poll.getByRole('textbox', { name: 'Answer 1' }).fill('Lethal Company')
    await poll.getByRole('textbox', { name: 'Answer 2' }).fill('Deep Rock Galactic')
    await poll.getByRole('button', { name: 'Post poll' }).click()
    await expect(host.locator('.poll')).toBeVisible()
    await host.mouse.move(700, 20)
    await shot(host, '15-chat-poll')
  })

  // ── My settings ──
  await part('my settings', async () => {
    await openSettings(host)
    await shot(host, '20-settings-profile')
    const nav = host.getByRole('dialog', { name: 'Settings' }).getByRole('navigation', { name: 'Settings sections' })
    for (const [section, file] of [['Appearance', '21-settings-appearance'], ['Notifications', '22-settings-notifications'], ['Voice & audio', '23-settings-voice']] as const) {
      await nav.getByRole('button', { name: section, exact: true }).click()
      await host.waitForTimeout(300)
      await shot(host, file)
    }
    await host.setViewportSize(LARGE)
    await shot(host, '23-settings-voice-1920', SCHEMES.slice(0, 1))
    await host.setViewportSize(DESKTOP)
    await host.keyboard.press('Escape')
  })

  // ── Server settings ──
  await part('server settings', async () => {
    const room = await openServerSettings(host)
    await shot(host, '30-server-settings-overview')
    const nav = room.getByRole('navigation', { name: 'Settings sections' })
    for (const [section, file] of [['Roles', '31-server-settings-roles'], ['Members', '32-server-settings-members'], ['Channels', '33-server-settings-channels']] as const) {
      await nav.getByRole('button', { name: section, exact: true }).click()
      await host.waitForTimeout(300)
      await shot(host, file)
    }
    await host.keyboard.press('Escape')
  })

  // ── Home: friends and a DM ──
  await part('home and DMs', async () => {
    await noor.locator('.member-list').getByRole('button', { name: /Maja/ }).click()
    await noor.getByRole('button', { name: 'Add friend' }).click()
    await noor.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
    const noorBox = noor.getByPlaceholder('Message Maja')
    await noorBox.fill('Hey! Are you bringing the boat on Friday?')
    await noorBox.press('Enter')
    await host.getByRole('button', { name: 'Direct messages' }).click()
    await host.locator('.dm-row', { hasText: 'Noor' }).click()
    await host.getByRole('button', { name: /^Accept( friend request)?$/ }).first().click()
    const box = host.getByPlaceholder('Message Noor')
    await box.fill('Of course, it’s ready to sail ⛵')
    await box.press('Enter')
    await noorBox.fill('You’re the best 🙌')
    await noorBox.press('Enter')
    await expect(host.locator('.message-text', { hasText: 'the best' })).toBeVisible()
    await host.mouse.move(700, 20)
    await shot(host, '40-dm')
    await host.getByRole('button', { name: 'Friends', exact: true }).first().click()
    await host.waitForTimeout(300)
    await shot(host, '41-friends')
    await host.locator('.server-icon[title="Game Night"]').click()
    await host.locator('.channel', { hasText: 'general' }).first().click()
  })

  // ── Voice: a voice channel with people in it, the call screen, the voice bar ──
  if (hasLiveKit()) {
    await part('voice', async () => {
      await createChannel(host, 'Create channel in Games', 'lounge', 'Voice')
      const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })
      for (const page of [alex, sam, noor]) {
        await page.locator('.server-icon[title="Game Night"]').click()
        await lounge(page).getByRole('button').first().click()
        await expect(page.locator('.stage')).toBeVisible({ timeout: 20_000 })
      }
      await host.waitForTimeout(1500)
      await shot(host, '50-voice-channel-with-people')
      await lounge(host).getByRole('button').first().click()
      await expect(host.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
      await host.waitForTimeout(1500)
      await host.mouse.move(700, 300)
      await shot(host, '51-call-tiles')
      await alex.locator('.call-controls').getByRole('button', { name: 'Turn camera on' }).click()
      await sam.locator('.call-controls').getByRole('button', { name: 'Turn camera on' }).click()
      await expect(host.locator('.video-tile.camera video').first()).toBeVisible({ timeout: 20_000 })
      await host.waitForTimeout(1500)
      await shot(host, '52-call-video')
      await host.setViewportSize(LARGE)
      await shot(host, '52-call-video-1920', SCHEMES.slice(0, 1))
      await host.setViewportSize(DESKTOP)
      await host.locator('.call-controls').getByRole('button', { name: 'More', exact: true }).click()
      await shot(host, '53-call-controls-more')
      await host.keyboard.press('Escape')
      await host.locator('.channel', { hasText: 'general' }).first().click()
      await host.mouse.move(700, 20)
      await shot(host, '54-voice-bar')
    })
  }

  // ── Every theme: the chat screen ──
  await part('themes', async () => {
    await host.locator('.channel', { hasText: 'general' }).first().click()
    await host.locator('.message', { hasText: 'Count me in' }).first().hover()
    for (const { id } of BUILT_IN_THEMES) await shot(host, '90-theme', [[id, id]])
    await openSettings(host, 'Appearance')
    for (const id of ['midnight', 'catppuccin', 'nord', 'synthwave', 'cyberlime']) await shot(host, '91-theme-settings', [[id, id]])
    await host.keyboard.press('Escape')
  })

  // ── Phone: chat, the drawer, settings, a dialog, the call ──
  await part('phone', async () => {
    const phone = await (await browser.newContext(PHONE)).newPage()
    pages.push(phone)
    await joinVia(phone, invite, 'Kim')
    await phone.locator('.nudge').getByRole('button', { name: 'Later' }).click().catch(() => undefined)
    await shot(phone, '60-phone-chat')
    await phone.getByRole('button', { name: /^Open (channels|menu)$/ }).first().click()
    await shot(phone, '61-phone-drawer')
    await phone.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true }).click()
    await shot(phone, '62-phone-settings')
    await phone.getByRole('dialog', { name: 'Settings' }).getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click()
    await shot(phone, '63-phone-settings-appearance')
    await phone.keyboard.press('Escape')
    await phone.keyboard.press('Escape')
    await phone.keyboard.press('Escape')
    const msg = phone.locator('.message', { hasText: 'Count me in' }).first()
    const box = (await msg.boundingBox())!
    const at = { pointerType: 'touch', isPrimary: true, button: 0, clientX: box.x + 40, clientY: box.y + 12 }
    await msg.dispatchEvent('pointerdown', at)
    await phone.waitForTimeout(600)
    await msg.dispatchEvent('pointerup', at)
    await shot(phone, '64-phone-message-sheet')
    await phone.keyboard.press('Escape')
    if (hasLiveKit()) {
      await phone.getByRole('button', { name: /^Open (channels|menu)$/ }).first().click()
      await phone.locator('.voice-channel', { hasText: 'lounge' }).getByRole('button').first().click()
      await expect(phone.locator('.stage')).toBeVisible({ timeout: 20_000 })
      await phone.waitForTimeout(1500)
      await shot(phone, '65-phone-call')
    }
  })

  // ── First run ──
  await part('onboarding', async () => {
    const page = await (await browser.newContext({ viewport: DESKTOP })).newPage()
    pages.push(page)
    await page.goto(invite)
    await expect(page.getByText("You've been invited")).toBeVisible()
    await shot(page, '70-onboarding')
  })

  if (problems.length) console.log(`Design tour problems:\n${problems.join('\n')}`)
})

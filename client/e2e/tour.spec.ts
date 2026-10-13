// A screenshot tour of every screen and state, at desktop and phone sizes, for reviewing the UI as a whole.
// Not part of the normal run: `ISKRA_TOUR=1 npx playwright test e2e/tour.spec.ts` (screenshots in e2e/screenshots/tour).
// Optional: ISKRA_TOUR_THEME=<theme id> or ISKRA_TOUR_THEME=light to shoot everything in another theme.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Bot } from '../../bots/sdk/src/index'
import { agreeToTerms, createInviteLink, hasLiveKit, joinVia, longPress, send, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!process.env.ISKRA_TOUR, 'screenshot tour: set ISKRA_TOUR=1')
test.use({ actionTimeout: 8000 })

const THEME = process.env.ISKRA_TOUR_THEME ?? ''
const OUT = join(SHOTS, 'tour', THEME || 'default')
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
const SMALL_PHONE = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true }

const LIGHT = {
  meta: { name: 'Daylight', scheme: 'light' },
  colors: {
    bgSurface: '#e9e9f2', bgDeep: '#f4f4f9', bgBody: '#ececf4', bgFloat: '#ffffff', bgSidebar: '#f0f0f6', bgSidebarHover: '#e4e4ee',
    bgChat: '#ffffff', bgHover: '#dcdce8', bgButton: '#ececf3', bgBorder: 'rgba(40,40,90,0.14)', bgActive: '#dedeea',
    textHeading: '#11111c', textNormal: '#22222e', textMuted: '#4a4a5c', textSubtle: '#6b6b80', textFaint: '#a0a0b4',
    accent: '#5b4cf0', accentHover: '#4a3bd9', success: '#15803d', successHover: '#166534', danger: '#dc2626', dangerHover: '#b91c1c',
    warning: '#b45309', link: '#0369a1', mentionText: '#3b2fc0',
  },
  radius: 10,
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=', 'base64')
function wav(ms: number): Buffer {
  const samples = 8 * ms
  const b = Buffer.alloc(44 + samples)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28)
  b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(samples, 40)
  for (let i = 0; i < samples; i++) b[44 + i] = 128 + Math.round(60 * Math.sin(i / 4))
  return b
}

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

async function shot(page: Page, name: string) {
  await page.waitForTimeout(250) // let transitions settle
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' })
}

async function context(browser: Browser, options: Parameters<Browser['newContext']>[0] = { viewport: DESKTOP }): Promise<BrowserContext> {
  const ctx = await browser.newContext(options)
  ctx.on('page', (page) => pages.push(page))
  if (THEME) {
    const choice = THEME === 'light' ? { custom: LIGHT } : { id: THEME }
    await ctx.addInitScript((value) => localStorage.setItem('iskra.theme', value), JSON.stringify(choice))
  }
  return ctx
}

/** Opens Settings (from the drawer on phones) and, if given, a section. */
async function settings(page: Page, section?: string) {
  const drawer = page.getByRole('button', { name: /Open (channels|menu)/ }).first()
  if (await drawer.isVisible()) await drawer.click()
  await page.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  if (section) await dialog.getByRole('button', { name: section, exact: true }).click({ timeout: 2000 }).catch(() => undefined)
}

/** The server room of the server you're looking at (its name above the channels → Server settings). */
async function serverSettings(page: Page, section?: string) {
  const drawer = page.getByRole('button', { name: /Open (channels|menu)/ }).first()
  if (await drawer.isVisible()) await drawer.click()
  await page.locator('.server-header-button').click()
  await page.getByRole('menuitem', { name: 'Server settings', exact: true }).click()
  const room = page.getByRole('dialog', { name: /· Server settings$/ })
  await expect(room).toBeVisible()
  if (section) await room.getByRole('button', { name: section, exact: true }).click({ timeout: 2000 }).catch(() => undefined)
}

let server: TestServer
let offline: TestServer | null
let botDir: string
let bot: Bot | null = null
test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true })
  server = await startServer('Game Night', hasLiveKit(), { Calls__RingTimeoutMs: '60000' })
  offline = await startServer('Weekend Crew')
  botDir = mkdtempSync(join(tmpdir(), 'iskra-tour-bot-'))
})
test.afterAll(async () => {
  test.setTimeout(180_000)
  bot?.stop()
  await server?.stop()
  await offline?.stop()
  rmSync(botDir, { recursive: true, force: true })
  if (problems.length) console.log(`Tour problems:\n  ${problems.join('\n  ')}`)
})

test('screenshot tour', async ({ browser }) => {
  test.setTimeout(600_000)

  // ── Onboarding ──
  const fresh = await (await context(browser)).newPage()
  const freshPhone = await (await context(browser, PHONE)).newPage()
  for (const [page, size] of [[fresh, 'desktop'], [freshPhone, 'phone']] as const) {
    await part(`onboarding ${size}`, async () => {
      await page.goto('/')
      await expect(page.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible()
      await shot(page, `01-onboarding-${size}`)
      await agreeToTerms(page)
      await page.getByRole('button', { name: /I already use Iskra/ }).click()
      await shot(page, `02-onboarding-existing-${size}`)
      await page.getByRole('button', { name: /Link with my other device/ }).click()
      await shot(page, `03-onboarding-link-${size}`)
      await page.getByRole('button', { name: 'Back' }).click()
      await page.getByRole('button', { name: /Use my recovery key/ }).click()
      await page.getByLabel('Recovery key').fill('ISKRA-NOPE-NOPE-NOPE-NOPE-NOPE-NOPE')
      await shot(page, `04-onboarding-recovery-${size}`)
      await page.getByRole('button', { name: 'Back' }).click()
      await page.getByRole('button', { name: "I'm new here" }).click()
      await page.getByLabel('Your name').fill('Newbie')
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByText('No servers yet')).toBeVisible()
      await shot(page, `05-empty-no-servers-${size}`)
      await page.getByRole('button', { name: /Start your own server/ }).click()
      await shot(page, `06-dialog-start-server-${size}`)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'I have an invite link' }).click()
      await page.getByLabel('Invite link').fill('not a link')
      await shot(page, `07-dialog-join-error-${size}`)
      await page.keyboard.press('Escape')
    })
  }

  // ── Desktop-only bits: Create a server and the update toast (a stand-in bridge) ──
  await part('desktop bridge', async () => {
    const ctx = await context(browser)
    await ctx.addInitScript(() => {
      const listeners: ((s: unknown) => void)[] = []
      ;(window as unknown as { iskraDesktop: unknown }).iskraDesktop = {
        platform: 'win32',
        setPushToTalkKey: async () => undefined,
        capturePushToTalkKey: async () => null,
        onPushToTalk: () => () => undefined,
        pushToTalkStatus: async () => 'ready',
        openSystemSettings: async () => undefined,
        updates: {
          status: async () => ({ state: 'ready', version: '9.9.9' }),
          onStatus: (cb: (s: unknown) => void) => { listeners.push(cb); return () => undefined },
          restart: async () => false,
        },
        onPickScreen: () => () => undefined,
        pickScreen: () => undefined,
        host: { available: async () => true, list: async () => [], create: async () => null, start: async () => null, stop: async () => null },
      }
    })
    const page = await ctx.newPage()
    await page.goto('/')
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Desk')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Update ready')).toBeVisible()
    await shot(page, '08-update-toast-empty-desktop')
    await page.getByRole('button', { name: 'Create a server' }).click()
    await shot(page, '09-dialog-create-server-desktop')
    await page.setViewportSize(PHONE.viewport)
    await shot(page, '09-dialog-create-server-phone')
    await page.keyboard.press('Escape')
    await shot(page, '08-update-toast-empty-phone')
    await ctx.close()
  })

  // ── Joining a server ──
  const host = await (await context(browser)).newPage()
  await host.goto(server.ownerLink())
  await expect(host.getByText("You've been invited")).toBeVisible()
  await shot(host, '10-onboarding-invite-desktop')
  await agreeToTerms(host)
  await host.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await host.getByLabel('Your name').fill('Viktor')
  await host.getByRole('button', { name: 'Join' }).click()
  await expect(host.getByRole('heading', { name: 'general' })).toBeVisible()
  await shot(host, '11-channel-empty-nudge-desktop')

  const phoneCtx = await context(browser, PHONE)
  const phone = await phoneCtx.newPage()
  await joinVia(phone, await createInviteLink(host), 'Alice')
  await shot(phone, '11-channel-empty-nudge-phone')
  const small = await (await context(browser, SMALL_PHONE)).newPage()
  await joinVia(small, await createInviteLink(host), 'Sam with a rather long display name')

  // ── Messages, replies, reactions, mentions, links, code ──
  await part('messages', async () => {
    await send(host, 'Welcome to **Game Night**! Who is in for Valheim on Friday?')
    await send(host, 'I set up the server, the world is called `Ashlands`.')
    await send(phone, 'me! @Viktor I can bring the mead 🍺')
    await send(small, 'Count me in. Here is the patch notes link https://example.com/patch-notes-for-the-big-update and a very long word: Supercalifragilisticexpialidocious-and-then-some-more-characters-to-overflow')
    await send(host, '```\nserver: ashlands\nport: 2456\n```')
    const msg = host.locator('.message', { hasText: 'bring the mead' }).first()
    await msg.hover()
    await msg.getByRole('button', { name: 'Reply' }).click()
    await shot(host, '12-composer-replying-desktop')
    await send(host, 'Perfect, see you there ||spoiler: there are dragons||')
    await msg.hover()
    await msg.getByRole('button', { name: 'Add reaction' }).click()
    await shot(host, '13-reaction-picker-desktop')
    await host.locator('.reaction-picker button').first().click()
    await expect(msg.locator('.reaction')).toHaveCount(1)
    await msg.hover()
    await shot(host, '14-messages-hover-actions-desktop')
    await shot(phone, '14-messages-phone')
    await shot(small, '14-messages-small-phone')
  })

  // ── Poll ──
  await part('poll', async () => {
    await host.getByRole('button', { name: 'Create a poll' }).click()
    const dialog = host.getByRole('dialog', { name: 'Create a poll' })
    await dialog.getByLabel('Question').fill('What do we play tonight?')
    await dialog.getByRole('textbox', { name: 'Answer 1' }).fill('Valheim')
    await dialog.getByRole('textbox', { name: 'Answer 2' }).fill('Lethal Company')
    await shot(host, '15-dialog-poll-desktop')
    await dialog.getByRole('button', { name: 'Post poll' }).click()
    const poll = phone.locator('.poll', { hasText: 'What do we play tonight?' })
    await poll.getByRole('radio', { name: 'Valheim' }).click()
    await poll.getByRole('button', { name: 'Vote' }).click()
    await shot(phone, '16-poll-phone')
    await shot(host, '16-poll-desktop')
  })

  // ── Custom emoji and sounds (settings) ──
  await part('emoji settings', async () => {
    await serverSettings(host, 'Emoji & stickers')
    await host.locator('input[aria-label="Emoji image"]').setInputFiles({ name: 'party.png', mimeType: 'image/png', buffer: PNG })
    await host.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(host.locator('.expression-row')).toHaveCount(1)
    await shot(host, '30-settings-emoji-desktop')
    await host.keyboard.press('Escape')
    await send(host, 'party time :party:')
  })
  await part('sound settings', async () => {
    await serverSettings(host, 'Soundboard')
    await host.locator('input[aria-label="Sound file"]').setInputFiles({ name: 'airhorn.wav', mimeType: 'audio/wav', buffer: wav(600) })
    await host.getByLabel('Sound emoji').fill('📯')
    await host.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(host.locator('.expression-row')).toHaveCount(1)
    await shot(host, '31-settings-sounds-desktop')
    await host.keyboard.press('Escape')
  })

  // ── Webhooks and a bot ──
  let botInvite = ''
  await part('integrations', async () => {
    await host.getByRole('button', { name: /server options/ }).click()
    await host.getByRole('menuitem', { name: 'Server settings' }).click()
    await shot(host, '29-settings-server-overview-desktop')
    await host.getByRole('dialog', { name: /· Server settings$/ }).getByRole('button', { name: 'Bots & webhooks' }).click()
    await host.getByLabel('Name').fill('Deploys')
    await host.getByRole('button', { name: 'Create webhook' }).click()
    const urlBox = host.getByLabel('Webhook URL')
    await expect(urlBox).toHaveValue(/\/hooks\//)
    const hookUrl = await urlBox.inputValue()
    await shot(host, '32-settings-webhooks-desktop')
    await fetch(hookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Build **passed**',
        embeds: [{ title: 'v1.4.2 is live', url: 'https://example.com/changelog', description: '3 fixes, 1 new map', color: 0x57f287,
          fields: [{ name: 'Region', value: 'EU', inline: true }, { name: 'Players', value: '12', inline: true }], footer: { text: 'deploy #812' } }],
      }),
    })
    await host.getByRole('tab', { name: 'Bots' }).click()
    await host.getByRole('button', { name: 'Create bot invite' }).click()
    botInvite = await host.getByLabel('Bot invite link').inputValue()
    await shot(host, '33-settings-bots-desktop')
    await host.keyboard.press('Escape')
    bot = new Bot({ name: 'Dice', invite: botInvite, stateFile: join(botDir, 'dice.bot.json'), log: () => undefined })
    bot.command('roll', 'Rolls dice', async ({ reply }) => void (await reply('Viktor rolled **4**')))
    await bot.start()
    await send(host, '/roll d6')
    await expect(host.locator('.message', { hasText: 'Viktor rolled' })).toBeVisible()
    await shot(host, '17-webhook-bot-desktop')
    await shot(phone, '17-webhook-bot-phone')
  })

  // ── Pins, threads, search ──
  await part('pins threads search', async () => {
    const welcome = host.locator('.message', { hasText: 'Welcome to' })
    await welcome.hover()
    await welcome.getByRole('button', { name: 'Pin message' }).click()
    await host.getByRole('button', { name: 'Pinned messages' }).click()
    await shot(host, '18-pins-popover-desktop')
    await host.keyboard.press('Escape')
    await host.getByRole('button', { name: 'Threads' }).click()
    await shot(host, '19-threads-empty-desktop')
    await host.keyboard.press('Escape')
    const mead = host.locator('.message', { hasText: 'bring the mead' }).first()
    await mead.hover()
    await mead.getByRole('button', { name: 'Start a thread' }).click()
    await shot(host, '20-dialog-thread-desktop')
    await host.getByRole('button', { name: 'Create thread' }).click()
    const reply = host.locator('.thread-panel').getByPlaceholder(/Reply in/)
    await reply.fill('I will bring the flour too')
    await reply.press('Enter')
    await shot(host, '21-thread-panel-desktop')
    await host.locator('.thread-panel').getByRole('button', { name: 'Close thread' }).click()
    const box = host.getByRole('searchbox', { name: 'Search messages' }).first()
    await box.click()
    await host.keyboard.press('Enter')
    await shot(host, '22-search-help-desktop')
    await box.fill('valheim')
    await box.press('Enter')
    await expect(host.locator('.search-panel .result-card').first()).toBeVisible()
    await shot(host, '23-search-results-desktop')
    await box.fill('zzzznothing')
    await box.press('Enter')
    await shot(host, '24-search-empty-desktop')
    await host.locator('.search-panel').getByRole('button', { name: 'Close search' }).last().click()

    await phone.locator('.thread-summary').first().click()
    await shot(phone, '21-thread-panel-phone')
    await phone.locator('.thread-panel').getByRole('button', { name: 'Back to channel' }).click()
    await phone.getByRole('button', { name: 'Pinned messages' }).click()
    await shot(phone, '18-pins-popover-phone')
    await phone.keyboard.press('Escape')
    await phone.locator('.mobile-search').click()
    const mbox = phone.locator('.search-panel').getByRole('searchbox', { name: 'Search messages' })
    await mbox.fill('mead')
    await mbox.press('Enter')
    await shot(phone, '23-search-results-phone')
    await phone.locator('.search-panel').getByRole('button', { name: 'Close search' }).first().click()
  })

  // ── Message actions on a phone (long press) ──
  await part('touch actions', async () => {
    const msg = phone.locator('.message', { hasText: 'Welcome to' })
    await longPress(phone, msg.locator('.message-body'))
    await shot(phone, '25-message-actions-phone')
    await phone.keyboard.press('Escape')
  })

  // ── Members, profile card ──
  await part('members and profile', async () => {
    await host.locator('.member-list').getByRole('button', { name: /Alice/ }).click()
    await shot(host, '26-profile-card-desktop')
    await host.getByRole('button', { name: 'More' }).click()
    await shot(host, '27-dialog-member-desktop')
    await host.keyboard.press('Escape')
    await phone.getByRole('button', { name: 'Members' }).first().click()
    await shot(phone, '28-member-drawer-phone')
    await phone.locator('.member-list').getByRole('button', { name: /Viktor/ }).click()
    await shot(phone, '26-profile-card-phone')
    await phone.keyboard.press('Escape') // the card
    await phone.keyboard.press('Escape') // the member drawer
  })

  // ── Settings, every section ──
  await part('settings', async () => {
    await settings(host)
    await shot(host, '40-settings-profile-desktop')
    for (const [section, file] of [
      ['Appearance', '41-settings-appearance'], ['Devices', '42-settings-devices'], ['Recovery key', '43-settings-recovery'],
      ['Notifications', '44-settings-notifications'], ['Voice & audio', '45-settings-voice'],
    ] as const) {
      await part(`settings ${section}`, async () => {
        await host.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: section, exact: true }).click()
        await shot(host, `${file}-desktop`)
      })
    }
    await part('link device dialog', async () => {
      await host.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Devices', exact: true }).click()
      await host.getByRole('button', { name: 'Link a device' }).click()
      await shot(host, '49-dialog-link-device-desktop')
      await host.getByRole('button', { name: 'Show code' }).click()
      await expect(host.getByTestId('link-code')).toBeVisible()
      await shot(host, '49-dialog-link-code-desktop')
      await host.keyboard.press('Escape')
      await expect(host.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    })
    await host.keyboard.press('Escape')

    // The server room: only the server's own settings, under its band.
    await serverSettings(host)
    for (const [section, file] of [
      ['Overview', '46-settings-server-overview'], ['Profile pages', '47-settings-profile-pages'], ['Internet access', '48-settings-internet'],
      ['Members', '50-settings-members'], ['Channels', '51-settings-channels'],
    ] as const) {
      await part(`server settings ${section}`, async () => {
        await host.getByRole('dialog', { name: /· Server settings$/ }).getByRole('button', { name: section, exact: true }).click()
        await shot(host, `${file}-desktop`)
      })
    }
    await host.keyboard.press('Escape')

    await settings(phone)
    await shot(phone, '40-settings-list-phone')
    for (const [section, file] of [['Profile', '40-settings-profile'], ['Appearance', '41-settings-appearance'], ['Devices', '42-settings-devices'], ['Voice & audio', '45-settings-voice'], ['Notifications', '44-settings-notifications']] as const) {
      await part(`phone settings ${section}`, async () => {
        await phone.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: section, exact: true }).click()
        await shot(phone, `${file}-phone`)
        await phone.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Back' }).click()
      })
    }
    await phone.keyboard.press('Escape') // settings
    await phone.keyboard.press('Escape') // the drawer it was opened from
  })

  // ── Dialogs: invite, create channel, page editor, recovery nudge ──
  await part('dialogs', async () => {
    await host.getByRole('button', { name: 'Invite friends' }).click()
    await expect(host.locator('.copy-row input')).toHaveValue(/#\/join\//)
    await shot(host, '50-dialog-invite-desktop')
    await host.keyboard.press('Escape')
    await host.getByRole('button', { name: 'Create channel' }).first().click()
    await shot(host, '51-dialog-create-channel-desktop')
    await host.keyboard.press('Escape')
    await host.locator('.nudge').getByRole('button', { name: 'Save it' }).click()
    await shot(host, '52-dialog-recovery-desktop')
    await host.keyboard.press('Escape')
    await settings(host, 'Profile')
    await host.getByRole('button', { name: 'Make a page' }).click()
    await shot(host, '53-dialog-page-editor-desktop')
    await host.keyboard.press('Escape')
    await host.locator('input[aria-label="Profile picture"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG })
    await shot(host, '54-dialog-avatar-cropper-desktop')
    await host.keyboard.press('Escape')
    await host.keyboard.press('Escape')
    await send(host, 'look at this')
    await host.locator('input[type=file]').first().setInputFiles({ name: 'map.png', mimeType: 'image/png', buffer: PNG })
    await shot(host, '55-composer-upload-desktop')
    await host.getByPlaceholder('Message #general').press('Enter')
  })

  // ── Quick switcher ──
  await part('quick switcher', async () => {
    await host.keyboard.press('Control+k')
    await shot(host, '56-quick-switcher-desktop')
    await host.keyboard.press('Escape')
  })

  // ── Voice channel and the soundboard ──
  if (hasLiveKit()) {
    await part('voice', async () => {
      await host.getByRole('button', { name: 'Create voice channel' }).click()
      await host.getByRole('radio', { name: 'Voice' }).click()
      await host.getByLabel('Name').fill('lounge')
      await host.getByRole('button', { name: 'Create', exact: true }).click()
      const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })
      await lounge(host).getByRole('button').first().click()
      await expect(host.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
      await phone.getByRole('button', { name: 'Open channels' }).first().click()
      await lounge(phone).getByRole('button').first().click()
      await expect(phone.locator('.call-controls')).toBeVisible()
      await shot(host, '60-voice-stage-desktop')
      await shot(phone, '60-voice-stage-phone')
      await host.locator('.call-controls').getByRole('button', { name: 'Soundboard' }).click()
      await shot(host, '61-soundboard-desktop')
      await host.getByRole('dialog', { name: 'Soundboard' }).getByRole('button', { name: /airhorn/ }).click()
      await phone.locator('.call-controls').getByRole('button', { name: 'Soundboard' }).click()
      await shot(phone, '61-soundboard-phone')
      await phone.keyboard.press('Escape')
      await host.keyboard.press('Escape')
      await expect(phone.locator('.sound-toast')).toBeVisible()
      await shot(phone, '62-sound-toast-phone')
      await host.locator('.channel', { hasText: 'general' }).click()
      await shot(host, '63-voice-bar-desktop')
      await host.locator('.voice-controls').getByRole('button', { name: 'Leave voice' }).click()
      await phone.locator('.call-controls').getByRole('button', { name: /Leave|Hang up/ }).first().click()
    })
  }

  // ── Friends, DMs, calls ──
  await part('dm', async () => {
    await host.locator('.member-list').getByRole('button', { name: /Alice/ }).click()
    await host.getByRole('button', { name: 'Add friend' }).click()
    await host.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
    const box = host.getByPlaceholder('Message Alice')
    await box.fill('hey, call later?')
    await box.press('Enter')
    await shot(host, '70-dm-desktop')
    await host.getByRole('button', { name: 'Verify' }).click()
    await shot(host, '71-dialog-safety-number-desktop')
    await host.keyboard.press('Escape')
    await host.getByRole('button', { name: 'Direct messages' }).click()
    await host.locator('.channel', { hasText: 'Friends' }).click()
    await shot(host, '72-friends-desktop')
    await phone.getByRole('button', { name: 'Open channels' }).first().click()
    await phone.getByRole('button', { name: 'Direct messages' }).click()
    await phone.getByRole('button', { name: 'Open menu' }).first().click()
    await shot(phone, '72-dm-list-phone')
    await phone.locator('.dm-row', { hasText: 'Viktor' }).click()
    await shot(phone, '70-dm-phone')
  })
  if (hasLiveKit()) {
    await part('calls', async () => {
      await host.locator('.dm-row', { hasText: 'Alice' }).click()
      await host.getByRole('button', { name: 'Start voice call' }).click()
      await expect(phone.getByRole('alertdialog')).toBeVisible()
      await shot(phone, '73-incoming-call-phone')
      await shot(host, '74-calling-desktop')
      await phone.getByRole('alertdialog').getByRole('button', { name: 'Accept' }).click()
      await expect(host.locator('.call-panel .call-status')).toHaveText(/^\d+:\d\d$/, { timeout: 20_000 })
      await shot(host, '75-in-call-dm-desktop')
      await shot(phone, '75-in-call-dm-phone')
      await host.locator('.call-panel').getByRole('button', { name: 'Hang up' }).click()
    })
    await part('incoming on desktop', async () => {
      await phone.getByRole('button', { name: 'Start voice call' }).click()
      await expect(host.getByRole('alertdialog')).toBeVisible()
      await shot(host, '73-incoming-call-desktop')
      await host.getByRole('alertdialog').getByRole('button', { name: 'Decline' }).click()
    })
  }

  // ── Offline and rejected ──
  await part('offline', async () => {
    const page = await (await context(browser)).newPage()
    await joinVia(page, offline!.ownerLink(), 'Owner')
    await send(page, 'see you all later')
    const other = await (await context(browser, PHONE)).newPage()
    await joinVia(other, await createInviteLink(page), 'Guest')
    await offline!.stop()
    offline = null
    await expect(page.locator('.pill')).toBeVisible({ timeout: 15_000 })
    await shot(page, '80-offline-desktop')
    await shot(other, '80-offline-phone')
    await other.getByRole('button', { name: 'Open channels' }).first().click()
    await shot(other, '81-offline-drawer-phone')
  })

  // ── Themes ──
  await part('themes', async () => {
    for (const id of ['cyberlime', 'solarized', 'synthwave']) {
      await host.evaluate((v) => localStorage.setItem('iskra.theme', v), JSON.stringify({ id }))
      await host.reload()
      await host.getByRole('button', { name: /Game Night|GN/ }).first().click().catch(() => undefined)
      await expect(host.getByRole('heading', { name: 'general' })).toBeVisible()
      await shot(host, `90-theme-${id}-desktop`)
      await settings(host, 'Appearance')
      await shot(host, `91-theme-${id}-settings-desktop`)
      await host.keyboard.press('Escape')
    }
    await host.evaluate((v) => localStorage.setItem('iskra.theme', v), JSON.stringify({ custom: LIGHT }))
    await host.reload()
    await host.getByRole('button', { name: /Game Night|GN/ }).first().click().catch(() => undefined)
    await expect(host.getByRole('heading', { name: 'general' })).toBeVisible()
    await shot(host, '90-theme-light-desktop')
    await settings(host, 'Appearance')
    await shot(host, '91-theme-light-settings-desktop')
  })

  expect(problems, problems.join('\n')).toEqual([])
})

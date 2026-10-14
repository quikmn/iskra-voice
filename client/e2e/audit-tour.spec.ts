// UX audit tour: every screen and dialog a normal person meets, shot at 1280×800 and 390×844, in English and Swedish,
// with a few automatic checks per shot (sideways overflow on phones, unnamed buttons, English left in Swedish).
// Not part of the normal run: `AUDIT=1 npx playwright test e2e/audit-tour.spec.ts --workers=1`.
// Screenshots and findings-<time>.json land in e2e/screenshots/audit (git-ignored).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, hasLiveKit, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!process.env.AUDIT, 'UX audit tour: set AUDIT=1')
test.use({ actionTimeout: 8000 })

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(SHOTS, 'audit')
const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }
const PHONE_CTX = { viewport: PHONE, isMobile: true, hasTouch: true }
const FILM = resolve(HERE, 'fixtures', 'party.webm')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=', 'base64')
/** Only some shots: AUDIT_ONLY=onboarding,owner ... (part names start with these). */
const ONLY = (process.env.AUDIT_ONLY ?? '').split(',').filter(Boolean)

// ── Findings ──

interface Finding { shot: string; kind: string; detail: string }
const findings: Finding[] = []
const problems: string[] = []
const pages: Page[] = []

/** Runs one part of the tour; a failure is noted, open dialogs are closed, and the tour goes on. */
async function part(name: string, fn: () => Promise<void>) {
  if (ONLY.length && !ONLY.some((o) => name.startsWith(o))) return
  try {
    await fn()
  } catch (e) {
    problems.push(`${name}: ${(e as Error).message.split('\n').filter((l) => l.trim() && !l.includes('Call log')).slice(0, 3).join(' | ')}`)
    for (const page of pages) {
      if (page.isClosed()) continue
      await page.setViewportSize(DESKTOP).catch(() => undefined)
      await setLanguage(page, 'en').catch(() => undefined)
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => undefined)
    }
  }
}

/** Switches the app's language in place (the dev server's own i18n module, so no reload). */
async function setLanguage(page: Page, language: 'en' | 'sv') {
  await page.evaluate(async (l) => {
    const path = '/src/i18n/index.ts' // the dev server's module, the same instance the app uses
    const m = (await import(/* @vite-ignore */ path)) as { setLanguageChoice(l: string): void }
    m.setLanguageChoice(l)
  }, language)
  await expect(page.locator('html')).toHaveAttribute('lang', language)
}

/** Texts visible on the page, for comparing languages. */
const visibleTexts = (page: Page) =>
  page.evaluate(() => {
    const out = new Set<string>()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim()
      const el = n.parentElement
      if (!text || !el || el.closest('.message-text, .message-body, .rich-text, input, textarea, [contenteditable], .docs-reader, code, pre')) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      out.add(text)
    }
    for (const el of document.querySelectorAll('[aria-label], [placeholder], [title]')) {
      for (const a of ['aria-label', 'placeholder', 'title']) {
        const v = el.getAttribute(a)?.trim()
        if (v) out.add(`@${a}: ${v}`)
      }
    }
    return [...out]
  })

/** Checks at phone width: anything wider than the screen, and controls without a name. */
async function checks(page: Page, shot: string, phone: boolean) {
  const result = await page.evaluate((isPhone) => {
    const issues: { kind: string; detail: string }[] = []
    const w = window.innerWidth
    if (isPhone && document.documentElement.scrollWidth > w + 1) issues.push({ kind: 'page-scrolls-sideways', detail: `${document.documentElement.scrollWidth}px > ${w}px` })
    const describe = (el: Element) => {
      const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 3).join('.') : ''
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} "${(el.textContent ?? '').trim().slice(0, 40)}"`
    }
    if (isPhone) {
      for (const el of document.querySelectorAll('button, a, input, select, textarea, h1, h2, h3, label, [role=menuitem], [role=dialog]')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        // Inside something that scrolls sideways on purpose (rails, tab strips): fine.
        let scroller = false
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p)
          if ((s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden') && p.scrollWidth > p.clientWidth) { scroller = true; break }
          if (s.overflowX === 'hidden' || s.overflowX === 'clip') { if (p.getBoundingClientRect().right <= w + 1) { scroller = true; break } }
        }
        if (!scroller && (r.right > w + 2 || r.left < -2) && getComputedStyle(el).visibility !== 'hidden') issues.push({ kind: 'off-screen', detail: describe(el) + ` [${Math.round(r.left)}..${Math.round(r.right)}]` })
      }
    }
    for (const el of document.querySelectorAll('button, [role=button], a[href], [role=menuitem], [role=tab], input:not([type=hidden]), select, textarea')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const named = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || (el.textContent ?? '').trim() ||
        (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label') || el.getAttribute('placeholder')
      if (!named) issues.push({ kind: 'no-accessible-name', detail: describe(el) + ` ${el.outerHTML.slice(0, 120)}` })
    }
    // Text cut off without an ellipsis or a title: visible clipping.
    return issues
  }, phone)
  for (const r of result) findings.push({ shot, ...r })
}

/** Common English words that should never be left in a Swedish screen. */
const ENGLISH = /\b(the|your|you|and|with|this|that|from|server|channel|settings|message|messages|friends|invite|join|leave|create|save|cancel|delete|remove|open|close|members?|voice|call|search|upload|file|nothing|yet|here|there|no|not|can't|don't|will|now|new|more|less|loading|connecting)\b/i

/**
 * Four shots of what's on screen: desktop and phone width, English and Swedish. `phone: false` skips the phone
 * width (a phone context shoots at its own size), `both: false` skips Swedish.
 */
async function snap(page: Page, name: string, opts: { phone?: boolean; sv?: boolean } = {}) {
  const size = page.viewportSize()!
  const isPhoneCtx = size.width < 500
  const sizes: ('desktop' | 'phone')[] = isPhoneCtx ? ['phone'] : opts.phone === false ? ['desktop'] : ['desktop', 'phone']
  const settle = async () => {
    await page.waitForTimeout(300)
    // Finite animations only (a spinner's never finishes), and never longer than a second.
    await page.evaluate(() => Promise.race([
      Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => null))),
      new Promise((r) => setTimeout(r, 1000)),
    ])).catch(() => undefined)
  }
  const langs: ('en' | 'sv')[] = opts.sv === false ? ['en'] : ['en', 'sv']
  let enTexts: string[] = []
  for (const lang of langs) {
    if (lang === 'sv') await setLanguage(page, 'sv')
    for (const s of lang === 'sv' ? [...sizes].reverse() : sizes) {
      if (!isPhoneCtx) await page.setViewportSize(s === 'phone' ? PHONE : DESKTOP)
      await settle()
      const file = `${name}-${s}-${lang}`
      await page.screenshot({ path: join(OUT, `${file}.png`), animations: 'disabled' })
      if (lang === 'en') await checks(page, file, s === 'phone')
      if (s === sizes[0] && lang === 'en') enTexts = await visibleTexts(page)
      if (s === sizes[0] && lang === 'sv') {
        const svTexts = new Set(await visibleTexts(page))
        const left = enTexts.filter((t) => svTexts.has(t) && ENGLISH.test(t.replace(/^@[a-z-]+: /, '')))
        for (const t of left) findings.push({ shot: file, kind: 'english-in-swedish', detail: t.slice(0, 160) })
      }
    }
  }
  if (langs.includes('sv')) await setLanguage(page, 'en')
  if (!isPhoneCtx) await page.setViewportSize(size)
  await settle()
}

async function context(browser: Browser, options: Parameters<Browser['newContext']>[0] = { viewport: DESKTOP }): Promise<BrowserContext> {
  const ctx = await browser.newContext(options)
  ctx.on('page', (page) => pages.push(page))
  // Start in English whatever was chosen before.
  await ctx.addInitScript(() => { try { localStorage.setItem('iskra.language', 'en') } catch { /* private */ } })
  return ctx
}

/** My settings (the gear by your name), and a section. */
async function mySettings(page: Page, section?: string) {
  const drawer = page.getByRole('button', { name: /Open (channels|menu)/ }).first()
  if (await drawer.isVisible()) await drawer.click()
  await page.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  if (section) await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click()
  return dialog
}

/** The server room of the server on screen, and a section. */
async function serverRoom(page: Page, section?: string) {
  const drawer = page.getByRole('button', { name: /Open (channels|menu)/ }).first()
  if (await drawer.isVisible()) await drawer.click()
  await page.locator('.server-header-button').click()
  await page.getByRole('menuitem', { name: 'Server settings', exact: true }).click()
  const room = page.getByRole('dialog', { name: /· Server settings$/ })
  await expect(room).toBeVisible()
  if (section) await room.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click()
  return room
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function createChannel(page: Page, kind: string, name: string) {
  await page.getByRole('button', { name: 'Create channel' }).first().click()
  const create = page.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: kind }).click()
  await create.getByPlaceholder('game-night').fill(name)
  await create.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(create).toHaveCount(0)
}

const channel = (page: Page, name: string) => page.locator('.channel-list .channel, .channel-list .voice-channel', { hasText: name }).first()

let server: TestServer
let spare: TestServer | null = null
let botDir: string
test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true })
  server = await startServer('Game Night', hasLiveKit(), { Calls__RingTimeoutMs: '60000', ISKRA_STOP_ON_STDIN_CLOSE: '1' })
  spare = await startServer('Weekend Crew')
  botDir = mkdtempSync(join(tmpdir(), 'iskra-audit-'))
})
test.afterAll(async () => {
  test.setTimeout(180_000)
  await server?.stop()
  await spare?.stop()
  rmSync(botDir, { recursive: true, force: true })
  // One file per worker run (a failed test starts a new worker, which would otherwise overwrite it).
  if (problems.length || findings.length) writeFileSync(join(OUT, `findings-${Date.now()}.json`), JSON.stringify({ problems, findings }, null, 1))
  if (problems.length) console.log(`Tour problems:\n  ${problems.join('\n  ')}`)
  console.log(`${findings.length} automatic findings in ${OUT}`)
})

test('UX audit tour (browser)', async ({ browser }) => {
  test.setTimeout(1_800_000)

  // ── 1. Onboarding: a new person, "I already use Iskra", recovery key, terms ──
  await part('onboarding', async () => {
    const page = await (await context(browser)).newPage()
    await page.goto('/')
    await expect(page.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible()
    await snap(page, '01-welcome-terms')
    await page.getByRole('link', { name: /Terms of Use/ }).first().click().catch(() => undefined)
    await page.waitForTimeout(300)
    if (await page.getByRole('dialog').count()) {
      await snap(page, '01b-terms-text')
      await page.keyboard.press('Escape')
    }
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I already use Iskra/ }).click()
    await snap(page, '02-existing-choice')
    await page.getByRole('button', { name: /Link with my other device/ }).click()
    await snap(page, '03-link-device')
    await page.getByRole('button', { name: 'Back' }).first().click()
    await page.getByRole('button', { name: /Use my recovery key/ }).click()
    await snap(page, '04-recovery-empty')
    await page.getByLabel('Recovery key').fill('ISKRA-NOPE-NOPE-NOPE-NOPE-NOPE-NOPE')
    await snap(page, '04b-recovery-bad')
    await page.getByRole('button', { name: 'Back' }).first().click()
    await page.getByRole('button', { name: "I'm new here" }).click()
    await snap(page, '05-new-name')
    await page.getByLabel('Your name').fill('Newbie')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('No servers yet')).toBeVisible()
    await snap(page, '06-no-servers')
    await page.getByRole('button', { name: /Start your own server/ }).click()
    await snap(page, '07-start-server-web')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'I have an invite link' }).click()
    await snap(page, '08-join-dialog')
    await page.getByLabel('Invite link').fill('not a link')
    await page.getByRole('button', { name: 'Join', exact: true }).click().catch(() => undefined)
    await snap(page, '08b-join-bad-link')
    // A well-formed link to a server that isn't there.
    const dead = `${Buffer.from('http://localhost:1').toString('base64url')}.${'A'.repeat(43)}.abcdefgh12`
    await page.getByLabel('Invite link').fill(`http://localhost:1/#/join/${dead}`)
    await page.getByRole('button', { name: 'Join', exact: true }).click().catch(() => undefined)
    await page.waitForTimeout(2500)
    await snap(page, '08c-join-unreachable')
    await page.keyboard.press('Escape')
    // Home with nothing yet: friends, saved, inbox.
    await page.getByRole('button', { name: 'Direct messages' }).click().catch(() => undefined)
    await snap(page, '09-home-empty')
    await page.getByRole('tab', { name: /Online/ }).click().catch(() => undefined)
    await snap(page, '09b-friends-online-empty', { phone: false })
    await page.getByRole('tab', { name: /Pending/ }).click().catch(() => undefined)
    await snap(page, '09c-friends-pending-empty', { phone: false })
    await page.getByRole('button', { name: 'Saved messages' }).click()
    await snap(page, '09d-saved-empty')
    await page.getByRole('tab', { name: 'Scheduled' }).click().catch(() => undefined)
    await snap(page, '09e-scheduled-empty', { phone: false })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'New group' }).first().click()
    await snap(page, '09f-new-group-no-people')
    await page.keyboard.press('Escape')
  })

  // ── 1b. Desktop-only screens through a stand-in bridge (so they can be shot in Swedish too) ──
  await part('bridge', async () => {
    const ctx = await context(browser)
    await ctx.addInitScript(() => {
      ;(window as unknown as { iskraDesktop: unknown }).iskraDesktop = {
        platform: 'win32',
        setPushToTalkKey: async () => undefined,
        capturePushToTalkKey: async () => null,
        onPushToTalk: () => () => undefined,
        pushToTalkStatus: async () => 'ready',
        openSystemSettings: async () => undefined,
        updates: { status: async () => ({ state: 'ready', version: '9.9.9' }), onStatus: () => () => undefined, restart: async () => false },
        onPickScreen: () => () => undefined,
        pickScreen: () => undefined,
        host: {
          available: async () => true, list: async () => [], create: async () => new Promise(() => undefined), start: async () => null, stop: async () => null,
          templates: async () => [
            { id: 'empty', name: 'Empty', description: 'Just #general.', categories: [], channels: [{ name: 'general', kind: 'text', userLimit: 0 }], roles: [], rules: false },
            { id: 'gaming', name: 'Gaming group', description: 'Channels for games, clips and voice.', roles: ['Mods'], rules: true, channels: [],
              categories: [{ name: 'Text', channels: [{ name: 'general', kind: 'text', userLimit: 0 }, { name: 'clips', kind: 'text', userLimit: 0 }] },
                { name: 'Voice', channels: [{ name: 'Lounge', kind: 'voice', userLimit: 0 }, { name: 'Duo', kind: 'voice', userLimit: 2 }] }] },
          ],
        },
      }
    })
    const page = await ctx.newPage()
    await page.goto('/')
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Desk')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Update ready')).toBeVisible()
    await snap(page, '07b-desktop-no-servers-update')
    await page.getByRole('button', { name: 'Create a server' }).click()
    await snap(page, '07c-desktop-create-server')
    await page.getByLabel('Server name').fill('Living Room')
    await page.getByRole('button', { name: 'Next' }).click()
    await snap(page, '07d-desktop-create-templates')
    await page.locator('[data-template]').first().click()
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await snap(page, '07e-desktop-create-working')
    await ctx.close()
  })

  // ── 2. The owner joins with the owner link; a member and a third person join ──
  const owner = await (await context(browser)).newPage()
  await owner.goto(server.ownerLink())
  await expect(owner.getByText("You've been invited")).toBeVisible()
  await part('invite', async () => {
    await snap(owner, '10-invite-landing')
  })
  await agreeToTerms(owner)
  await owner.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await part('invite', async () => {
    await snap(owner, '10b-invite-name')
  })
  await owner.getByLabel('Your name').fill('Viktor')
  await owner.getByRole('button', { name: 'Join' }).click()
  await expect(owner.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 15_000 })
  await part('owner-first', async () => {
    await snap(owner, '11-owner-first-view')
  })
  const invite = await createInviteLink(owner)
  const member = await (await context(browser)).newPage()
  await joinVia(member, invite, 'Alice')
  const third = await (await context(browser)).newPage()
  await joinVia(third, invite, 'Bob')
  const phone = await (await context(browser, PHONE_CTX)).newPage()
  await joinVia(phone, invite, 'Sam with a rather long name')

  // ── 3. A server as the owner ──
  await part('owner-chat', async () => {
    await send(owner, 'Welcome to **Game Night**! Who is in for Valheim on Friday?')
    await send(member, 'me! @Viktor I can bring the mead 🍺')
    await send(third, 'Count me in. https://example.com/patch-notes-for-the-big-update')
    await snap(owner, '12-channel-with-messages')
    await snap(phone, '12-channel-phone-native')
    const msg = owner.locator('.message', { hasText: 'bring the mead' }).first()
    await msg.hover()
    await snap(owner, '12b-message-hover', { phone: false })
    await msg.getByRole('button', { name: 'More', exact: true }).click()
    await snap(owner, '12c-message-more-menu')
    await owner.keyboard.press('Escape')
  })
  await part('owner-invite', async () => {
    await owner.getByRole('button', { name: 'Invite friends' }).click()
    await expect(owner.locator('.copy-row input')).toHaveValue(/#\/join\//)
    await snap(owner, '13-invite-dialog')
    await owner.keyboard.press('Escape')
  })
  await part('owner-servermenu', async () => {
    await owner.locator('.server-header-button').click()
    await snap(owner, '14-server-menu')
    await owner.getByRole('menuitem', { name: 'More settings' }).click()
    await snap(owner, '14b-server-menu-more')
    await owner.keyboard.press('Escape')
    await owner.keyboard.press('Escape')
    await owner.locator('.server-rail').getByTitle('Game Night', { exact: true }).click({ button: 'right' })
    await snap(owner, '14c-rail-right-click')
    await owner.keyboard.press('Escape')
  })
  await part('owner-channels', async () => {
    await owner.getByRole('button', { name: 'Create channel' }).first().click()
    await snap(owner, '15-create-channel')
    for (const kind of ['Voice', 'Forum', 'Stage', 'Docs']) {
      await owner.getByRole('dialog', { name: 'Create channel' }).getByRole('radio', { name: kind }).click()
      await snap(owner, `15-create-channel-${slug(kind)}`, { phone: false })
    }
    await owner.keyboard.press('Escape')
    if (hasLiveKit()) await createChannel(owner, 'Voice', 'lounge')
    await createChannel(owner, 'Forum', 'ideas')
    await snap(owner, '16-forum-empty')
    await owner.locator('.forum-toolbar').getByRole('button', { name: 'New post' }).click()
    await snap(owner, '16b-forum-new-post')
    const post = owner.getByRole('dialog', { name: 'New post' })
    await post.getByPlaceholder("What's it about?").fill('Next game?')
    await post.getByPlaceholder('Add details, links, or a picture').fill('Vote below.')
    await post.getByRole('button', { name: 'Post' }).click()
    await expect(owner.locator('.thread-panel')).toBeVisible()
    await snap(owner, '16c-forum-post-open')
    await owner.locator('.thread-panel').getByRole('button', { name: 'Close thread' }).click()
    await createChannel(owner, 'Docs', 'handbook')
    await snap(owner, '17-docs-empty')
    await owner.getByRole('button', { name: 'Write the first page' }).click()
    await owner.getByPlaceholder('Page title').fill('Start here')
    await owner.getByLabel('Page text').fill('# Rules\n\nBe nice. Bring snacks.\n\n| Game | Night |\n|---|---|\n| Valheim | Fri |')
    await snap(owner, '17b-docs-editor')
    await owner.getByRole('button', { name: 'Create page' }).click()
    await snap(owner, '17c-docs-page')
    if (hasLiveKit()) {
      await createChannel(owner, 'Stage', 'town-hall')
      await snap(owner, '18-stage-channel')
    }
    await channel(owner, 'general').click()
  })
  await part('owner-events', async () => {
    await owner.locator('.events-button').click()
    await snap(owner, '19-events-empty')
    await owner.getByRole('dialog', { name: 'Events' }).getByRole('button', { name: 'Schedule an event' }).click()
    await snap(owner, '19b-event-form')
    const form = owner.getByRole('dialog', { name: 'Schedule an event' })
    await form.getByPlaceholder('Game night').fill('Board game night')
    await form.getByRole('radio', { name: 'Somewhere else' }).click()
    await form.getByLabel('Place').fill("Viktor's place")
    await form.getByRole('button', { name: 'Schedule' }).click()
    await expect(owner.locator('.event-card', { hasText: 'Board game night' })).toBeVisible()
    await snap(owner, '19c-events-list')
    await owner.keyboard.press('Escape')
  })
  await part('owner-chat-tools', async () => {
    await owner.getByRole('button', { name: 'Create a poll' }).click()
    await snap(owner, '20-poll-dialog')
    const dialog = owner.getByRole('dialog', { name: 'Create a poll' })
    await dialog.getByLabel('Question').fill('What do we play tonight?')
    await dialog.getByRole('textbox', { name: 'Answer 1' }).fill('Valheim')
    await dialog.getByRole('textbox', { name: 'Answer 2' }).fill('Lethal Company')
    await dialog.getByRole('button', { name: 'Post poll' }).click()
    await expect(owner.locator('.poll')).toBeVisible()
    await snap(owner, '20b-poll-posted')
    const welcome = owner.locator('.message', { hasText: 'Welcome to' })
    await welcome.hover()
    await welcome.getByRole('button', { name: 'Pin message' }).click()
    await owner.getByRole('button', { name: 'Pinned messages' }).click()
    await snap(owner, '21-pins')
    await owner.keyboard.press('Escape')
    await owner.getByRole('button', { name: 'Threads' }).click()
    await snap(owner, '21b-threads-empty')
    await owner.keyboard.press('Escape')
    const mead = owner.locator('.message', { hasText: 'bring the mead' }).first()
    await mead.hover()
    await mead.getByRole('button', { name: 'Start a thread' }).click()
    await snap(owner, '21c-thread-create')
    await owner.getByRole('button', { name: 'Create thread' }).click()
    const reply = owner.locator('.thread-panel').getByPlaceholder(/Reply (in|to) the/)
    await reply.fill('I will bring the flour too')
    await reply.press('Enter')
    await snap(owner, '21d-thread-panel')
    await owner.locator('.thread-panel').getByRole('button', { name: 'Close thread' }).click()
    const box = owner.getByRole('searchbox', { name: 'Search messages' }).first()
    await box.click()
    await snap(owner, '22-search-focus', { phone: false })
    await box.fill('valheim')
    await box.press('Enter')
    await snap(owner, '22b-search-results')
    await box.fill('zzzznothing')
    await box.press('Enter')
    await snap(owner, '22c-search-empty', { phone: false })
    await owner.locator('.search-panel').getByRole('button', { name: 'Close search' }).last().click()
    // Pickers: emoji, GIF, stickers.
    await owner.getByRole('button', { name: /Emoji/ }).first().click()
    await snap(owner, '23-emoji-picker')
    for (const tab of ['GIFs', 'Stickers']) {
      const t = owner.getByRole('tab', { name: tab })
      if (await t.count()) {
        await t.first().click()
        await snap(owner, `23-picker-${slug(tab)}`)
      }
    }
    await owner.keyboard.press('Escape')
    await owner.keyboard.press('Control+k')
    await snap(owner, '24-quick-switcher')
    await owner.keyboard.press('Escape')
  })
  await part('owner-uploads', async () => {
    await owner.locator('input[type=file]').first().setInputFiles({ name: 'map.png', mimeType: 'image/png', buffer: PNG })
    await snap(owner, '25-upload-pending')
    await owner.getByPlaceholder('Message #general').press('Enter')
    await owner.locator('input[type=file]').first().setInputFiles({ name: 'world-backup.zip', mimeType: 'application/zip', buffer: Buffer.alloc(6 * 1024 * 1024, 7) })
    await owner.getByPlaceholder('Message #general').press('Enter')
    await owner.waitForTimeout(300)
    await snap(owner, '25b-upload-big-progress', { phone: false, sv: false })
    await expect(owner.locator('.message', { hasText: 'world-backup.zip' })).toBeVisible({ timeout: 30_000 })
    await snap(owner, '25c-upload-file-message')
  })
  await part('owner-profile-card', async () => {
    await owner.locator('.member-list').getByRole('button', { name: /Alice/ }).click()
    await snap(owner, '26-profile-card')
    await owner.keyboard.press('Escape')
    await owner.locator('.member-list').getByRole('button', { name: /Alice/ }).click({ button: 'right' })
    await snap(owner, '27-person-menu-owner')
    await owner.keyboard.press('Escape')
    await owner.locator('.member-list').getByRole('button', { name: /Viktor/ }).click({ button: 'right' })
    await snap(owner, '27b-person-menu-self')
    await owner.keyboard.press('Escape')
    await snap(owner, '28-member-list', { phone: false })
  })

  // ── 4. The server room, every section ──
  await part('owner-room', async () => {
    const room = await serverRoom(owner)
    const nav = room.getByRole('navigation', { name: 'Settings sections' })
    const sections = await nav.getByRole('button').allTextContents()
    for (const [i, section] of sections.entries()) {
      await part(`owner-room ${section}`, async () => {
        await nav.getByRole('button', { name: section, exact: true }).click()
        await snap(owner, `30-room-${String(i).padStart(2, '0')}-${slug(section)}`)
      })
    }
    await owner.keyboard.press('Escape')
  })

  // ── 5. My settings, every section ──
  await part('owner-mine', async () => {
    const dialog = await mySettings(owner)
    const nav = dialog.getByRole('navigation', { name: 'Settings sections' })
    const sections = await nav.getByRole('button').allTextContents()
    for (const [i, section] of sections.entries()) {
      await part(`owner-mine ${section}`, async () => {
        await nav.getByRole('button', { name: section, exact: true }).click()
        await snap(owner, `40-mine-${String(i).padStart(2, '0')}-${slug(section)}`)
      })
    }
    await owner.keyboard.press('Escape')
  })

  // ── 6. The same server as a plain member ──
  await part('member-view', async () => {
    await snap(member, '50-member-view')
    await member.locator('.server-header-button').click()
    await snap(member, '50b-member-server-menu')
    await member.keyboard.press('Escape')
    await member.locator('.member-list').getByRole('button', { name: /Viktor/ }).click({ button: 'right' })
    await snap(member, '50c-member-person-menu')
    await member.keyboard.press('Escape')
    await member.locator('.member-list').getByRole('button', { name: /Viktor/ }).click()
    await snap(member, '50d-member-profile-card')
    await member.keyboard.press('Escape')
    // Things a member may not do.
    await channel(member, 'handbook').click()
    await snap(member, '50e-member-docs')
    await channel(member, 'ideas').click()
    await snap(member, '50f-member-forum')
    await channel(member, 'general').click()
  })

  // ── 7. Phone: navigation by drawers ──
  await part('phone-nav', async () => {
    await phone.screenshot({ path: join(OUT, '55-phone-before-phone-en.png') })
    await phone.getByRole('button', { name: /Open (channels|menu)/ }).first().click()
    await snap(phone, '55-phone-drawer')
    await phone.keyboard.press('Escape')
    await phone.getByRole('button', { name: 'Members' }).first().click()
    await snap(phone, '55b-phone-members')
    await phone.keyboard.press('Escape')
    const dialog = await mySettings(phone)
    await snap(phone, '55c-phone-my-settings')
    await dialog.getByRole('button', { name: 'Profile', exact: true }).click()
    await snap(phone, '55d-phone-profile')
    await phone.keyboard.press('Escape')
    await phone.keyboard.press('Escape')
  })

  // ── 8. Friends, DMs, groups, saved, inbox ──
  await part('friends', async () => {
    await owner.locator('.member-list').getByRole('button', { name: /Alice/ }).click()
    await owner.getByRole('button', { name: 'Add friend' }).click()
    await snap(owner, '60-friend-request-sent', { phone: false })
    await owner.keyboard.press('Escape')
    await owner.locator('.member-list').getByRole('button', { name: /Bob/ }).click()
    await owner.getByRole('button', { name: 'Add friend' }).click()
    await owner.keyboard.press('Escape')
    await member.getByRole('button', { name: 'Direct messages' }).click()
    await snap(member, '60b-friends-incoming')
    await member.getByRole('tab', { name: /Pending/ }).click()
    await snap(member, '60c-friends-pending-incoming')
    await member.getByRole('button', { name: /Accept friend request/ }).first().click()
    await owner.getByRole('button', { name: 'Direct messages' }).click()
    await owner.locator('.channel', { hasText: 'Friends' }).click()
    await snap(owner, '61-friends-all')
    for (const tab of ['Online', 'Pending']) {
      await owner.getByRole('tab', { name: new RegExp(tab) }).click()
      await snap(owner, `61-friends-${slug(tab)}`)
    }
    await owner.getByRole('tab', { name: /All/ }).click()
  })
  await part('dm', async () => {
    await owner.getByRole('button', { name: 'Message', exact: true }).first().click()
    await snap(owner, '62-dm-empty')
    const box = owner.getByPlaceholder('Message Alice')
    await box.fill('hey, call later?')
    await box.press('Enter')
    await owner.locator('input[type=file]').first().setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await owner.waitForTimeout(500)
    await box.press('Enter').catch(() => undefined)
    await owner.waitForTimeout(1500)
    await snap(owner, '62b-dm-with-file')
    await owner.getByRole('button', { name: 'Verify' }).click()
    await snap(owner, '62c-verify')
    await owner.keyboard.press('Escape')
  })
  await part('groups', async () => {
    await owner.getByRole('button', { name: 'New group' }).first().click()
    const dialog = owner.getByRole('dialog', { name: 'New group' })
    await snap(owner, '63-new-group')
    await dialog.getByLabel('Group name (optional)').fill('Raid team')
    for (const m of ['Alice', 'Bob']) await dialog.locator('.person-pick', { hasText: m }).click()
    await dialog.getByRole('button', { name: 'Create group' }).click()
    await expect(owner.locator('.group-title')).toHaveText('Raid team')
    await snap(owner, '63b-group-chat')
    await owner.getByRole('button', { name: 'Group members' }).click()
    await snap(owner, '63c-group-members')
    await owner.keyboard.press('Escape')
  })
  await part('saved-inbox', async () => {
    await member.locator('.server-icon[title="Game Night"]').click()
    const m = member.locator('.message', { hasText: 'Welcome to' })
    await m.hover()
    await m.getByRole('button', { name: 'More', exact: true }).click()
    await member.getByRole('menuitem', { name: 'Save message' }).click()
    await snap(member, '64-saved-toast', { phone: false })
    await send(member, 'hey @Viktor look at the poll')
    await owner.waitForTimeout(800)
    await owner.getByRole('button', { name: /^Inbox/ }).first().click()
    await snap(owner, '64b-inbox')
    await owner.keyboard.press('Escape')
    await member.getByRole('button', { name: 'Direct messages' }).click()
    await member.getByRole('button', { name: 'Saved messages' }).click()
    await snap(member, '64c-saved')
    await member.keyboard.press('Escape')
  })

  // ── 9. Calls: voice channel, camera, share, captions, watch party, soundboard, clips; DM and group calls ──
  if (hasLiveKit()) {
    await part('voice', async () => {
      await owner.locator('.server-icon[title="Game Night"]').click()
      await member.locator('.server-icon[title="Game Night"]').click()
      for (const p of [owner, member]) await channel(p, 'lounge').getByRole('button').first().click()
      await expect(owner.locator('.call-controls')).toBeVisible({ timeout: 20_000 })
      await owner.waitForTimeout(1500)
      await snap(owner, '70-voice-stage')
      await owner.locator('.call-controls').getByRole('button', { name: /Turn camera on|Camera/ }).first().click()
      await owner.waitForTimeout(2000)
      await snap(owner, '70b-voice-camera')
      await owner.locator('.call-controls').getByRole('button', { name: /Share/ }).first().click()
      await owner.waitForTimeout(1500)
      await snap(owner, '70c-voice-share-menu')
      await owner.keyboard.press('Escape')
      await owner.locator('.call-controls').getByRole('button', { name: /Captions/ }).first().click().catch(() => undefined)
      await owner.waitForTimeout(800)
      await snap(owner, '70d-voice-captions')
      await owner.locator('.call-controls').getByRole('button', { name: 'Soundboard' }).click()
      await snap(owner, '71-soundboard-empty')
      await owner.keyboard.press('Escape')
      await owner.locator('.call-controls').getByRole('button', { name: /Clips/ }).first().click().catch(() => undefined)
      await snap(owner, '72-clips-off')
      await owner.keyboard.press('Escape')
      await owner.locator('.call-controls').getByRole('button', { name: 'Watch together' }).click()
      await snap(owner, '73-watch-dialog')
      const dialog = owner.getByRole('dialog', { name: 'Watch together' })
      await dialog.getByLabel('Title (optional)').fill('Test pattern')
      await dialog.locator('input[type=file]').setInputFiles(FILM)
      await expect(owner.locator('.watch-party, .watch')).toBeVisible({ timeout: 20_000 })
      await owner.waitForTimeout(1500)
      await snap(owner, '73b-watch-party')
      await snap(member, '73c-watch-party-member')
      await channel(owner, 'general').click()
      await snap(owner, '74-voice-bar-in-text')
      await owner.locator('.voice-controls').getByRole('button', { name: 'Leave voice' }).click()
      await member.locator('.voice-controls, .call-controls').getByRole('button', { name: /Leave/ }).first().click()
    })
    await part('stage', async () => {
      await channel(owner, 'town-hall').getByRole('button').first().click().catch(async () => channel(owner, 'town-hall').click())
      await owner.waitForTimeout(2000)
      await snap(owner, '75-stage-joined')
      await owner.locator('.voice-controls, .call-controls').getByRole('button', { name: /Leave/ }).first().click().catch(() => undefined)
    })
    await part('dm-call', async () => {
      await owner.getByRole('button', { name: 'Direct messages' }).click()
      await owner.locator('.dm-row', { hasText: 'Alice' }).click()
      await owner.getByRole('button', { name: 'Start voice call' }).click()
      await expect(member.getByRole('alertdialog')).toBeVisible()
      await snap(member, '76-incoming-call')
      await snap(owner, '76b-calling')
      await member.getByRole('alertdialog').getByRole('button', { name: 'Accept' }).click()
      await expect(owner.locator('.call-panel .call-status')).toHaveText(/^\d+:\d\d$/, { timeout: 20_000 })
      await snap(owner, '76c-in-dm-call')
      await owner.locator('.call-panel').getByRole('button', { name: 'Hang up' }).click()
      await owner.waitForTimeout(800)
      await snap(owner, '76d-call-ended-log', { phone: false })
    })
    await part('group-call', async () => {
      await owner.locator('.group-row', { hasText: 'Raid team' }).click()
      await owner.getByRole('button', { name: 'Start voice call' }).click()
      const ring = third.getByRole('alertdialog')
      await expect(ring).toBeVisible({ timeout: 15_000 })
      await snap(third, '77-group-call-ring')
      await ring.getByRole('button', { name: 'Join' }).click()
      // Alice is rung too: she lets it ring out (the ring is modal, so it would block her page).
      await member.getByRole('alertdialog').getByRole('button', { name: /Decline|Ignore|Not now/ }).first().click().catch(() => undefined)
      await owner.waitForTimeout(3000)
      await snap(owner, '77b-group-call')
      await owner.locator('.call-panel').getByRole('button', { name: /Hang up|Leave/ }).first().click()
      await third.locator('.call-panel').getByRole('button', { name: /Hang up|Leave/ }).first().click().catch(() => undefined)
    })
  }

  // ── 10. Error states ──
  await part('errors-rate', async () => {
    await member.locator('.server-icon[title="Game Night"]').click()
    await channel(member, 'general').click()
    const box = member.getByPlaceholder('Message #general')
    for (let i = 0; i < 18; i++) {
      await box.fill(`spam ${i}`)
      await box.press('Enter')
    }
    await member.waitForTimeout(600)
    await snap(member, '80-rate-limited')
  })
  await part('errors-upload-too-big', async () => {
    await member.locator('.server-icon[title="Game Night"]').click()
    await channel(member, 'general').click()
    const room = await serverRoom(owner, 'Limits')
    await room.getByLabel('Largest upload').fill('1')
    await room.getByRole('button', { name: 'Save', exact: true }).click().catch(() => undefined)
    await owner.waitForTimeout(500)
    await snap(owner, '81-limits-saved', { phone: false })
    await owner.keyboard.press('Escape')
    await member.locator('input[type=file]').first().setInputFiles({ name: 'too-big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 * 1024, 1) })
    await member.getByPlaceholder('Message #general').press('Enter')
    await member.waitForTimeout(1500)
    await snap(member, '81b-upload-too-big')
  })
  await part('errors-permission', async () => {
    // A member opening a channel they can't post in (Docs: read-only for members) and editing someone's message.
    await channel(member, 'handbook').click()
    await snap(member, '82-member-read-only-docs', { phone: false })
    await channel(member, 'general').click()
  })
  await part('errors-offline', async () => {
    const page = await (await context(browser)).newPage()
    await joinVia(page, spare!.ownerLink(), 'Owner')
    await send(page, 'see you all later')
    await spare!.stop()
    spare = null
    await expect(page.locator('.pill')).toBeVisible({ timeout: 15_000 })
    await snap(page, '83-server-offline')
    await page.locator('.server-header-button').click().catch(() => undefined)
    await snap(page, '83b-offline-menu', { phone: false })
    await page.keyboard.press('Escape')
    const box = page.locator('.composer textarea, textarea').last()
    await box.fill('anyone there?').catch(() => undefined)
    await box.press('Enter').catch(() => undefined)
    await page.waitForTimeout(800)
    await snap(page, '83c-offline-send')
  })
  await part('errors-restart', async () => {
    await owner.locator('.server-icon[title="Game Night"]').click()
    await channel(owner, 'general').click()
    const restarting = server.restart(4000)
    await expect(owner.getByText(/restarting/i).first()).toBeVisible({ timeout: 15_000 })
    await snap(owner, '84-server-restarting', { phone: false, sv: false })
    await restarting
    await owner.waitForTimeout(3000)
    await snap(owner, '84b-after-restart', { phone: false, sv: false })
  })
  await part('member-leave', async () => {
    await member.locator('.server-icon[title="Game Night"]').click()
    await member.locator('.server-header-button').click()
    await member.getByRole('menuitem', { name: 'Leave server' }).click()
    await snap(member, '85-leave-confirm')
    await member.keyboard.press('Escape')
  })

  expect(problems, problems.join('\n')).toEqual([])
})

// ── Desktop app (Electron): create a server, keep running, internet access help, update toast ──
const DESKTOP_DIR = resolve(HERE, '../../desktop')
const built = existsSync(join(DESKTOP_DIR, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/index.html'))

test('UX audit tour (desktop app)', async () => {
  test.skip(!built, 'build desktop/ and the client first')
  test.setTimeout(600_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-audit-desktop-'))
  const hostRoot = mkdtempSync(join(tmpdir(), 'iskra-audit-hosted-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP_DIR, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP_DIR,
    env: { ...env, ISKRA_HOST_ROOT: hostRoot, ISKRA_LOCAL_ONLY: '1' },
  })
  const shoot = async (page: Page, name: string) => {
    // English only here: the built app can't switch language in place (the browser part shoots the same dialogs in Swedish).
    for (const [s, size] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
      await app.evaluate(({ BrowserWindow }, sz) => BrowserWindow.getAllWindows()[0].setContentSize(sz.width, sz.height), size)
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(OUT, `${name}-${s}-en.png`), animations: 'disabled' })
      if (s === 'phone') await checks(page, `${name}-phone-en`, true)
    }
    await app.evaluate(({ BrowserWindow }, sz) => BrowserWindow.getAllWindows()[0].setContentSize(sz.width, sz.height), DESKTOP)
  }
  try {
    const page = await app.firstWindow()
    pages.push(page)
    await app.evaluate(({ BrowserWindow }, sz) => BrowserWindow.getAllWindows()[0].setContentSize(sz.width, sz.height), DESKTOP)
    await part('desktop-welcome', async () => {
      await expect(page.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible()
      await shoot(page, '90-desktop-welcome')
    })
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Host')
    await page.getByRole('button', { name: 'Continue' }).click()
    await part('desktop-empty', async () => {
      await shoot(page, '91-desktop-no-servers')
    })
    await part('desktop-create', async () => {
      await page.getByRole('button', { name: 'Create a server' }).click()
      await shoot(page, '92-create-server-1')
      await page.getByLabel('Server name').fill('Living Room')
      await page.getByRole('button', { name: 'Next' }).click()
      await shoot(page, '92b-create-server-templates')
      await page.locator('[data-template="gaming"], [data-template="friends"], [data-template]').first().click()
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await page.waitForTimeout(800)
      await shoot(page, '92c-create-server-working')
      await expect(page.getByRole('heading', { name: 'Living Room is ready' })).toBeVisible({ timeout: 60_000 })
      await shoot(page, '92d-create-server-ready')
      await page.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 30_000 })
      await shoot(page, '93-hosted-server')
    })
    await part('desktop-internet', async () => {
      await page.locator('.server-header-button').click()
      await page.getByRole('menuitem', { name: 'Server settings', exact: true }).click()
      const room = page.getByRole('dialog', { name: /· Server settings$/ })
      await room.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Internet access', exact: true }).click()
      await page.waitForTimeout(1500)
      await shoot(page, '94-internet-access')
      for (const help of [/Why can't friends|Help|What do I do|Can't reach/i]) {
        const b = room.getByRole('button', { name: help }).first()
        if (await b.count()) {
          await b.click()
          await shoot(page, '94b-internet-help')
          await page.keyboard.press('Escape')
        }
      }
      const nav = room.getByRole('navigation', { name: 'Settings sections' })
      for (const section of ['Server updates', 'Backup & move', 'Import from Discord', 'Limits']) {
        await part(`desktop-room ${section}`, async () => {
          await nav.getByRole('button', { name: section, exact: true }).click()
          await shoot(page, `95-desktop-room-${slug(section)}`)
        })
      }
      await page.keyboard.press('Escape')
    })
    await part('desktop-mine', async () => {
      await page.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Desktop app', exact: true }).click()
      await shoot(page, '96-desktop-app-settings')
      await settings.getByRole('button', { name: 'Voice & audio', exact: true }).click()
      await shoot(page, '96b-desktop-voice')
      await page.keyboard.press('Escape')
    })
    await part('desktop-update', async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('iskra:update', { state: 'ready', version: '9.9.9' }))
      await expect(page.getByText('Update ready')).toBeVisible()
      await shoot(page, '97-update-toast')
      await page.getByRole('button', { name: 'Join a server' }).click()
      await shoot(page, '98-join-or-create')
      await page.keyboard.press('Escape')
    })
    await part('desktop-keep-running', async () => {
      // Closing the window with a hosted server running.
      const closed = app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); return BrowserWindow.getAllWindows().length })
      await closed
      await page.waitForTimeout(1000)
      const wins = await app.windows()
      for (const [i, w] of wins.entries()) if (!w.isClosed()) await w.screenshot({ path: join(OUT, `99-after-close-${i}.png`) }).catch(() => undefined)
    })
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(hostRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})

// ── Profile pages: a normal, styled page in the desktop app's walled page view, next to the browser and the editor ──
test('UX audit: profile pages render styled (desktop app vs browser)', async ({ browser }) => {
  test.skip(!built, 'build desktop/ and the client first')
  test.setTimeout(400_000)
  const server = await startServer('Page Gallery')
  const userData = mkdtempSync(join(tmpdir(), 'iskra-audit-pages-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP_DIR, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP_DIR,
    env: { ...env, ISKRA_LOCAL_ONLY: '1' },
  })
  const report: Record<string, unknown> = {}
  try {
    // The browser person: owner, uploads a picture to the server, so a page can use it from /files/.
    const web = await (await browser.newContext({ viewport: DESKTOP })).newPage()
    await joinVia(web, server.ownerLink(), 'Webby')
    const swatch = await web.screenshot({ clip: { x: 0, y: 0, width: 72, height: 72 } })
    await web.locator('input[type=file]').first().setInputFiles({ name: 'swatch.png', mimeType: 'image/png', buffer: swatch })
    await expect(web.locator('.pending-upload .muted')).toHaveText(/B$/, { timeout: 10_000 }) // Enter does nothing while it uploads
    await web.getByPlaceholder('Message #general').press('Enter')
    const uploaded = web.locator('.message img').last()
    await expect(uploaded).toBeVisible({ timeout: 15_000 })
    const fileUrl = new URL((await uploaded.getAttribute('src'))!, server.url).href
    report.fileUrl = fileUrl
    const font = readFileSync('C:/Windows/Fonts/marlett.ttf', { encoding: 'base64' })
    const STYLED = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'Probe'; src: url(data:font/ttf;base64,${font}) format('truetype'); }
body { margin: 0; min-height: 100vh; font-family: Georgia, serif; color: #fff; background: linear-gradient(135deg, #0f766e, #7c3aed); }
.card { margin: 24px; padding: 20px; border-radius: 16px; background: rgba(0,0,0,.35); box-shadow: 0 10px 30px rgba(0,0,0,.4); }
h1 { margin: 0 0 8px; font-size: 40px; letter-spacing: 2px; }
.spin { display: inline-block; width: 40px; height: 40px; background: #facc15; border-radius: 8px; animation: spin 2s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.probe { font-family: 'Probe'; font-size: 24px; }
img { width: 72px; height: 72px; border: 3px solid #fff; border-radius: 8px; margin-right: 8px; }
</style></head><body><div class="card">
<h1>Styled page</h1><p>Gradient, card, animation <span class="spin"></span></p>
<p><img id="dataimg" alt="data image" src="data:image/png;base64,${swatch.toString('base64')}"><img id="fileimg" alt="server file" src="${fileUrl}"></p>
<p class="probe">abc</p><p id="js">Scripts did not run</p>
</div><script>document.getElementById('js').textContent = 'Scripts ran'; document.fonts.load("24px Probe").then((f) => { document.getElementById('js').textContent += ', font ' + (f.length ? 'loaded' : 'missing') })</script></body></html>`

    const editPage = async (page: Page, html: string) => {
      await page.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true }).click()
      await page.getByRole('button', { name: /Make a page|Edit page/ }).click()
      if (html === 'template') await page.getByRole('button', { name: 'Start from the template' }).click()
      else await page.getByLabel('Page HTML').fill(html)
      await page.waitForTimeout(2500)
    }
    const publish = async (page: Page) => {
      await page.getByRole('button', { name: 'Publish', exact: true }).click()
      await expect(page.getByText('Published', { exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
    }
    const openPageOf = async (page: Page, name: string) => {
      await page.locator('.member-list').getByRole('button', { name: new RegExp(name) }).click()
      await page.getByRole('button', { name: 'Open profile page' }).click()
      await expect(page.getByRole('dialog', { name: `${name}'s page` })).toBeVisible()
      await page.waitForTimeout(3000)
    }
    // What each desktop page view shows, read from inside the view.
    type Guest = { getType(): string; getURL(): string; executeJavaScript(code: string): Promise<unknown> }
    const inspect = () => app.evaluate(async ({ webContents }) => Promise.all((webContents.getAllWebContents() as unknown as Guest[])
      .filter((w) => w.getType() === 'webview')
      .map(async (w) => ({
        url: w.getURL().slice(0, 50),
        state: await w.executeJavaScript(`(() => { const b = getComputedStyle(document.body); const i = (id) => { const e = document.getElementById(id); return e ? e.complete && e.naturalWidth > 0 : null };
          const spin = document.querySelector('.spin'); return { bodyBackground: b.backgroundImage.slice(0, 40) || b.backgroundColor, fontFamily: b.fontFamily,
          styleSheets: document.styleSheets.length, js: document.getElementById('js')?.textContent ?? null, dataImg: i('dataimg'), fileImg: i('fileimg'),
          animation: spin ? getComputedStyle(spin).animationName : null, h1: document.querySelector('h1')?.textContent,
          viewport: innerWidth + 'x' + innerHeight, dpr: devicePixelRatio, zoom: visualViewport ? visualViewport.scale : null } })()`).catch((e: Error) => ({ error: e.message })),
      }))))

    // Browser author: the editor preview of the styled page, then published.
    await editPage(web, STYLED)
    await web.screenshot({ path: join(OUT, 'pg-01-browser-editor-styled.png') })
    await publish(web)
    await openPageOf(web, 'Webby')
    await web.screenshot({ path: join(OUT, 'pg-02-browser-own-styled.png') })
    await web.keyboard.press('Escape')

    // The desktop person joins.
    const desk = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, sz) => BrowserWindow.getAllWindows()[0].setContentSize(sz.width, sz.height), DESKTOP)
    await agreeToTerms(desk)
    await desk.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await desk.getByLabel('Your name').fill('Desk')
    await desk.getByRole('button', { name: 'Continue' }).click()
    await desk.getByRole('button', { name: 'I have an invite link' }).click()
    await desk.getByLabel('Invite link').fill(await createInviteLink(web))
    await desk.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(desk.getByRole('heading', { name: 'general' })).toBeVisible()

    // Desktop editor: the default page, then the styled one (both previews run in the walled view).
    await editPage(desk, 'template')
    report.deskEditorTemplate = await inspect()
    await desk.screenshot({ path: join(OUT, 'pg-03-desktop-editor-template.png') })
    await desk.getByLabel('Page HTML').fill(STYLED)
    await desk.waitForTimeout(2500)
    report.deskEditorStyled = await inspect()
    await desk.screenshot({ path: join(OUT, 'pg-04-desktop-editor-styled.png') })
    await desk.getByRole('button', { name: 'Start from the template' }).click()
    await publish(desk)

    // Desktop viewing someone else's styled page (scripts on, behind the wall), and its own default page.
    await openPageOf(desk, 'Webby')
    report.deskViewsStyled = await inspect()
    await desk.screenshot({ path: join(OUT, 'pg-05-desktop-views-styled.png') })
    report.deskFrameBox = await desk.locator('webview.page-frame').boundingBox()
    report.deskDpr = await desk.evaluate(() => devicePixelRatio)
    await desk.keyboard.press('Escape')
    await openPageOf(desk, 'Desk')
    report.deskViewsOwnTemplate = await inspect()
    await desk.screenshot({ path: join(OUT, 'pg-06-desktop-own-template.png') })
    // The window as Electron composites it (Playwright's page screenshot may place a <webview> differently).
    const real = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(join(OUT, 'pg-06b-desktop-own-template-capturepage.png'), Buffer.from(real, 'base64'))
    await desk.keyboard.press('Escape')

    // The browser viewing the desktop person's default page (no scripts for other people's pages).
    await openPageOf(web, 'Desk')
    await web.screenshot({ path: join(OUT, 'pg-07-browser-views-template.png') })
    await web.keyboard.press('Escape')
    // And a second browser person viewing the styled page.
    const other = await (await browser.newContext({ viewport: DESKTOP })).newPage()
    await joinVia(other, await createInviteLink(web), 'Otto')
    await openPageOf(other, 'Webby')
    await other.screenshot({ path: join(OUT, 'pg-08-browser-views-styled.png') })
  } finally {
    writeFileSync(join(OUT, 'pages-report.json'), JSON.stringify(report, null, 1))
    await app.close().catch(() => undefined)
    await server.stop()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

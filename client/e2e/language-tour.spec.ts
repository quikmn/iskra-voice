// Language tour: the main screens in one interface language, at desktop and phone width, so a translator can look for
// text that is cut off, overflows or reads wrong in place. See docs/translating.md.
//
//   ISKRA_UI_LANG=de ISKRA_E2E_PORT=5441 npx playwright test e2e/language-tour.spec.ts --workers=1 --retries 0
//
// ISKRA_UI_LANG is a registered language code, or `pseudo`: English with every word about 35% longer, to find layouts
// that break with long words before any translation exists. Not part of the normal run (skipped without the variable).
// Screenshots and findings.txt land in e2e/screenshots/lang-<code>/ (git-ignored). The tour clicks its way around in
// English and switches language only for each screenshot, so it works the same for every language.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { LANGUAGES } from '../src/i18n/languages'
import { agreeToTerms, createInviteLink, firstRun, hasLiveKit, joinVia, send, SHOTS, startServer, VOICE_JOIN, type TestServer } from './helpers'

const LANG = (process.env.ISKRA_UI_LANG ?? '').trim()
const PSEUDO = LANG === 'pseudo'
/** Only some parts: ISKRA_TOUR_ONLY=first-run,settings (part names start with these). */
const ONLY = (process.env.ISKRA_TOUR_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean)

test.skip(!LANG, 'Language tour: set ISKRA_UI_LANG=<code> (or pseudo)')
test.use({ actionTimeout: 10_000 })

const OUT = join(SHOTS, `lang-${LANG || 'none'}`)
const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }
type Size = 'desktop' | 'phone'

interface Finding { shot: string; size: Size; kind: string; where: string; text: string }
const findings: Finding[] = []
const problems: string[] = []
const pages: Page[] = []
let shots = 0

// ── Language ──

/**
 * Switches the app's language in place, through the dev server's own i18n module (the instance the app uses), so
 * there is no reload and whatever is open stays open. `pseudo` keeps English and lengthens every word.
 */
async function setLanguage(page: Page, language: string) {
  await page.evaluate(async ({ language, pseudo }) => {
    const path = '/src/i18n/index.ts'
    const m = (await import(/* @vite-ignore */ path)) as {
      setLanguageChoice(l: string): void
      i18next: { use(module: unknown): unknown; options: { postProcess?: string | string[] }; emit(event: string, ...args: unknown[]): void; language: string }
    }
    if (!pseudo) return m.setLanguageChoice(language)
    const w = window as unknown as { __stretch?: boolean }
    if (!w.__stretch) {
      w.__stretch = true
      // Words of three letters or more grow by about 35%; <tags> and their names are left alone.
      const stretch = (text: string) => text.replace(/(?<![<\/\p{L}])\p{L}{3,}/gu, (word) => word + 'ë'.repeat(Math.ceil(word.length * 0.35)))
      m.i18next.use({ type: 'postProcessor', name: 'stretch', process: (value: unknown) => (typeof value === 'string' ? stretch(value) : value) })
    }
    m.i18next.options.postProcess = language === 'pseudo' ? ['stretch'] : []
    m.i18next.emit('languageChanged', m.i18next.language) // components read their texts again
  }, { language, pseudo: PSEUDO })
  if (!PSEUDO) await expect(page.locator('html'), `the language "${language}" is not in client/src/i18n/languages.ts`).toHaveAttribute('lang', language)
}

// ── Checks ──

/**
 * Text that doesn't fit, as { key, kind, where, text }: `key` names the element whatever the language, so what English
 * already does (a channel name cut with "…" on purpose) can be left out.
 */
function layoutIssues(page: Page) {
  return page.evaluate(() => {
    const out: { key: string; kind: string; where: string; text: string }[] = []
    const width = window.innerWidth
    const seen = new Map<string, number>()
    const step = (el: Element) => {
      const classes = typeof el.className === 'string' ? el.className.split(/\s+/).filter((c) => c && !/^(active|selected|open|unread|hover|focus)/.test(c)).slice(0, 2).join('.') : ''
      return el.tagName.toLowerCase() + (classes ? `.${classes}` : '')
    }
    const pathOf = (el: Element) => {
      const parts: string[] = []
      for (let e: Element | null = el; e && e !== document.body && parts.length < 4; e = e.parentElement) parts.unshift(step(e))
      return parts.join(' > ')
    }
    const SKIP = '.message-text, .message-body, .rich-text, .docs-reader, pre, code, textarea, input, select, option, [contenteditable], svg, canvas, video, .sr-only, .visually-hidden'
    if (document.documentElement.scrollWidth > width + 1) {
      out.push({ key: 'page', kind: 'page scrolls sideways', where: 'html', text: `${document.documentElement.scrollWidth}px wide, the screen is ${width}px` })
    }
    for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
      if (el.closest(SKIP)) continue
      // Only elements that hold text themselves.
      const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join(' ').trim()
      if (!own) continue
      const rect = el.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
      // Hidden behind a clipping ancestor of no size (a closed drawer, an sr-only label).
      let shown = true
      let scroller = false
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p)
        const pr = p.getBoundingClientRect()
        if (ps.visibility === 'hidden' || Number(ps.opacity) === 0 || pr.width < 2 || pr.height < 2) { shown = false; break }
        if (/(auto|scroll)/.test(ps.overflowX) && p.scrollWidth > p.clientWidth + 1) scroller = true
        if (/(hidden|clip)/.test(ps.overflowX) && (rect.left >= pr.right || rect.right <= pr.left)) { shown = false; break }
      }
      if (!shown) continue
      const path = pathOf(el)
      const index = seen.get(path) ?? 0
      seen.set(path, index + 1)
      const key = `${path} #${index}`
      const add = (kind: string) => out.push({ key: `${kind}|${key}`, kind, where: path, text: own.replace(/\s+/g, ' ').slice(0, 80) })
      const clipsX = /(hidden|clip)/.test(style.overflowX)
      const clamped = style.webkitLineClamp !== 'none' && style.webkitLineClamp !== ''
      if (style.display !== 'inline') {
        if (el.scrollWidth > el.clientWidth + 1) {
          if (clipsX) add(style.textOverflow === 'ellipsis' ? 'cut with …' : 'cut off')
          else if (style.overflowX === 'visible' && !scroller) add('pokes out of its box')
        } else if (el.scrollHeight > el.clientHeight + 2 && /(hidden|clip)/.test(style.overflowY)) {
          add(clamped ? 'cut with …' : 'cut off (height)')
        }
      }
      if (!scroller && (rect.right > width + 2 || rect.left < -2) && rect.left < width && rect.right > 0) add('runs off the screen')
    }
    return out
  })
}

const settle = async (page: Page) => {
  await page.waitForTimeout(250)
  // Finite animations only (a spinner's never finishes), and never longer than a second.
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => null))),
    new Promise((r) => setTimeout(r, 1000)),
  ])).catch(() => undefined)
}

/**
 * Two screenshots of what's on screen in the tour's language, desktop and phone width, and its layout findings: what
 * doesn't fit in this language but did in English. Leaves the page as it was (desktop width, English).
 */
async function shot(page: Page, name: string, opts: { phone?: boolean } = {}) {
  const sizes: Size[] = opts.phone === false ? ['desktop'] : ['desktop', 'phone']
  const english = new Map<Size, Set<string>>()
  for (const size of sizes) {
    await page.setViewportSize(size === 'phone' ? PHONE : DESKTOP)
    await settle(page)
    english.set(size, new Set((await layoutIssues(page)).map((i) => i.key)))
  }
  await setLanguage(page, LANG)
  for (const size of [...sizes].reverse()) {
    await page.setViewportSize(size === 'phone' ? PHONE : DESKTOP)
    await settle(page)
    await page.screenshot({ path: join(OUT, `${name}-${size}.png`), animations: 'disabled' })
    shots++
    for (const issue of await layoutIssues(page)) {
      if (!english.get(size)!.has(issue.key)) findings.push({ shot: name, size, kind: issue.kind, where: issue.where, text: issue.text })
    }
  }
  await page.setViewportSize(DESKTOP)
  await setLanguage(page, 'en')
  await settle(page)
}

/** Runs one part of the tour. A failure is noted (and fails the test at the end), dialogs are closed, and the tour goes on. */
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

async function context(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: DESKTOP })
  ctx.on('page', (page) => pages.push(page))
  return ctx
}

const slug = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const channel = (page: Page, name: string) => page.locator('.channel-list .channel, .channel-list .voice-channel', { hasText: name }).first()

/** Every section of an open settings room, one after the other, named by its English label. */
async function everySection(page: Page, room: ReturnType<Page['getByRole']>, prefix: string) {
  const items = room.locator('.settings-nav-item')
  await expect(items.first()).toBeVisible()
  const labels = await room.locator('.settings-nav-item .settings-nav-label').allTextContents()
  for (const [i, label] of labels.entries()) {
    await items.nth(i).click()
    await expect(items.nth(i)).toHaveAttribute('aria-current', 'page')
    await shot(page, `${prefix}-${String(i + 1).padStart(2, '0')}-${slug(label)}`)
  }
}

let server: TestServer
test.beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  server = await startServer('Game Night', hasLiveKit())
})
test.afterAll(async () => {
  await server?.stop()
  // The same text cut in the same place on many screens (a banner, a sidebar) is listed once.
  const grouped = new Map<string, { first: Finding; more: number }>()
  for (const f of findings) {
    const key = [f.size, f.kind, f.where, f.text].join('|')
    const entry = grouped.get(key)
    if (entry) entry.more++
    else grouped.set(key, { first: f, more: 0 })
  }
  const lines = [...grouped.values()].map(({ first: f, more }) => `${f.shot}-${f.size}.png | ${f.kind} | ${f.where} | ${f.text}${more ? ` (and on ${more} more)` : ''}`)
  const head = [
    `Language tour: ${LANG}. ${shots} screenshots, ${lines.length} findings, ${problems.length} parts that could not be shot.`,
    'A finding is text that fits in English but not in this language on that screenshot. "cut with …" is often fine',
    '(names, long values); look at "cut off", "pokes out of its box", "runs off the screen" and "page scrolls sideways" first.',
    '',
  ]
  writeFileSync(join(OUT, 'findings.txt'), [...head, ...lines, ...(problems.length ? ['', 'Parts that failed:', ...problems] : [])].join('\n') + '\n')
  writeFileSync(join(OUT, 'findings.json'), JSON.stringify({ language: LANG, shots, problems, findings }, null, 1))
  const byKind = new Map<string, number>()
  for (const { first } of grouped.values()) byKind.set(first.kind, (byKind.get(first.kind) ?? 0) + 1)
  console.log(`\nLanguage tour (${LANG}): ${shots} screenshots in ${OUT}`)
  console.log(`Findings: ${lines.length ? [...byKind].map(([kind, n]) => `${n} × ${kind}`).join(', ') : 'none'} (findings.txt)`)
  if (problems.length) console.log(`Parts that failed:\n  ${problems.join('\n  ')}`)
})

test(`language tour: ${LANG || 'not set'}`, async ({ browser }) => {
  test.setTimeout(1_200_000)
  expect([...LANGUAGES, 'pseudo'], `ISKRA_UI_LANG=${LANG} is not a language in client/src/i18n/languages.ts`).toContain(LANG)

  // ── 1. First run: terms, new or returning, the recovery key, a name, no servers yet, join and start dialogs ──
  await part('first-run', async () => {
    const page = await (await context(browser)).newPage()
    await page.goto('/')
    await expect(firstRun(page)).toBeVisible()
    await shot(page, '01-welcome')
    await agreeToTerms(page)
    await shot(page, '02-new-or-returning')
    await page.getByRole('button', { name: /I already use Iskra/ }).click()
    await shot(page, '03-already-use-iskra')
    await page.getByRole('button', { name: /Use my recovery key/ }).click()
    await shot(page, '04-recovery-key')
    await page.getByRole('button', { name: 'Back' }).first().click()
    await page.getByRole('button', { name: "I'm new here" }).click()
    await shot(page, '05-your-name')
    await page.getByLabel('Your name').fill('Newcomer')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('No servers yet')).toBeVisible()
    await shot(page, '06-no-servers')
    await page.getByRole('button', { name: /Start your own server/ }).click()
    await shot(page, '07-start-your-own-server')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'I have an invite link' }).click()
    await shot(page, '08-join-a-server')
    await page.getByLabel('Invite link').fill('not a link')
    await page.getByRole('button', { name: 'Join', exact: true }).click().catch(() => undefined)
    await shot(page, '09-join-bad-link', { phone: false })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Direct messages' }).click()
    await shot(page, '10-friends-empty')
    await page.context().close()
  })

  // ── 2. An invite, then the server: channel list, chat, the message menu, the usual dialogs ──
  const owner = await (await context(browser)).newPage()
  await owner.goto(server.ownerLink())
  await expect(owner.getByText("You've been invited")).toBeVisible()
  await part('invite', () => shot(owner, '11-invited'))
  await agreeToTerms(owner)
  await owner.getByRole('button', { name: /I'm new to Iskra/ }).click()
  await part('invite', () => shot(owner, '12-invited-your-name'))
  await owner.getByLabel('Your name').fill('Viktor')
  await owner.getByRole('button', { name: 'Join' }).click()
  await expect(owner.getByRole('heading', { name: 'general', exact: true })).toBeVisible({ timeout: 15_000 })
  await part('server', () => shot(owner, '13-new-server'))

  const member = await (await context(browser)).newPage()
  await joinVia(member, await createInviteLink(owner), 'Alice')

  await part('server-chat', async () => {
    await send(owner, 'Welcome to **Game Night**! Who is in for Valheim on Friday?')
    await send(member, 'Me! @Viktor I can bring the mead')
    await send(owner, 'Great. Patch notes: https://example.com/patch-notes-for-the-big-update')
    await expect(owner.locator('.message', { hasText: 'bring the mead' })).toBeVisible()
    await shot(owner, '14-chat')
    const message = owner.locator('.message', { hasText: 'bring the mead' }).first()
    await message.hover()
    await shot(owner, '15-message-hover', { phone: false })
    await message.hover()
    await message.getByRole('button', { name: 'More', exact: true }).click()
    await expect(owner.getByRole('menu').first()).toBeVisible()
    await shot(owner, '16-message-menu')
    await owner.keyboard.press('Escape')
    // The same message on a phone-sized screen: its drawer of channels.
    await owner.setViewportSize(PHONE)
    const drawer = owner.getByRole('button', { name: /Open (channels|menu)/ }).first()
    if (await drawer.isVisible().catch(() => false)) {
      await drawer.click()
      await setLanguage(owner, LANG)
      await settle(owner)
      await owner.screenshot({ path: join(OUT, '17-channel-list-phone.png'), animations: 'disabled' })
      shots++
      await setLanguage(owner, 'en')
      await owner.keyboard.press('Escape')
    }
    await owner.setViewportSize(DESKTOP)
    await owner.reload()
    await expect(owner.getByRole('heading', { name: 'general', exact: true })).toBeVisible({ timeout: 15_000 })
  })
  await part('server-dialogs', async () => {
    await owner.getByRole('button', { name: 'Invite friends' }).click()
    await expect(owner.locator('.copy-row input')).toHaveValue(/#\/join\//)
    await shot(owner, '18-invite-friends')
    await owner.keyboard.press('Escape')
    await owner.locator('.server-header-button').click()
    await shot(owner, '19-server-menu')
    await owner.keyboard.press('Escape')
    await owner.getByRole('button', { name: 'Create channel' }).first().click()
    await shot(owner, '20-create-channel')
    await owner.getByRole('dialog', { name: 'Create channel' }).getByRole('radio', { name: 'Voice' }).click()
    await shot(owner, '21-create-voice-channel')
    await owner.keyboard.press('Escape')
    await owner.locator('.server-rail').getByRole('button', { name: 'Join a server' }).click()
    await shot(owner, '22-join-or-start-a-server')
    await owner.keyboard.press('Escape')
    await owner.locator('.events-button').click()
    await shot(owner, '23-events')
    await owner.keyboard.press('Escape')
  })

  // ── 3. Voice: the call, then the voice bar while reading a text channel ──
  if (hasLiveKit()) {
    await part('voice', async () => {
      await owner.getByRole('button', { name: 'Create channel' }).first().click()
      const create = owner.getByRole('dialog', { name: 'Create channel' })
      await create.getByRole('radio', { name: 'Voice' }).click()
      await create.getByLabel('Name').fill('lounge')
      await create.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(create).toHaveCount(0)
      for (const p of [owner, member]) await channel(p, 'lounge').getByRole('button').first().click()
      await expect(owner.locator('.call-controls')).toBeVisible(VOICE_JOIN)
      await owner.waitForTimeout(1000)
      await shot(owner, '30-voice-call')
      await channel(owner, 'general').click()
      await expect(owner.locator('.voice-controls')).toBeVisible()
      await shot(owner, '31-voice-bar')
      await owner.locator('.voice-controls').getByRole('button', { name: 'Leave voice' }).click()
      await member.locator('.voice-controls, .call-controls').getByRole('button', { name: /Leave/ }).first().click()
    })
  }

  // ── 4. My settings and Server settings: every section ──
  await part('settings-mine', async () => {
    await owner.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true }).click()
    const room = owner.getByRole('dialog', { name: 'Settings' })
    await expect(room).toBeVisible()
    await everySection(owner, room, '40-my-settings')
    await owner.keyboard.press('Escape')
    await expect(room).toHaveCount(0)
  })
  await part('settings-server', async () => {
    await owner.locator('.server-header-button').click()
    await owner.getByRole('menuitem', { name: 'Server settings', exact: true }).click()
    const room = owner.getByRole('dialog', { name: /· Server settings$/ })
    await expect(room).toBeVisible()
    await everySection(owner, room, '50-server-settings')
    await owner.keyboard.press('Escape')
    await expect(room).toHaveCount(0)
  })

  expect(problems, 'parts of the tour that could not be shot').toEqual([])
  expect(shots).toBeGreaterThan(0)
})

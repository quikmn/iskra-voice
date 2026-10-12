// Accessibility: axe-core on the main screens. Serious and critical violations fail the test; moderate and minor
// ones are listed in the report (e2e/screenshots/a11y-report.json) for design/A11Y_REVIEW.md.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { BUILT_IN_THEMES } from '../src/theme/themes'
import { createInviteLink, hasLiveKit, joinVia, openServerSettings, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('A11y Test', hasLiveKit())
})
test.afterAll(async () => server?.stop())

interface Found { screen: string; id: string; impact: string; help: string; nodes: string[] }
const found: Found[] = []

/** Runs axe on what's on screen now (or only inside `include`) and records what it finds. */
async function audit(page: Page, screen: string, options: { include?: string; rules?: string[] } = {}) {
  // Let entry animations finish so colours are measured at rest.
  await page.waitForTimeout(400)
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
  if (options.include) builder = builder.include(options.include)
  if (options.rules) builder = builder.withRules(options.rules)
  const result = await builder.analyze()
  for (const v of result.violations) {
    found.push({ screen, id: v.id, impact: v.impact ?? 'minor', help: v.help, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n').slice(1, 2).join(' ').trim() ?? ''}`) })
  }
}

test.afterAll(() => {
  writeFileSync(join(SHOTS, 'a11y-report.json'), JSON.stringify(found, null, 2))
})

test('main screens have no serious accessibility problems', async ({ browser }) => {
  test.setTimeout(240_000)
  const page = await (await browser.newContext()).newPage()

  // Onboarding: the invite screen before joining.
  await page.goto(server.ownerLink())
  await expect(page.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible({ timeout: 15_000 })
  await audit(page, 'onboarding')

  await joinVia(page, server.ownerLink(), 'Host')
  ownerPage = page
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(page), 'Friend')
  await send(friend, 'hello there, **bold** and a link https://iskra.foo')
  await send(page, 'hi back')
  await expect(page.locator('.message-text', { hasText: 'hello there' })).toBeVisible()

  // A server's text channel.
  await audit(page, 'text channel')

  // The server menu.
  await page.locator('.server-header-button').click()
  await expect(page.getByRole('menuitem', { name: 'Server settings', exact: true })).toBeVisible()
  await audit(page, 'server menu')
  await page.keyboard.press('Escape')

  // The emoji picker.
  await page.getByRole('button', { name: 'Emoji', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Emoji picker' })).toBeVisible()
  await audit(page, 'emoji picker')
  await page.keyboard.press('Escape')

  // The profile card.
  await page.locator('.member-list').getByRole('button', { name: /Friend/ }).click()
  await expect(page.getByRole('dialog', { name: 'Profile of Friend' })).toBeVisible()
  await audit(page, 'profile card')
  await page.keyboard.press('Escape')

  // The server room, a few sections.
  const room = await openServerSettings(page)
  await audit(page, 'server room: overview')
  for (const section of ['Channels', 'Members', 'Roles', 'Limits']) {
    await room.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click()
    await audit(page, `server room: ${section.toLowerCase()}`)
  }
  await page.keyboard.press('Escape')
  await expect(room).toHaveCount(0)

  // My settings.
  await openSettings(page)
  await audit(page, 'my settings: profile')
  for (const section of ['Appearance', 'Notifications', 'Voice & audio', 'Privacy & data']) {
    await openSettingsSection(page, section)
    await audit(page, `my settings: ${section.toLowerCase()}`)
  }
  await page.keyboard.press('Escape')

  // DMs: the friend starts one from Host's profile card.
  await friend.locator('.member-list').getByRole('button', { name: /Host/ }).click()
  await friend.getByRole('button', { name: 'Add friend' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await friend.getByPlaceholder('Message Host').fill('a direct hello')
  await friend.getByPlaceholder('Message Host').press('Enter')
  await page.getByRole('button', { name: 'Direct messages' }).click()
  await page.locator('.dm-row', { hasText: 'Friend' }).click()
  await expect(page.locator('.message-text', { hasText: 'a direct hello' })).toBeVisible()
  await audit(page, 'dm')

  // Friends.
  await page.locator('.channel', { hasText: 'Friends' }).click()
  await audit(page, 'friends')
  await page.getByRole('tab', { name: 'Pending' }).click()
  await audit(page, 'friends: pending')

  // A voice channel, in a call.
  if (hasLiveKit()) {
    await page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: /A11y Test/ }).first().click()
    await page.getByRole('button', { name: 'Create voice channel' }).click()
    await page.getByRole('radio', { name: 'Voice' }).click()
    await page.getByLabel('Name').fill('lounge')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const lounge = page.locator('.voice-channel', { hasText: 'lounge' })
    await lounge.getByRole('button').first().click()
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
    await expect(page.locator('.stage')).toBeVisible()
    await audit(page, 'voice call')
  }

  // Colours in every built-in theme (contrast only), on a text channel.
  await page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: /A11y Test/ }).first().click()
  await page.locator('.channel', { hasText: 'general' }).first().click()
  for (const { id, theme } of BUILT_IN_THEMES) {
    await openSettings(page, 'Appearance')
    await page.getByRole('radio', { name: id === 'iskra' ? `${theme.meta.name} (default)` : theme.meta.name, exact: true }).click()
    await page.keyboard.press('Escape')
    await audit(page, `theme ${theme.meta.name}: text channel`, { rules: ['color-contrast'] })
  }
  await page.screenshot({ path: join(SHOTS, 'a11y-last-theme.png') })

  const blocking = found.filter((f) => f.impact === 'serious' || f.impact === 'critical')
  const summary = found.map((f) => `[${f.impact}] ${f.screen}: ${f.id} (${f.help})\n    ${f.nodes.join('\n    ')}`).join('\n')
  console.log(summary || 'no violations')
  expect(blocking, summary).toEqual([])
})

/** A light theme (there's no built-in one), to audit the light-scheme styles. */
const DAYLIGHT = {
  meta: { name: 'Daylight', scheme: 'light' },
  colors: {
    bgDeep: '#e3e5e8', bgSurface: '#e3e5e8', bgBody: '#ebedf0', bgSidebar: '#f2f3f5', bgSidebarHover: '#e6e8eb', bgChat: '#ffffff',
    bgFloat: '#ffffff', bgButton: '#e9eaee', bgHover: '#eef0f3', bgActive: '#dfe1e6', bgBorder: 'rgba(20, 20, 60, 0.14)',
    textHeading: '#060607', textNormal: '#2e3338', textMuted: '#4f5660', textSubtle: '#5c626b', textFaint: '#9aa0a8',
    accent: '#4752c4', accentHover: '#3c45a5', success: '#1a7f37', danger: '#c62828', warning: '#8a5a00', link: '#0b62c4',
  },
}

test('dialogs and a light theme have no serious accessibility problems', async ({ browser }) => {
  test.setTimeout(240_000)
  if (!ownerPage) await inviteFromOwner(browser)
  const page = ownerPage!
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(page), 'Robin')
  await send(friend, 'something to report')
  // Dialogs are audited on their own: what's behind the backdrop is covered (and checked on its own screen).
  const opened = async (name: string | RegExp) => {
    const dialog = page.getByRole('dialog', { name }).last()
    await expect(dialog).toBeVisible()
    await page.evaluate(() => document.querySelectorAll('[data-audit]').forEach((el) => el.removeAttribute('data-audit')))
    await dialog.evaluate((el) => el.setAttribute('data-audit', ''))
    return dialog
  }
  const inDialog = { include: '[data-audit]' }

  // Invite.
  await page.getByRole('button', { name: 'Invite friends' }).click()
  await opened(/^Invite/)
  await audit(page, 'dialog: invite', inDialog)
  await page.keyboard.press('Escape')

  // Create channel (a voice one, for the call below).
  await page.getByRole('button', { name: 'Create voice channel' }).click()
  await opened('Create channel')
  await audit(page, 'dialog: create channel', inDialog)
  await page.getByRole('radio', { name: 'Voice' }).click()
  await page.getByLabel('Name').fill('hangout')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  // A category: its dialog, then left and right close and open it from the keyboard.
  await page.getByRole('button', { name: 'Create category' }).click()
  await opened('Create category')
  await audit(page, 'dialog: create category', inDialog)
  await page.getByLabel('Name').fill('Games')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const toggle = page.locator('.org-category-toggle', { hasText: 'Games' })
  await toggle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  // Server nickname.
  await page.locator('.server-header-button').click()
  await page.getByRole('menuitem', { name: 'Server nickname…' }).click()
  await expect(page.getByLabel('Server nickname', { exact: true })).toBeVisible()
  await page.getByLabel('Server nickname', { exact: true }).evaluate((el) => el.closest('[role="dialog"]')?.setAttribute('data-audit-nick', ''))
  await audit(page, 'dialog: server nickname', { include: '[data-audit-nick]' })
  await page.keyboard.press('Escape')

  // Report a message.
  const message = page.locator('.message', { hasText: 'something to report' }).last()
  await message.hover()
  await message.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menu', { name: 'Message options' }).getByRole('menuitem', { name: 'Report message' }).click()
  await opened('Report message')
  await audit(page, 'dialog: report', inDialog)
  await page.keyboard.press('Escape')

  // The profile page editor.
  await openSettings(page)
  await page.getByRole('button', { name: /Make a page|Edit page/ }).click()
  await expect(page.getByLabel('Page HTML')).toBeVisible()
  await page.getByLabel('Page HTML').evaluate((el) => el.closest('[role="dialog"]')?.setAttribute('data-audit-page', ''))
  await audit(page, 'dialog: profile page editor', { include: '[data-audit-page]' })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  // In a call: the soundboard, the screen-share menu and the captions prompt.
  if (hasLiveKit()) {
    await page.locator('.voice-channel', { hasText: 'hangout' }).getByRole('button').first().click()
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
    const controls = page.locator('.call-controls')
    await controls.getByRole('button', { name: 'Soundboard' }).click()
    await opened('Soundboard')
    await audit(page, 'dialog: soundboard', inDialog)
    await page.keyboard.press('Escape')
    await controls.getByRole('button', { name: 'Share your screen' }).click()
    await opened('Share your screen')
    await audit(page, 'dialog: screen-share menu', inDialog)
    await page.keyboard.press('Escape')
    const captions = controls.getByRole('button', { name: 'Show captions' })
    if (await captions.isVisible()) {
      await captions.click()
      await expect(page.getByRole('region', { name: 'Live captions' })).toBeVisible()
      await audit(page, 'captions consent')
      await controls.getByRole('button', { name: 'Hide captions' }).click()
    }
    await page.getByRole('button', { name: 'Leave voice' }).first().click()
  }

  // A light theme: contrast on a text channel and in settings.
  await page.locator('.channel', { hasText: 'general' }).first().click()
  await openSettings(page, 'Appearance')
  await page.getByRole('button', { name: 'Write your own' }).click()
  await page.getByLabel('Theme JSON').fill(JSON.stringify(DAYLIGHT))
  await expect(page.getByTestId('theme-contrast')).toHaveCount(0)
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'light')
  await audit(page, 'light theme: appearance', { rules: ['color-contrast'] })
  await page.keyboard.press('Escape')
  await audit(page, 'light theme: text channel', { rules: ['color-contrast'] })
  await page.screenshot({ path: join(SHOTS, 'a11y-light-theme.png') })

  // The theme editor warns about text that's hard to read, with the ratio and a fix.
  await openSettings(page, 'Appearance')
  await page.getByRole('button', { name: 'Write your own' }).click()
  await page.getByLabel('Theme JSON').fill(JSON.stringify({ ...DAYLIGHT, colors: { ...DAYLIGHT.colors, textSubtle: '#b0b4ba' } }))
  const warning = page.getByTestId('theme-contrast')
  await expect(warning).toContainText(/textSubtle on bgChat: 2\.\d\d:1/)
  await page.screenshot({ path: join(SHOTS, 'a11y-theme-contrast.png') })
  await warning.getByRole('button', { name: /for textSubtle/ }).click()
  await expect(warning).toHaveCount(0)
  // Back to the default look.
  await page.getByRole('radio', { name: /\(default\)/ }).click()
  await page.keyboard.press('Escape')

  const blocking = found.filter((f) => (f.impact === 'serious' || f.impact === 'critical') && (f.screen.startsWith('dialog') || f.screen.startsWith('light') || f.screen.startsWith('captions')))
  const summary = blocking.map((f) => `[${f.impact}] ${f.screen}: ${f.id} (${f.help})\n    ${f.nodes.join('\n    ')}`).join('\n')
  expect(blocking, summary).toEqual([])
})

async function openSettingsSection(page: Page, section: string) {
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click()
}

test('keyboard and screen reader basics', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage()
  await joinVia(page, await inviteFromOwner(browser), 'Kim')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(page), 'Lee')

  // The skip link comes first, before the server rail; it jumps to the main column.
  await page.getByRole('navigation', { name: 'Servers' }).getByRole('button').first().focus()
  await page.keyboard.press('Shift+Tab')
  const skip = page.getByRole('button', { name: 'Skip to main content' })
  await expect(skip).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main-content')).toBeFocused()

  // The server menu: Enter opens it on its first item, arrows move, Escape closes it and focus goes back.
  const opener = page.locator('.server-header-button')
  await opener.focus()
  await page.keyboard.press('Enter')
  const items = page.getByRole('menuitem')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await page.keyboard.press('End')
  await expect(items.last()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem')).toHaveCount(0)
  await expect(opener).toBeFocused()

  // New messages from others are announced politely, with who wrote them.
  await send(friend, 'can you hear me now')
  await expect(page.locator('[data-testid="announcer"]')).toHaveText('Lee: can you hear me now')
  await expect(page.locator('[data-testid="announcer"]')).toHaveAttribute('aria-live', 'polite')

  // The message list: arrows go from the list to the newest message and back up; Tab reaches its actions.
  const list = page.getByRole('region', { name: 'Messages in #general' })
  await list.focus()
  await page.keyboard.press('ArrowUp')
  const newest = page.getByRole('article', { name: /^Lee, / }).last()
  await expect(newest).toBeFocused()
  await expect(newest).toContainText('can you hear me now')
  // Tab goes through the message (profile, name) to its actions, which show while it has focus.
  const addReaction = newest.getByRole('toolbar', { name: 'Message actions' }).getByRole('button', { name: 'Add reaction' })
  for (let i = 0; i < 4 && !(await addReaction.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(addReaction).toBeFocused()
  await expect(addReaction).toBeVisible()
  // The quick reactions are a row: focus starts on the first, Escape goes back to the button.
  await page.keyboard.press('Enter')
  const reactions = page.getByRole('menu', { name: 'Add reaction' })
  await expect(reactions.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(reactions.getByRole('menuitem').nth(1)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(newest.getByRole('button', { name: 'Add reaction' })).toBeFocused()

  // The emoji picker: down from the search into the grid, arrows across it, Escape back to the button.
  const emojiButton = page.getByRole('button', { name: 'Emoji', exact: true })
  await emojiButton.focus()
  await page.keyboard.press('Enter')
  const picker = page.getByRole('dialog', { name: 'Emoji picker' })
  await expect(picker.getByLabel('Search emoji')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  const cells = picker.locator('.emoji-cell')
  await expect(cells.first()).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(cells.nth(1)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  expect(await page.evaluate(() => document.activeElement?.getBoundingClientRect().top))
    .toBeGreaterThan(await cells.nth(1).evaluate((el) => el.getBoundingClientRect().top))
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(emojiButton).toBeFocused()

  // Server icons are named by the server, not its initials.
  const rail = page.getByRole('navigation', { name: 'Servers' })
  const serverIcon = rail.getByRole('button', { name: 'A11y Test' })
  await expect(serverIcon).toBeVisible()

  // The rail is one Tab stop (the open server, or the last icon used); arrows move, the context-menu key opens a
  // server's menu.
  await expect(rail.locator('button[tabindex="0"]')).toHaveCount(1)
  await serverIcon.focus()
  await expect(serverIcon).toHaveAttribute('tabindex', '0')
  await expect(rail.getByRole('button', { name: 'Direct messages' })).toHaveAttribute('tabindex', '-1')
  await page.keyboard.press('ArrowUp')
  await expect(serverIcon).not.toBeFocused()
  expect(await rail.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('ArrowDown')
  await expect(serverIcon).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(serverIcon).toBeFocused()

  // The channel list too: one Tab stop (the open channel, or the last row used) plus that row's own ⋯ button;
  // arrows move between rows.
  const channels = page.getByRole('navigation', { name: 'A11y Test channels' })
  const general = channels.locator('button.channel', { hasText: 'general' })
  await expect(channels.locator('.channel-list [tabindex="0"]:is(.channel, .org-category-toggle, .invite-button, .reports-button)')).toHaveCount(1)
  await general.focus()
  await expect(general).toHaveAttribute('tabindex', '0')
  await expect(channels.getByRole('button', { name: '#general options' })).toHaveAttribute('tabindex', '0')
  await expect(channels.getByRole('button', { name: 'Invite friends' })).toHaveAttribute('tabindex', '-1')
  await page.keyboard.press('ArrowUp')
  await expect(general).not.toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(general).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(general).toBeFocused()

  // Less motion when asked: animations and transitions are effectively off.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const duration = await page.locator('.message').first().evaluate((el) => getComputedStyle(el).transitionDuration)
  expect(parseFloat(duration)).toBeLessThan(0.01)
})

/** A fresh invite link made by a new owner page (the owner link works once). */
async function inviteFromOwner(browser: import('@playwright/test').Browser): Promise<string> {
  if (!ownerPage) {
    ownerPage = await (await browser.newContext()).newPage()
    await joinVia(ownerPage, server.ownerLink(), 'Owner')
  }
  return createInviteLink(ownerPage)
}
let ownerPage: Page | null = null

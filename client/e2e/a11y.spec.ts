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
  await expect(page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: 'A11y Test' })).toBeVisible()

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

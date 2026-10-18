import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Fav Test')
})
test.afterAll(async () => {
  await server?.stop()
})

test('tables and small text in chat, favorite channels on Home', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage()
  await joinVia(page, server.ownerLink(), 'Fan')

  // ── Tables and -# small text ──
  await send(page, '| Game | Players | Note |\n|:---|:---:|---:|\n| **Chess** | 2 | `a|b` |\n| Uno | 4 | _fun_ |\n-# only for friends')
  const table = page.locator('.md-table').last()
  await expect(table.locator('th')).toHaveText(['Game', 'Players', 'Note'])
  await expect(table.locator('tbody tr')).toHaveCount(2)
  await expect(table.locator('td strong')).toHaveText('Chess')
  await expect(table.locator('td code')).toHaveText('a|b')
  await expect(page.locator('.md-subtext').last()).toHaveText('only for friends')
  await send(page, '```\n| not | a table |\n|---|---|\n```')
  await expect(page.locator('.md-table')).toHaveCount(1)
  await page.screenshot({ path: join(SHOTS, 'tables-desktop.png') })

  // At phone width a wide table scrolls inside the message; the page itself never gets wider.
  await send(page, '| ' + Array.from({ length: 10 }, (_, i) => `Column number ${i}`).join(' | ') + ' |\n|' + '---|'.repeat(10) + '\n| ' + Array.from({ length: 10 }, () => 'some long cell text').join(' | ') + ' |')
  await page.setViewportSize({ width: 390, height: 800 })
  const wrap = page.locator('.md-table-wrap').last()
  await expect(wrap).toBeVisible()
  expect(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.waitForTimeout(600) // the phone layout slides in
  await page.screenshot({ path: join(SHOTS, 'tables-phone.png') })
  await page.setViewportSize({ width: 1280, height: 800 })

  // ── Favorites: star two channels from the channel menu (one by keyboard) ──
  const general = page.locator('.org-row', { has: page.locator('.channel-name', { hasText: /^general$/ }) }).first()
  await general.locator('.channel').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add to favorites' }).click()

  await page.getByRole('button', { name: 'Create channel' }).first().click()
  const create = page.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: 'Text' }).click()
  await create.getByPlaceholder('game-night').fill('lounge')
  await create.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(create).toHaveCount(0)
  const other = page.locator('.org-row', { has: page.getByRole('button', { name: 'lounge', exact: true }) })
  await other.hover()
  await other.getByRole('button', { name: '#lounge options' }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Add to favorites' }).click()

  await page.getByRole('button', { name: 'Direct messages' }).click()
  const section = page.getByRole('group', { name: 'Favorites' })
  await expect(section.getByTestId('favorite')).toHaveCount(2)
  const names = await section.locator('.fav-row .channel-name').allTextContents()
  expect(names).toEqual(['general', 'lounge'])
  await page.screenshot({ path: join(SHOTS, 'favorites-home.png') })

  // Reorder with the arrows, then remove one.
  await section.getByRole('button', { name: 'Edit' }).click()
  await section.getByRole('button', { name: /^Move #?general down/ }).click()
  await expect(section.locator('.fav-row .channel-name').last()).toHaveText('general')
  await page.screenshot({ path: join(SHOTS, 'favorites-edit.png') })
  await section.getByRole('button', { name: /^Remove #?general from favorites/ }).click()
  await expect(section.getByTestId('favorite')).toHaveCount(1)

  // Kept after a reload, and a click jumps to the channel.
  await page.reload()
  await page.getByRole('button', { name: 'Direct messages' }).click()
  const kept = page.getByRole('group', { name: 'Favorites' }).getByTestId('favorite')
  await expect(kept).toHaveCount(1)
  const name = (await kept.locator('.channel-name').textContent())!
  await kept.locator('.channel').click()
  await expect(page.locator('.channel-list .channel.active .channel-name')).toHaveText(name)

  // Unstar from the menu: the section goes away.
  const here = page.locator('.org-row:not(.fav-row)', { has: page.locator('.channel.active') })
  await here.locator('.channel').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove from favorites' }).click()
  await page.getByRole('button', { name: 'Direct messages' }).click()
  await expect(page.getByRole('group', { name: 'Favorites' })).toHaveCount(0)
})

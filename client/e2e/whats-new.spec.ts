import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { RELEASE_VERSION } from '../src/links'
import { joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Whats New Test')
})
test.afterAll(async () => server?.stop())

const SEEN = 'iskra.whats-new-seen'

test("What's new: once after an update, never on a fresh install", async ({ page }) => {
  // A fresh install: nothing, and this version is remembered.
  await joinVia(page, server.ownerLink(), 'Ann')
  const card = page.getByTestId('whats-new')
  await expect(card).toHaveCount(0)
  expect(await page.evaluate((key) => localStorage.getItem(key), SEEN)).toBe(RELEASE_VERSION)

  // The app was on an older version before: the card, with this release's highlights and a link to the full notes.
  await page.evaluate((key) => localStorage.setItem(key, '2.0.0-alpha.1'), SEEN)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 15_000 })
  await expect(card.getByRole('heading', { name: `What's new in Iskra ${RELEASE_VERSION}` })).toBeVisible()
  expect(await card.locator('li').count()).toBeGreaterThan(0)
  await expect(card.getByRole('link', { name: 'Full release notes' }))
    .toHaveAttribute('href', `https://github.com/quikmn/iskra-voice/releases/tag/v${RELEASE_VERSION}`)
  await page.screenshot({ path: join(SHOTS, 'whats-new.png') })

  // Phone width: still fits.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(500) // the layout settles into its phone form
  const box = await card.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
  await page.screenshot({ path: join(SHOTS, 'whats-new-phone.png') })
  await page.setViewportSize({ width: 1280, height: 800 })

  await card.getByRole('button', { name: 'Got it' }).click()
  await expect(card).toHaveCount(0)

  // Once: a reload doesn't bring it back.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 15_000 })
  await expect(card).toHaveCount(0)

  // In Swedish: a Swedish heading over the English lines (no Swedish notes file); the close button dismisses it too.
  await page.evaluate((key) => {
    localStorage.setItem(key, '2.0.0-alpha.1')
    localStorage.setItem('iskra.language', 'sv')
  }, SEEN)
  await page.reload()
  await expect(card.getByRole('heading', { name: `Nytt i Iskra ${RELEASE_VERSION}` })).toBeVisible({ timeout: 15_000 })
  await card.getByRole('button', { name: 'Stäng' }).click()
  await expect(card).toHaveCount(0)
})

// "Share to Iskra" from another app, at phone width. The phone app hands the page a share through receiveShare
// (state/shareIn.ts); here the test calls the same entry point (window.iskraShare) with files the page can fetch.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer } from './helpers'

/** What the Android app sends: copies of the files at URLs on the page's own origin (blob: URLs stand in here). */
async function shareIn(page: Page, share: { id: string; text?: string; subject?: string; files?: { name: string; type: string; picture?: boolean; text?: string }[]; skipped?: number }) {
  await page.waitForFunction(() => typeof (window as { iskraShare?: unknown }).iskraShare === 'function')
  return page.evaluate(async (share) => {
    const picture = async () => {
      const canvas = new OffscreenCanvas(480, 320)
      const g = canvas.getContext('2d')!
      const fill = g.createLinearGradient(0, 0, 480, 320)
      fill.addColorStop(0, '#f6c453')
      fill.addColorStop(1, '#e0703c')
      g.fillStyle = fill
      g.fillRect(0, 0, 480, 320)
      return canvas.convertToBlob({ type: 'image/png' })
    }
    const files = await Promise.all((share.files ?? []).map(async (f) => {
      const blob = f.picture ? await picture() : new Blob([f.text ?? ''], { type: f.type })
      return { name: f.name, type: f.type, size: blob.size, url: URL.createObjectURL(blob) }
    }))
    return (window as unknown as { iskraShare: (raw: unknown) => boolean }).iskraShare({ ...share, files })
  }, share)
}

test('share to Iskra: pick a channel or a person, with a message and files; cancel discards', async ({ browser }) => {
  const server = await startServer('Share Club')
  try {
    const host = await (await browser.newContext()).newPage()
    await joinVia(host, server.ownerLink(), 'Host')
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
    await joinVia(phone, await createInviteLink(host), 'Pia')

    // ── A link with its page title, a photo and a file, to #general ──
    expect(await shareIn(phone, {
      id: 'one', text: 'https://example.invalid/recipe', subject: 'Best pancakes',
      files: [{ name: 'pancakes.png', type: 'image/png', picture: true }, { name: 'shopping.txt', type: 'text/plain', text: 'eggs, milk, flour' }],
      skipped: 1,
    })).toBe(true)
    const picker = phone.getByRole('dialog', { name: 'Share to…' })
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('img', { name: 'pancakes.png' })).toBeVisible()
    await expect(picker.getByText('shopping.txt')).toBeVisible()
    await expect(picker.getByText('1 file couldn’t be added')).toBeVisible()
    await expect(picker.getByLabel('Message')).toHaveValue('Best pancakes\nhttps://example.invalid/recipe')
    // Nothing is chosen yet, so nothing can be sent.
    await expect(picker.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await phone.screenshot({ path: join(SHOTS, 'share-in-picker-phone.png'), animations: 'disabled' })

    await picker.getByLabel('Message').fill('Best pancakes\nhttps://example.invalid/recipe\nSunday?')
    await picker.getByRole('radio', { name: /^#general, Share Club/ }).click()
    await expect(picker.getByRole('radio', { name: /^#general/ })).toHaveAttribute('aria-checked', 'true')
    await picker.getByRole('button', { name: 'Send to #general' }).click()
    await expect(picker).toHaveCount(0)
    const sent = (page: Page) => page.locator('.message', { hasText: 'Sunday?' })
    await expect(sent(phone).locator('.attachments')).toBeVisible()
    await expect(sent(phone).getByText('shopping.txt')).toBeVisible()
    await expect(sent(host).getByText('shopping.txt')).toBeVisible()
    await expect(sent(host).locator('.attachment-image, .attachments img').first()).toBeVisible()
    await phone.screenshot({ path: join(SHOTS, 'share-in-sent-phone.png'), animations: 'disabled' })

    // ── Text only, to a person found by search: an end-to-end encrypted DM ──
    await shareIn(phone, { id: 'two', text: 'Look at this when you can' })
    await expect(picker).toBeVisible()
    // #general is recent now.
    await expect(picker.getByRole('heading', { name: 'Recent' })).toBeVisible()
    await expect(picker.getByRole('radio').first()).toHaveAccessibleName(/^#general/)
    // People show when you search.
    await expect(picker.getByRole('radio', { name: /^Host, Direct message/ })).toHaveCount(0)
    await picker.getByLabel('Search channels, people and groups').fill('hos')
    await picker.getByRole('radio', { name: /^Host, Direct message/ }).click()
    await picker.getByRole('button', { name: 'Send to Host' }).click()
    await expect(picker).toHaveCount(0)
    await expect(phone.getByRole('heading', { name: 'Host', level: 1 })).toBeVisible()
    await expect(phone.locator('.message-text', { hasText: 'Look at this when you can' })).toBeVisible()
    await host.getByRole('button', { name: 'Direct messages' }).click()
    await host.locator('.dm-row', { hasText: 'Pia' }).click()
    await expect(host.locator('.message-text', { hasText: 'Look at this when you can' })).toBeVisible()

    // ── Cancel discards ──
    await shareIn(phone, { id: 'three', text: 'never mind this' })
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: 'Cancel' }).click()
    await expect(picker).toHaveCount(0)
    await phone.waitForTimeout(500)
    await expect(phone.getByText('never mind this')).toHaveCount(0)
    await expect(host.getByText('never mind this')).toHaveCount(0)

    // ── A share that arrives while the app is still starting (a cold start): the places fill in once connected ──
    await phone.reload()
    await shareIn(phone, { id: 'four', text: 'from a cold start' })
    await expect(picker).toBeVisible()
    await picker.getByRole('radio', { name: /^#general/ }).click()
    await picker.getByRole('button', { name: 'Send to #general' }).click()
    await expect(picker).toHaveCount(0)
    await expect(phone.locator('.message', { hasText: 'from a cold start' })).toBeVisible()
    await host.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: 'Share Club' }).click()
    await expect(host.locator('.message', { hasText: 'from a cold start' })).toBeVisible()
  } finally {
    await server.stop()
  }
})

test('share to Iskra: files must come from the app itself', async ({ browser }) => {
  const server = await startServer('Share Guard')
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
    await joinVia(page, server.ownerLink(), 'Host')
    await page.waitForFunction(() => typeof (window as { iskraShare?: unknown }).iskraShare === 'function')
    const taken = await page.evaluate(() => (window as unknown as { iskraShare: (raw: unknown) => boolean }).iskraShare({
      id: 'x', files: [{ name: 'secret', type: 'text/plain', size: 3, url: 'https://elsewhere.invalid/secret' }],
    }))
    expect(taken).toBe(false)
    await expect(page.getByRole('dialog', { name: 'Share to…' })).toHaveCount(0)
  } finally {
    await server.stop()
  }
})

// Phones: the composer's attach, poll, GIF, emoji and voice-message buttons fold into one "+" that opens a sheet, so the
// message box (and its placeholder) has room; desktop keeps the row of buttons. Everything stays reachable by keyboard.
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { composerAction, joinVia, SHOTS, startServer } from './helpers'

test('below 480 px the composer folds its buttons into a "+" sheet; wider screens keep them', async ({ browser }) => {
  const server = await startServer('Phone composer')
  try {
    const page = await (await browser.newContext()).newPage()
    await joinVia(page, server.ownerLink(), 'Host')
    const composer = page.locator('.composer')
    const plus = composer.getByRole('button', { name: 'Add to your message' })
    const box = page.getByPlaceholder('Message #general')

    // Desktop: the buttons are there, no "+".
    await expect(composer.getByRole('button', { name: 'Attach files' })).toBeVisible()
    await expect(composer.getByRole('button', { name: 'Emoji', exact: true })).toBeVisible()
    await expect(plus).toBeHidden()

    // Phone: one "+", the box wide enough for its placeholder.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(400)
    await expect(plus).toBeVisible()
    await expect(composer.getByRole('button', { name: 'Attach files' })).toBeHidden()
    await expect(composer.getByRole('button', { name: 'Emoji', exact: true })).toBeHidden()
    await expect(composer.getByRole('button', { name: 'Create a poll' })).toBeHidden()
    const width = await box.evaluate((el) => el.getBoundingClientRect().width)
    expect(width).toBeGreaterThan(220)
    await page.screenshot({ path: join(SHOTS, 'phone-composer.png') })

    // The sheet lists the actions; Emoji opens the picker and the picked emoji lands in the box.
    await plus.click()
    const sheet = page.getByRole('dialog', { name: 'Add to your message' })
    await expect(sheet.getByRole('menuitem')).toHaveText([/Attach files$/, /Create a poll$/, /GIFs$/, /Emoji$/, /Record a voice message$/])
    await page.screenshot({ path: join(SHOTS, 'phone-composer-sheet.png') })
    await sheet.getByRole('menuitem', { name: 'Emoji' }).click()
    await expect(sheet).toHaveCount(0)
    const picker = page.getByRole('dialog', { name: 'Emoji picker' })
    await picker.getByLabel('Search emoji').fill('tada')
    await picker.getByRole('button', { name: ':tada:' }).click()
    await page.keyboard.press('Escape')
    await expect(box).toHaveValue('🎉')
    await box.fill('')

    // Attach opens the file chooser; the shared helper does the same dance.
    const chooser = page.waitForEvent('filechooser')
    await composerAction(page, 'Attach files')
    expect(await chooser).toBeTruthy()

    // Keyboard: Tab to "+", Enter opens the sheet, Escape closes it and the focus comes back.
    await box.focus()
    await page.keyboard.press('Shift+Tab')
    await expect(plus).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)

    // GIFs from the sheet opens the picker on its GIFs tab; a poll opens the poll dialog.
    await composerAction(page, 'GIFs')
    await expect(picker.getByRole('tab', { name: 'GIFs' })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')
    await composerAction(page, 'Create a poll')
    await expect(page.getByRole('dialog', { name: 'Create a poll' })).toBeVisible()
    await page.keyboard.press('Escape')

    // Back on a wide screen the buttons return.
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect(plus).toBeHidden()
    await expect(composer.getByRole('button', { name: 'Emoji', exact: true })).toBeVisible()
  } finally {
    await server.stop()
  }
})

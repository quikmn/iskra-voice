// Report a bug: the owner of a (local) server turns its bug inbox on for a private channel; someone opens "Report a
// bug" with Ctrl+Shift+B (in Chromium a picture-in-picture window of its own, so the app stays usable), pastes a
// screenshot, checks exactly what's sent (no chat text, names, server name, invite or addresses), sends it, and the
// report shows up in the private channel as a "Bug reports" message. Without picture-in-picture (phones, Firefox,
// Safari) it's a dialog that can step aside into a chip.
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Bug HQ', false, {}, { BugInbox: { Accept: true } })
})
test.afterAll(async () => server?.stop())

const SECRET_CHAT = 'meet at the old mill, door code 4471, ping 203.0.113.9 or alice@example.org'

test('a bug report goes to the bug inbox channel, with only what the preview shows', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage()
  await joinVia(owner, server.ownerLink(), 'Olga')
  await send(owner, SECRET_CHAT)
  await expect(owner.getByText(SECRET_CHAT)).toBeVisible()
  const invite = await createInviteLink(owner)

  // A channel only admins can read, picked in Server settings → Bug inbox.
  await owner.getByRole('button', { name: 'Create channel' }).first().click()
  const create = owner.getByRole('dialog', { name: 'Create channel' })
  await create.getByPlaceholder('game-night').fill('bug-inbox')
  await create.getByLabel('Who can see it').selectOption('admin')
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(create).toBeHidden()

  const room = await openServerSettings(owner, 'Bug inbox')
  const section = room.getByTestId('bug-inbox-section')
  const toggle = section.getByRole('switch', { name: 'Take bug reports' })
  await expect(toggle).toBeDisabled()
  await section.getByLabel('Channel').selectOption({ label: '#bug-inbox' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(section.getByText(/Reports arrive at .*\/bug-reports/)).toBeVisible()
  await room.screenshot({ path: join(SHOTS, 'bug-inbox-settings.png') })
  await owner.keyboard.press('Escape')

  // Development builds send to the address in localStorage (production always to chat.iskra.foo).
  await owner.evaluate((url) => localStorage.setItem('iskra.bugReportUrl', url), `${server.url}/bug-reports`)

  // The status menu has the entry; Ctrl+Shift+B opens it too.
  await owner.locator('.me-status-button').click()
  await expect(owner.getByRole('menuitem', { name: /Report a bug/ })).toBeVisible()
  await owner.keyboard.press('Escape')
  const pages = () => owner.context().pages().length
  const opened = owner.context().waitForEvent('page')
  await owner.keyboard.press('Control+Shift+B')
  // Its own window: the browser's picture-in-picture, rendered by the app's page.
  const pip = await opened
  const first = pip.getByRole('form', { name: 'Report a bug' })
  await expect(first).toBeVisible()
  await expect(first.getByRole('button', { name: 'Send' })).toBeDisabled()
  // The app stays usable meanwhile (no dialog over it), and the shortcut again doesn't open a second one.
  await expect(owner.getByRole('dialog')).toHaveCount(0)
  await owner.keyboard.press('Control+Shift+B')
  await owner.waitForTimeout(300)
  expect(pages()).toBe(2)

  // Closing the window keeps the draft; opening it again brings it back.
  await first.getByLabel('What happened?').fill('The mute button')
  await pip.getByRole('button', { name: 'Close' }).click()
  await expect.poll(pages).toBe(1)
  const reopened = owner.context().waitForEvent('page')
  await owner.keyboard.press('Control+Shift+B')
  const pip2 = await reopened
  const form = pip2.getByRole('form', { name: 'Report a bug' })
  await expect(form.getByLabel('What happened?')).toHaveValue('The mute button')
  await reportFlow(pip2, form, invite)
  // Done closes the window.
  await expect.poll(pages).toBe(1)

  // The report in the private channel: the card, the words, the screenshot and the logs file.
  await owner.locator('.org-row', { has: owner.getByRole('button', { name: 'bug-inbox', exact: true }) }).getByRole('button', { name: 'bug-inbox', exact: true }).click()
  const report = owner.locator('.message', { hasText: 'The mute button does nothing after rejoining' }).last()
  await expect(report).toBeVisible()
  await expect(report.getByText('Bug reports').first()).toBeVisible()
  await expect(report.getByText('olga@example.com')).toBeVisible()
  await expect(report.getByText(/logs\.txt/)).toBeVisible()
  await expect(report.locator('img').first()).toBeVisible()
  await owner.screenshot({ path: join(SHOTS, 'bug-report-in-channel.png') })

  // Without picture-in-picture (phones, Firefox, Safari), at phone width: a dialog that fits, with a fresh draft
  // (the last one was sent). It can step aside into a chip while you show the bug, and come back with what you wrote.
  await owner.evaluate(() => Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: true }))
  await owner.setViewportSize({ width: 390, height: 844 })
  await owner.keyboard.press('Control+Shift+B')
  const dialog = owner.getByRole('dialog', { name: 'Report a bug' })
  await expect(dialog.getByLabel('What happened?')).toHaveValue('')
  const box = (await dialog.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390.5)
  await owner.waitForTimeout(500) // the dialog's fade-in
  await owner.screenshot({ path: join(SHOTS, 'bug-report-phone.png') })
  await dialog.getByLabel('What happened?').fill('Typing lags on the phone')
  await dialog.getByRole('button', { name: 'Keep using Iskra' }).click()
  await expect(dialog).toBeHidden()
  const chip = owner.getByTestId('bug-report-chip')
  await expect(chip.getByRole('button', { name: 'Bug report', exact: true })).toBeVisible()
  await owner.screenshot({ path: join(SHOTS, 'bug-report-chip.png') })
  // Its × throws nothing away: it opens the report, where discarding is.
  await chip.getByRole('button', { name: 'Back to the bug report' }).click()
  await expect(dialog.getByLabel('What happened?')).toHaveValue('Typing lags on the phone')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(chip).toHaveCount(0)

  // A member doesn't see the channel at all.
  const member = await (await browser.newContext()).newPage()
  await joinVia(member, invite, 'Max')
  await expect(member.getByRole('button', { name: 'bug-inbox', exact: true })).toHaveCount(0)
})

/** In the report window: fill it in, paste a screenshot, check exactly what's sent, send. */
async function reportFlow(page: Page, dialog: Locator, invite: string) {
  await dialog.getByLabel('What happened?').fill('The mute button does nothing after rejoining')
  await dialog.getByLabel('Steps to reproduce').fill('1. Join voice\n2. Leave and rejoin\n3. Click mute')
  await dialog.getByLabel('What did you expect?').fill('It mutes')

  // Paste a screenshot (a picture drawn here, like a copied image).
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 200
    const context = canvas.getContext('2d')!
    context.fillStyle = '#695bff'
    context.fillRect(0, 0, 320, 200)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const data = new DataTransfer()
    data.items.add(new File([blob], 'IMG_0001.png', { type: 'image/png' }))
    document.querySelector('.bug-report-form textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(dialog.getByRole('img', { name: 'Screenshot 1' })).toBeVisible()
  await expect(dialog.getByText('1 of 5')).toBeVisible()

  // Exactly what's sent: the report, environment and logs; nothing from the chat, the people or the server.
  await dialog.getByRole('button', { name: "See what's included" }).click()
  const preview = dialog.getByTestId('bug-report-preview')
  await expect(preview).toContainText('"what": "The mute button does nothing after rejoining"')
  await expect(preview).toContainText('"logs":')
  await expect(preview).toContainText('connection s1 online')
  await expect(preview).toContainText('<image 1:')
  const shown = (await preview.textContent())!
  for (const secret of ['old mill', '4471', '203.0.113.9', 'alice@example.org', 'Olga', 'Bug HQ', invite, invite.split('#')[1], server.url, 'IMG_0001']) {
    expect(shown).not.toContain(secret)
  }
  await dialog.getByLabel('Your email (optional)').fill('not-an-email')
  await dialog.getByLabel('Your email (optional)').blur()
  await expect(dialog.getByText("That doesn't look like an email address.")).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled()
  await dialog.getByLabel('Your email (optional)').fill('olga@example.com')
  await expect(preview).toContainText('"email": "olga@example.com"')
  await page.screenshot({ path: join(SHOTS, 'bug-report-dialog.png') })

  await dialog.getByRole('button', { name: 'Send' }).click()
  await expect(dialog.getByText('Thanks! Your report is in.')).toBeVisible()
  await expect(dialog.getByText(/Report [A-Z0-9]{4}-[A-Z0-9]{4}\./)).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'bug-report-sent.png') })
  await dialog.getByRole('button', { name: 'Done' }).click()
}

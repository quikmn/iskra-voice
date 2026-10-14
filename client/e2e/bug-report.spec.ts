// Report a bug: the owner of a (local) server turns its bug inbox on for a private channel; someone opens "Report a
// bug" with Ctrl+Shift+B, pastes a screenshot, checks exactly what's sent (no chat text, names, server name, invite or
// addresses), sends it, and the report shows up in the private channel as a "Bug reports" message.
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Bug HQ')
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
  await owner.keyboard.press('Control+Shift+B')
  const dialog = owner.getByRole('dialog', { name: 'Report a bug' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled()

  await dialog.getByLabel('What happened?').fill('The mute button does nothing after rejoining')
  await dialog.getByLabel('Steps to reproduce').fill('1. Join voice\n2. Leave and rejoin\n3. Click mute')
  await dialog.getByLabel('What did you expect?').fill('It mutes')

  // Paste a screenshot (a picture drawn here, like a copied image).
  await owner.evaluate(async () => {
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
  await dialog.screenshot({ path: join(SHOTS, 'bug-report-dialog.png') })

  await dialog.getByRole('button', { name: 'Send' }).click()
  await expect(dialog.getByText('Thanks! Your report is in.')).toBeVisible()
  await expect(dialog.getByText(/Report [A-Z0-9]{4}-[A-Z0-9]{4}\./)).toBeVisible()
  await dialog.screenshot({ path: join(SHOTS, 'bug-report-sent.png') })
  await dialog.getByRole('button', { name: 'Done' }).click()

  // The report in the private channel: the card, the words, the screenshot and the logs file.
  await owner.locator('.org-row', { has: owner.getByRole('button', { name: 'bug-inbox', exact: true }) }).getByRole('button', { name: 'bug-inbox', exact: true }).click()
  const report = owner.locator('.message', { hasText: 'The mute button does nothing after rejoining' }).last()
  await expect(report).toBeVisible()
  await expect(report.getByText('Bug reports').first()).toBeVisible()
  await expect(report.getByText('olga@example.com')).toBeVisible()
  await expect(report.getByText(/logs\.txt/)).toBeVisible()
  await expect(report.locator('img').first()).toBeVisible()
  await owner.screenshot({ path: join(SHOTS, 'bug-report-in-channel.png') })

  // At phone width the form fits and keeps nothing from before (a fresh draft after sending).
  await owner.setViewportSize({ width: 390, height: 844 })
  await owner.keyboard.press('Control+Shift+B')
  await expect(dialog.getByLabel('What happened?')).toHaveValue('')
  const box = (await dialog.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390.5)
  await owner.waitForTimeout(500) // the dialog's fade-in
  await owner.screenshot({ path: join(SHOTS, 'bug-report-phone.png') })
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // A member doesn't see the channel at all.
  const member = await (await browser.newContext()).newPage()
  await joinVia(member, invite, 'Max')
  await expect(member.getByRole('button', { name: 'bug-inbox', exact: true })).toHaveCount(0)
})

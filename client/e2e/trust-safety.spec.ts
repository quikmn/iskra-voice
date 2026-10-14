// Trust and safety: agreeing to the terms on first run, reporting a message to the moderators (who act on it from
// the Reports queue), and deleting an account.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, openSettings, send, serverRoom, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Safety Club')
})
test.afterAll(async () => server?.stop())

async function moreMenu(page: Page, text: string) {
  const message = page.locator('.message', { hasText: text }).last()
  await message.hover()
  await message.getByRole('button', { name: 'More', exact: true }).click()
  return page.getByRole('menu', { name: 'Message options' })
}

test('the terms are agreed on first run, and again when they change', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/')
  const isNew = page.getByRole('button', { name: /I’m new to Iskra/ })
  const already = page.getByRole('button', { name: /I already use Iskra/ })
  await expect(isNew).toBeDisabled()
  await expect(already).toBeDisabled()
  await expect(page.getByText(/Zero tolerance for abuse/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Terms of Use and Community guidelines' })).toHaveAttribute('href', 'https://iskra.foo/terms')
  await page.waitForTimeout(350) // let the dialog finish appearing
  await page.screenshot({ path: join(SHOTS, 'safety-terms-first-run.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(350) // let the dialog finish appearing
  await page.screenshot({ path: join(SHOTS, 'safety-terms-first-run-phone.png') })
  // Why the choices are greyed out: said right above them, and read out with them.
  await expect(isNew).toHaveAccessibleDescription('Tick the box above to continue.')
  await isNew.scrollIntoViewIfNeeded()
  await expect(page.getByText('Tick the box above to continue.')).toBeInViewport()
  await page.setViewportSize({ width: 1280, height: 720 })

  // "I already use Iskra" needs it too; going back shows the choices without asking again.
  await page.getByRole('checkbox', { name: /I agree to the Terms of Use/ }).check()
  await already.click()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('checkbox', { name: /I agree to the Terms of Use/ })).toHaveCount(0)
  await expect(isNew).toBeEnabled()
  await isNew.click()
  await page.getByLabel('Your name').fill('Reader')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Our terms have changed' })).toHaveCount(0)

  // A device that agreed to an older version is asked again.
  await page.evaluate(() => localStorage.setItem('iskra.terms', JSON.stringify({ version: '2020-01-01', at: 1 })))
  await page.reload()
  const changed = page.getByRole('dialog', { name: 'Our terms have changed' })
  await expect(changed).toBeVisible()
  await expect(changed.getByRole('button', { name: 'Continue' })).toBeDisabled()
  await page.waitForTimeout(350) // let the dialog finish appearing
  await page.screenshot({ path: join(SHOTS, 'safety-terms-changed.png') })
  await changed.getByRole('checkbox', { name: /I agree/ }).check()
  await changed.getByRole('button', { name: 'Continue' }).click()
  await expect(changed).toHaveCount(0)

  // Settings → About & legal links the full texts and the safety contact.
  await openSettings(page, 'About & legal')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', 'https://iskra.foo/privacy')
  await expect(settings.getByRole('link', { name: 'Email the Iskra team' })).toHaveAttribute('href', /^mailto:spark@iskra\.foo\?subject=/)
  await expect(settings.getByText(/You agreed to the terms/)).toBeVisible()
  await page.waitForTimeout(350) // let the dialog finish appearing
  await page.screenshot({ path: join(SHOTS, 'safety-about.png') })
})

test('a reported message reaches the moderators, who delete it and resolve the report', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const invite = await createInviteLink(host)
  const sam = await (await browser.newContext()).newPage()
  await joinVia(sam, invite, 'Sam')
  const troll = await (await browser.newContext()).newPage()
  await joinVia(troll, invite, 'Troll')

  await send(troll, 'you are all terrible people')
  await expect(sam.locator('.message-text', { hasText: 'you are all terrible people' })).toBeVisible()

  // Sam reports it from the message menu.
  await (await moreMenu(sam, 'you are all terrible people')).getByRole('menuitem', { name: 'Report message' }).click()
  const dialog = sam.getByRole('dialog', { name: 'Report message' })
  await expect(dialog.locator('.report-quote')).toContainText('you are all terrible people')
  await expect(dialog.getByRole('button', { name: 'Send report' })).toBeDisabled()
  await dialog.getByRole('radio', { name: /Harassment or bullying/ }).check()
  await dialog.getByLabel(/Anything else the moderators should know/).fill('They keep doing this')
  await sam.waitForTimeout(350) // let the dialog finish appearing
  await sam.screenshot({ path: join(SHOTS, 'safety-report-dialog.png') })
  await dialog.getByRole('button', { name: 'Send report' }).click()
  await expect(dialog.getByText('Thanks for reporting')).toBeVisible()
  await dialog.getByRole('button', { name: 'Done' }).click()

  // The reported person sees nothing; the owner gets a Reports badge in the channel list.
  await expect(troll.getByRole('button', { name: /^Reports/ })).toHaveCount(0)
  const badge = host.locator('.reports-button')
  await expect(badge).toContainText('1')
  await host.waitForTimeout(350) // let the dialog finish appearing
  await host.screenshot({ path: join(SHOTS, 'safety-reports-badge.png') })
  await badge.click()
  const settings = serverRoom(host)
  await expect(settings.getByRole('button', { name: /^Reports/ })).toHaveAttribute('aria-current', 'page')
  const card = settings.locator('.report-card').first()
  await expect(card).toContainText('you are all terrible people')
  await expect(card).toContainText('Harassment or bullying')
  await expect(card).toContainText('They keep doing this')
  await expect(card).toContainText('Reported by Sam')
  await host.waitForTimeout(350) // let the dialog finish appearing
  await host.screenshot({ path: join(SHOTS, 'safety-reports-queue.png') })

  await card.getByRole('button', { name: 'Delete message' }).click()
  await card.locator('.report-confirm').getByRole('button', { name: 'Delete message' }).click()
  await expect(settings.getByText('No open reports. Nice and calm.')).toBeVisible()
  await expect(badge).toHaveCount(0)
  await expect(sam.locator('.message-text', { hasText: 'you are all terrible people' })).toHaveCount(0)
  await settings.getByRole('tab', { name: 'Handled' }).click()
  await expect(settings.locator('.report-card').first()).toContainText('Host: message deleted')
  await host.setViewportSize({ width: 390, height: 844 })
  await host.waitForTimeout(350) // let the dialog finish appearing
  await host.screenshot({ path: join(SHOTS, 'safety-reports-handled-phone.png') })
  await host.setViewportSize({ width: 1280, height: 720 })
  await host.keyboard.press('Escape')

  // In an encrypted DM the server can't read anything: Sam picks what to share, and sees it before it goes.
  await troll.locator('.member-list').getByRole('button', { name: 'Sam' }).click()
  await troll.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await troll.getByPlaceholder('Message Sam').fill('tell me where you live')
  await troll.getByPlaceholder('Message Sam').press('Enter')
  await sam.getByRole('button', { name: 'Direct messages' }).click()
  await sam.locator('.dm-row', { hasText: 'Troll' }).click()
  await expect(sam.locator('.message-text', { hasText: 'tell me where you live' })).toBeVisible()
  await sam.locator('.dm-header-person').click({ button: 'right' })
  await sam.getByRole('menuitem', { name: 'Report', exact: true }).click()
  const dm = sam.getByRole('dialog', { name: 'Report Troll' })
  await expect(dm.getByText(/end-to-end encrypted: no server can read them/)).toBeVisible()
  await dm.getByRole('radio', { name: /Harassment or bullying/ }).check()
  await dm.locator('.report-share-list').getByRole('checkbox').first().check()
  await expect(dm.getByRole('button', { name: 'Send report' })).toBeDisabled() // until Sam agrees to share it
  await dm.getByRole('checkbox', { name: /I agree to share this message with the moderators of Safety Club/ }).check()
  await sam.waitForTimeout(350) // let the dialog finish appearing
  await sam.screenshot({ path: join(SHOTS, 'safety-report-dm.png') })
  await dm.getByRole('button', { name: 'Send report' }).click()
  await expect(dm.getByText('Thanks for reporting')).toBeVisible()
  await dm.getByRole('button', { name: 'Done' }).click()

  await expect(badge).toContainText('1')
  await badge.click()
  const shared = settings.locator('.report-card').first()
  await expect(shared).toContainText('private messages')
  await expect(shared).toContainText('tell me where you live')
  await expect(shared).toContainText("Shared by the reporter from an encrypted conversation")
  await shared.getByRole('button', { name: 'Dismiss' }).click()
  await expect(settings.getByText('No open reports. Nice and calm.')).toBeVisible()
  await host.keyboard.press('Escape')

  // The audit log says a report was handled, never by whom it was made.
  await openServerSettings(host, 'Activity log')
  await expect(host.getByText(/Host handled a report about Troll: message deleted/)).toBeVisible()
  await host.keyboard.press('Escape')
})

test('deleting an account removes it from the server and wipes the device', async ({ browser }) => {
  const other = await startServer('Goodbye Club')
  try {
    const owner = await (await browser.newContext()).newPage()
    await joinVia(owner, other.ownerLink(), 'Keeper')
    const leaver = await (await browser.newContext()).newPage()
    await joinVia(leaver, await createInviteLink(owner), 'Leaver')
    await send(leaver, 'goodbye everyone')
    await expect(owner.locator('.message-text', { hasText: 'goodbye everyone' })).toBeVisible()

    // An owner has to hand the server over first.
    await openSettings(owner, 'Account')
    await owner.getByRole('button', { name: 'Delete my account…' }).click()
    const ownerDialog = owner.getByRole('dialog', { name: 'Delete account' })
    await expect(ownerDialog.getByText('You own a server')).toBeVisible()
    await ownerDialog.getByLabel('Type DELETE to confirm').fill('DELETE')
    await expect(ownerDialog.getByRole('button', { name: 'Delete my account' })).toBeDisabled()
    await owner.waitForTimeout(350) // let the dialog finish appearing
    await owner.screenshot({ path: join(SHOTS, 'safety-delete-account-owner.png') })
    await ownerDialog.getByRole('button', { name: 'Cancel' }).click()
    await owner.keyboard.press('Escape')

    await openSettings(leaver, 'Account')
    await leaver.getByRole('button', { name: 'Delete my account…' }).click()
    const dialog = leaver.getByRole('dialog', { name: 'Delete account' })
    await dialog.getByRole('checkbox', { name: /Also delete all my messages/ }).check()
    await expect(dialog.getByRole('button', { name: 'Delete my account' })).toBeDisabled()
    await dialog.getByLabel('Type DELETE to confirm').fill('DELETE')
    await leaver.waitForTimeout(350) // let the dialog finish appearing
    await leaver.screenshot({ path: join(SHOTS, 'safety-delete-account.png') })
    await dialog.getByRole('button', { name: 'Delete my account' }).click()

    // The device starts over, and the server forgot the account and its messages.
    await expect(leaver.getByText('Your account was deleted, and everything it had on this device is gone.')).toBeVisible({ timeout: 15_000 })
    await expect(leaver.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible()
    await leaver.waitForTimeout(350) // let the dialog finish appearing
    await leaver.screenshot({ path: join(SHOTS, 'safety-account-deleted.png') })
    await expect(owner.locator('.message-text', { hasText: 'goodbye everyone' })).toHaveCount(0)
    await expect(owner.locator('.member-list')).not.toContainText('Leaver')
  } finally {
    await other.stop()
  }
})

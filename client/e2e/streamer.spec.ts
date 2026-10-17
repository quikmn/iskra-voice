// Streamer mode: the switch in My settings and the quick toggle in the status menu; while it's on, invite links,
// account ids and safety numbers are dots and a pill says so; off again, everything shows.
import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Stream Night')
})
test.afterAll(async () => server?.stop())

const DOTS = /^•+$/

test('streamer mode hides invite links, ids and safety numbers, and the status menu toggles it', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const invite = await createInviteLink(host)
  const friend = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(friend, invite, 'Friend')

  // Off: the invite link and a member's id show as usual.
  await host.getByRole('button', { name: 'Invite friends' }).click()
  const inviteDialog = host.getByRole('dialog', { name: 'Invite friends to Stream Night' })
  await expect(inviteDialog.getByTestId('invite-link')).toHaveValue(/^http/)
  await host.keyboard.press('Escape')
  await expect(host.getByTestId('streamer-pill')).toHaveCount(0)

  // On, from My settings: the pill shows, the link and ids are dots.
  await openSettings(host, 'Streamer mode')
  const section = host.getByTestId('streamer-section')
  await section.getByRole('checkbox', { name: /^Streamer mode/ }).check()
  await host.keyboard.press('Escape')
  await expect(host.getByTestId('streamer-pill')).toBeVisible()
  await host.getByRole('button', { name: 'Invite friends' }).click()
  await expect(inviteDialog.getByTestId('invite-link')).toHaveValue(DOTS)
  await expect(inviteDialog.locator('.invite-code').first()).toHaveText(DOTS)
  await host.screenshot({ path: join(SHOTS, 'streamer-invite.png') })
  await host.keyboard.press('Escape')
  await host.locator('.member-list').getByRole('button', { name: 'Friend' }).first().click()
  await expect(host.locator('.profile-id code')).toHaveText(DOTS)
  await host.screenshot({ path: join(SHOTS, 'streamer-profile.png') })
  await host.keyboard.press('Escape')

  // The quick toggle in the status menu turns it off again.
  await host.locator('.me-status-button').click()
  const toggle = host.getByTestId('streamer-toggle')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(host.getByTestId('streamer-pill')).toHaveCount(0)
  await host.getByRole('button', { name: 'Invite friends' }).click()
  await expect(inviteDialog.getByTestId('invite-link')).toHaveValue(/^http/)
  await host.keyboard.press('Escape')

  // And on again from there; the safety number in a DM is dots too.
  await host.locator('.me-status-button').click()
  await host.getByTestId('streamer-toggle').click()
  await expect(host.getByTestId('streamer-pill')).toBeVisible()
  await host.locator('.member-list').getByRole('button', { name: 'Friend' }).first().click()
  await host.locator('.profile-actions').getByRole('button', { name: 'Message', exact: true }).click()
  await host.getByRole('button', { name: /Verify|safety number/i }).first().click()
  await expect(host.getByTestId('safety-number').locator('span').first()).toHaveText(DOTS)
  await host.keyboard.press('Escape')

  // On a phone the quick toggle is in the drawer's status menu, and the pill sits above the composer.
  await friend.getByRole('button', { name: 'Open channels' }).click()
  await friend.locator('.me-status-button').click()
  await friend.getByTestId('streamer-toggle').click()
  await expect(friend.getByTestId('streamer-pill')).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'streamer-phone.png') })
})

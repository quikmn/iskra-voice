import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, openServerSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Gate Test')
})
test.afterAll(async () => server?.stop())

/** Opens an invite link as someone new and presses Join (without waiting for a channel: the server may not let them in). */
async function knock(page: Page, link: string, name: string) {
  await page.goto(link)
  await expect(page.getByText("You've been invited")).toBeVisible()
  await agreeToTerms(page)
  await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Join' }).click()
}

test('approval invites queue joiners for moderators; paused invites turn people away until resumed', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const plainLink = await createInviteLink(host)

  // ── An invite that needs approval.
  await host.getByRole('button', { name: 'Invite friends' }).click()
  const linkInput = host.locator('.copy-row input')
  await expect(linkInput).toHaveValue(/#\/join\//)
  await host.getByRole('checkbox', { name: 'Approve each person who joins' }).check()
  await expect(host.getByText('waits outside until a moderator lets them in')).toBeVisible()
  await expect(linkInput).not.toHaveValue(plainLink)
  await expect(linkInput).toHaveValue(/#\/join\//)
  const approvalLink = await linkInput.inputValue()
  await expect(host.locator('[data-testid=invite-row]').first().locator('.invite-approval')).toHaveText('Approval')
  await host.keyboard.press('Escape')

  // ── Sam knocks on a phone and waits outside: the server's name, nothing else.
  const sam = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await knock(sam, approvalLink, 'Sam')
  const waiting = sam.getByTestId('join-pending')
  await expect(waiting).toBeVisible({ timeout: 15_000 })
  await expect(waiting).toContainText('Waiting to join Gate Test')
  await expect(sam.locator('.channel-name')).toHaveCount(0)
  await sam.screenshot({ path: join(SHOTS, 'join-pending-phone.png') })

  // ── The host sees Sam in the queue (which invite, when) and lets them in.
  const reports = host.locator('.reports-button')
  await expect(reports).toBeVisible()
  await expect(reports.locator('.reports-badge')).toHaveText('1')
  await reports.click()
  const queue = host.getByTestId('join-queue')
  await expect(queue).toContainText('1 person waiting to join')
  await expect(queue).toContainText('Sam')
  await expect(queue).toContainText(`Invite …${approvalLink.slice(-6)} by Host`)
  await expect(queue).not.toContainText('127.0.0.1')
  await host.screenshot({ path: join(SHOTS, 'join-queue.png') })
  await queue.getByRole('button', { name: 'Let in' }).click()
  await expect(host.getByTestId('join-queue')).toHaveCount(0)
  await host.keyboard.press('Escape')
  await expect(host.locator('.member-list')).toContainText('Sam')

  // Sam's app knocks again by itself (every 15 s); "Try now" skips the wait.
  await sam.getByRole('button', { name: 'Try now' }).click()
  await expect(sam.getByRole('heading', { name: 'general', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(sam.getByTestId('join-pending')).toHaveCount(0)

  // ── Pause invites (Server settings → AutoMod → Joining): a plain link stops working, and says so.
  await openServerSettings(host, 'AutoMod')
  const joining = host.getByTestId('joining-settings')
  await expect(joining).toContainText('Invites work')
  await joining.getByRole('switch', { name: 'Pause invites' }).click()
  await expect(joining).toContainText('Invites are paused')
  await expect(joining).toContainText('Paused by Host')
  await host.keyboard.press('Escape')

  const late = await (await browser.newContext()).newPage()
  await knock(late, plainLink, 'Late')
  const refused = late.locator('.join-failed')
  await expect(refused).toContainText("This server isn't taking new members right now.", { timeout: 15_000 })
  await late.screenshot({ path: join(SHOTS, 'join-invites-paused.png') })

  // The invite dialog says so too, and the host resumes from there; Late tries again and gets in.
  await host.getByRole('button', { name: 'Invite friends' }).click()
  const banner = host.getByTestId('invites-paused')
  await expect(banner).toContainText('Invites are paused')
  await banner.getByRole('button', { name: 'Resume invites' }).click()
  await expect(host.getByTestId('invites-paused')).toHaveCount(0)
  await host.keyboard.press('Escape')
  await refused.getByRole('button', { name: 'Try again' }).click()
  await expect(late.getByRole('heading', { name: 'general', exact: true })).toBeVisible({ timeout: 15_000 })

  // The activity log tells the story.
  await openServerSettings(host, 'Activity log')
  const log = host.locator('.audit-list')
  await expect(log).toContainText('Host let Sam in')
  await expect(log).toContainText('Host paused invites')
  await expect(log).toContainText('Host resumed invites')
})

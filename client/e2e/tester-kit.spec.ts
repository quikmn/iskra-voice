// The tester kit: a server set up from server/templates/review.json greets new people with rules to agree to, a
// #welcome channel with pinned welcome messages from the server, a testing guide as the Start here page, and a topic on
// every channel. Screenshots at phone and desktop width. Then "Report a bug" from a phone, as a member of that server,
// lands in the bug inbox of another server (the stand-in for chat.iskra.foo, set up from bug-inbox.json), and the
// inbox answers the phone apps' own origins (capacitor://localhost on iOS, http://localhost on Android).
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

const TEMPLATES = resolve(fileURLToPath(import.meta.url), '../../../server/templates')
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }

let review: TestServer
let inbox: TestServer
test.beforeAll(async () => {
  review = await startServer('Iskra Review', false, {}, { Template: join(TEMPLATES, 'review.json') })
  inbox = await startServer('Iskra HQ', false, {}, { Template: join(TEMPLATES, 'bug-inbox.json') })
})
test.afterAll(async () => {
  await review?.stop()
  await inbox?.stop()
})

/** The rules come up by themselves on the review server: agree to them. */
async function agreeToRules(page: Page) {
  const rules = page.getByRole('dialog', { name: 'Welcome to Iskra Review' })
  await expect(rules).toBeVisible()
  await expect(rules.getByText('No personal data.')).toBeVisible()
  await rules.getByTestId('rules-agree').click()
  await expect(rules).toHaveCount(0)
}

let invite = ''

test('the review server greets testers with a welcome, a guide and topics', async ({ browser }) => {
  test.setTimeout(120_000)
  const owner = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(owner, review.ownerLink(), 'Viktor', 'welcome')
  invite = await createInviteLink(owner)

  // A tester on a phone.
  const tester = await (await browser.newContext(PHONE)).newPage()
  await joinVia(tester, invite, 'Ana', 'welcome')
  await expect(tester.getByRole('dialog', { name: 'Welcome to Iskra Review' })).toBeVisible()
  await tester.waitForTimeout(400) // the dialog's fade-in
  await tester.screenshot({ path: join(SHOTS, 'tester-kit-rules-phone.png') })
  await agreeToRules(tester)

  // #welcome: its topic, and the two pinned messages from the server.
  const topic = tester.locator('.channel-topic')
  await expect(topic).toContainText('Start here: read the two pinned messages')
  const hello = tester.locator('.message', { hasText: 'Welcome to Iskra Review' }).first()
  await expect(hello).toBeVisible()
  await expect(hello.getByText('Iskra Review', { exact: true }).first()).toBeVisible()
  await expect(tester.locator('.message', { hasText: 'Found a bug? Report it in the app' }).first()).toBeVisible()
  await expect(tester.locator('.composer.read-only')).toBeVisible() // only admins post here
  await tester.screenshot({ path: join(SHOTS, 'tester-kit-welcome-phone.png') })

  // A long topic opens to its full text when tapped.
  await topic.click()
  await expect(topic).toHaveAttribute('aria-expanded', 'true')

  // The channel list: Start here at the top, then the categories.
  await tester.getByRole('button', { name: 'Open channels' }).first().click()
  await expect(tester.locator('.start-here')).toHaveText('How to test')
  for (const name of ['introductions', 'testing-guide', 'your-language', 'disappearing', 'feedback', 'town-hall', 'Hangout', 'Game night']) {
    await expect(tester.getByRole('button', { name, exact: true }).first()).toBeAttached()
  }
  await tester.screenshot({ path: join(SHOTS, 'tester-kit-channels-phone.png') })

  // The guide: the Start here page, written by the server.
  await tester.locator('.start-here').click()
  await expect(tester.locator('.md-heading', { hasText: '1. Chat (#general)' })).toBeVisible()
  await expect(tester.getByText('Reporting bugs').first()).toBeAttached()
  await tester.screenshot({ path: join(SHOTS, 'tester-kit-guide-phone.png') })

  // The owner at desktop width: the same welcome, the guide, and a topic of their own.
  await agreeToRulesIfAsked(owner)
  await expect(owner.locator('.channel-topic')).toContainText('Start here')
  await owner.screenshot({ path: join(SHOTS, 'tester-kit-welcome-desktop.png') })
  await owner.getByRole('button', { name: 'testing-guide', exact: true }).click()
  await expect(owner.locator('.channel-topic')).toContainText('The testing guide')
  await owner.locator('.start-here').click()
  await expect(owner.locator('.md-heading', { hasText: '2. Voice (Hangout)' })).toBeVisible()
  await owner.screenshot({ path: join(SHOTS, 'tester-kit-guide-desktop.png') })

  await owner.getByRole('button', { name: 'general', exact: true }).click()
  await expect(owner.locator('.channel-topic')).toContainText('Talk about anything')
  await owner.getByRole('button', { name: 'Channel settings' }).click()
  const settings = owner.getByRole('dialog', { name: '#general settings' })
  await settings.getByLabel('Topic').fill('Anything goes. Be kind.')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(owner.locator('.channel-topic')).toContainText('Anything goes. Be kind.')
  await owner.screenshot({ path: join(SHOTS, 'tester-kit-general-desktop.png') })

  // Everyone sees the new topic at once.
  await tester.getByRole('button', { name: 'Open channels' }).first().click()
  await tester.getByRole('button', { name: 'general', exact: true }).first().click()
  await expect(tester.locator('.channel-topic')).toContainText('Anything goes. Be kind.')
})

/** The owner never has to agree, but the screen may still show the rules once. */
async function agreeToRulesIfAsked(page: Page) {
  const rules = page.getByRole('dialog', { name: /Iskra Review/ })
  if (await rules.isVisible()) await rules.getByRole('button', { name: /Close|I agree/ }).first().click()
}

test('a tester on a phone reports a bug that lands in the bug inbox of another server', async ({ browser, request }) => {
  test.setTimeout(120_000)
  // A member of the review server, not of the server that takes the reports.
  const tester = await (await browser.newContext(PHONE)).newPage()
  if (!invite) test.skip(true, 'needs the first test')
  await joinVia(tester, invite, 'Bo', 'welcome')
  await agreeToRules(tester)
  // Development builds send to the address in localStorage (production always to chat.iskra.foo).
  await tester.evaluate((url) => localStorage.setItem('iskra.bugReportUrl', url), `${inbox.url}/bug-reports`)

  // Your name at the bottom of the channel list → Report a bug.
  await tester.getByRole('button', { name: 'Open channels' }).first().click()
  await tester.locator('.me-status-button').click()
  await tester.getByRole('menuitem', { name: /Report a bug/ }).click()
  const dialog = tester.getByRole('dialog', { name: 'Report a bug' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('What happened?').fill('The whisper button does nothing on my phone')
  await dialog.getByLabel('Steps to reproduce').fill('1. Join Lounge 1\n2. Hold Whisper')
  await tester.waitForTimeout(400)
  await tester.screenshot({ path: join(SHOTS, 'tester-kit-report-phone.png') })
  await dialog.getByRole('button', { name: 'Send' }).click()
  await expect(dialog.getByText('Thanks! Your report is in.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Done' }).click()

  // The inbox server's owner finds it in the private #bug-reports.
  const team = await (await browser.newContext()).newPage()
  // A new server from bug-inbox.json: its first text channel, #bug-reports, is the starting one.
  await joinVia(team, inbox.ownerLink(), 'Team', 'bug-reports')
  await expect(team.locator('.channel-topic')).toContainText('Admins only')
  const report = team.locator('.message', { hasText: 'The whisper button does nothing on my phone' }).last()
  await expect(report).toBeVisible()
  await expect(report.getByText('Bug reports').first()).toBeVisible()
  await expect(report).toContainText('web') // the device kind in the card (a browser here; "android" or "ios" in the apps)
  await team.screenshot({ path: join(SHOTS, 'tester-kit-report-in-inbox.png') })

  // The phone apps' own origins: the preflight passes and the report is accepted.
  for (const origin of ['capacitor://localhost', 'http://localhost']) {
    const preflight = await request.fetch(`${inbox.url}/bug-reports`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    })
    expect(preflight.status()).toBe(204)
    expect(preflight.headers()['access-control-allow-origin']).toBe(origin)
    const sent = await request.post(`${inbox.url}/bug-reports`, {
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      data: { v: 1, what: `Sent from ${origin}`, env: { version: '2.0.0-alpha.17', commit: 'dev', os: 'Android 15', device: origin.startsWith('capacitor') ? 'ios' : 'android' } },
    })
    expect(sent.status()).toBe(201)
    expect(sent.headers()['access-control-allow-origin']).toBe(origin)
  }
})

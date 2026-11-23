// Phones: where you land when voice ends, and what back does in each place (Android's back goes through the same
// code as the browser's: ui/nav/backNav.ts). Drawers, sheets and swipes are in phone-nav.spec.ts.
import { join } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, hasLiveKit, joinVia, openServerSettings, openSettings, SHOTS, startServer, type TestServer, VOICE_JOIN } from './helpers'

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
const phonePage = async (browser: Browser): Promise<Page> => (await browser.newContext(PHONE)).newPage()
const panel = (page: Page) => page.locator('.shell').evaluate((el) => [...el.classList].find((c) => c.startsWith('panel-')))
const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })
const openChannels = (page: Page) => page.locator('.chat-header').getByRole('button', { name: 'Open channels' }).click()

type Hooks = { __iskraNativeBack: () => void; __iskraExitHook?: () => void; __exits?: number }
/** Android's back button in the phone app (Capacitor's backButton event). */
const nativeBack = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__iskraNativeBack())
/** Back on the drawer shows "Press back again to leave" for two seconds; the next back then would leave. */
const hintGone = (page: Page) => expect(page.getByText('Press back again to leave')).toHaveCount(0, { timeout: 4000 })

/** From the channel list (opened if it isn't): into the voice channel, onto its call screen. */
async function joinLounge(page: Page) {
  if ((await panel(page)) !== 'panel-nav') await openChannels(page)
  await lounge(page).getByRole('button').first().click()
  await expect(page.locator('.stage')).toBeVisible(VOICE_JOIN)
  await expect.poll(() => panel(page)).toBe('panel-none')
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
}

test.describe('voice on a phone', () => {
  test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')
  let server: TestServer
  test.beforeAll(async () => {
    server = await startServer('Pocket Voice', true)
  })
  test.afterAll(async () => server?.stop())

  test('when voice ends, the channel list shows; back keeps the call', async ({ browser }) => {
    test.setTimeout(120_000)
    // The owner on a wide window (to disconnect the phone later); the friend on the phone.
    const owner = await (await browser.newContext()).newPage()
    await joinVia(owner, server.ownerLink(), 'Host')
    await owner.getByRole('button', { name: 'Create voice channel' }).click()
    await owner.getByRole('radio', { name: 'Voice' }).click()
    await owner.getByLabel('Name').fill('lounge')
    await owner.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(lounge(owner)).toBeVisible()
    const page = await phonePage(browser)
    await joinVia(page, await createInviteLink(owner), 'Friend')

    // In the call, back shows the channels and the call carries on; back again returns to the call.
    await joinLounge(page)
    await page.screenshot({ path: join(SHOTS, 'phone-back-call.png') })
    await page.goBack()
    await expect.poll(() => panel(page)).toBe('panel-nav')
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected')
    await page.goBack()
    await expect.poll(() => panel(page)).toBe('panel-none')
    await expect(page.locator('.stage')).toBeVisible()
    await hintGone(page)
    // The "More" sheet of the call controls closes first.
    const more = page.locator('.call-controls').getByRole('group', { name: 'More', exact: true })
    await page.locator('.call-controls').getByRole('button', { name: 'More', exact: true }).click()
    await expect(more).toBeVisible()
    await page.goBack()
    await expect(more).toBeHidden()
    expect(await panel(page)).toBe('panel-none')
    await expect(page.locator('.stage')).toBeVisible()

    // The call screen's red phone: the channels, not a text channel full screen.
    await page.locator('.call-controls').getByRole('button', { name: 'Leave call' }).click()
    await expect(page.locator('.stage')).toHaveCount(0)
    await expect.poll(() => panel(page)).toBe('panel-nav')
    await expect(lounge(page)).toBeInViewport()
    await expect(page.locator('.voice-bar')).toHaveCount(0)
    await page.waitForTimeout(350)
    await page.screenshot({ path: join(SHOTS, 'phone-back-after-hang-up.png') })

    // Leaving from the voice bar (it lives on the channel list): still the channel list.
    await joinLounge(page)
    await page.goBack()
    await expect.poll(() => panel(page)).toBe('panel-nav')
    await page.locator('.voice-bar').getByRole('button', { name: 'Leave voice' }).click()
    await expect(page.locator('.voice-bar')).toHaveCount(0)
    expect(await panel(page)).toBe('panel-nav')
    await expect(page.locator('.stage')).toHaveCount(0)

    // A moderator disconnects you: the same place.
    await joinLounge(page)
    await lounge(owner).locator('.voice-participants li', { hasText: 'Friend' }).click({ button: 'right' })
    await owner.getByRole('menuitem', { name: 'Disconnect from voice' }).click()
    await expect(page.locator('.stage')).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => panel(page)).toBe('panel-nav')
    await page.waitForTimeout(350)
    await page.screenshot({ path: join(SHOTS, 'phone-back-disconnected.png') })

    // A wide window is as before: the chat shows, no drawer.
    await lounge(owner).getByRole('button').first().click()
    await expect(owner.locator('.stage')).toBeVisible(VOICE_JOIN)
    await owner.locator('.call-controls').getByRole('button', { name: 'Leave call' }).click()
    await expect(owner.locator('.stage')).toHaveCount(0)
    await expect(owner.getByRole('heading', { name: 'general', exact: true })).toBeVisible()
    expect(await panel(owner)).toBe('panel-none')
  })

  test('a call with a friend ends in their conversation', async ({ browser }) => {
    const calls = await startServer('Pocket Calls', true)
    try {
      const owner = await (await browser.newContext()).newPage()
      await joinVia(owner, calls.ownerLink(), 'Caller')
      const page = await phonePage(browser)
      await joinVia(page, await createInviteLink(owner), 'Pocket')
      await owner.locator('.member-list').getByRole('button', { name: 'Pocket' }).click()
      await owner.getByRole('button', { name: 'Add friend' }).click()
      await owner.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
      await owner.getByRole('button', { name: 'Start voice call' }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'Accept' }).click()
      const call = page.locator('.call-panel')
      await expect(call.locator('.call-status')).toHaveText(/^\d+:\d\d$/, { timeout: 20_000 })
      // Back shows the conversations and the call carries on.
      await page.goBack()
      await expect.poll(() => panel(page)).toBe('panel-nav')
      await page.goBack()
      await expect.poll(() => panel(page)).toBe('panel-none')
      await expect(call.locator('.call-status')).toHaveText(/^\d+:\d\d$/)
      // Hanging up: the conversation with that person stays on screen, ready to type in.
      await call.getByRole('button', { name: 'Hang up' }).click()
      await expect(call).toHaveCount(0, { timeout: 10_000 })
      await expect(page.getByPlaceholder('Message Caller')).toBeVisible()
      expect(await panel(page)).toBe('panel-none')
      await page.screenshot({ path: join(SHOTS, 'phone-back-after-dm-call.png') })
    } finally {
      await calls.stop()
    }
  })
})

test('phone: back goes up one level and keeps what you typed', async ({ browser }) => {
  test.setTimeout(120_000)
  const server = await startServer('Pocket Back')
  try {
    const page = await phonePage(browser)

    // ── First run: back goes up a step (it used to leave the page), and the name typed so far stays ──
    await page.goto(server.ownerLink())
    await expect(page.getByText("You've been invited")).toBeVisible()
    await agreeToTerms(page)
    const imNew = page.getByRole('button', { name: /I'm new to Iskra/ })
    await imNew.click()
    await page.getByLabel('Your name').fill('Ho')
    await page.goBack()
    await expect(imNew).toBeVisible()
    await page.getByRole('button', { name: /I already use Iskra/ }).click()
    await page.getByRole('button', { name: /recovery key/i }).click()
    await expect(page.getByPlaceholder('ISKRA-XXXX-XXXX-…')).toBeVisible()
    await nativeBack(page) // the phone app's back button: the same steps
    await expect(page.getByRole('button', { name: /recovery key/i })).toBeVisible()
    await nativeBack(page)
    await expect(imNew).toBeVisible()
    await page.screenshot({ path: join(SHOTS, 'phone-back-first-run.png') })
    await imNew.click()
    await expect(page.getByLabel('Your name')).toHaveValue('Ho')
    await page.getByLabel('Your name').fill('Host')
    await page.getByRole('button', { name: 'Join' }).click()
    await expect(page.getByRole('heading', { name: 'general', exact: true })).toBeVisible({ timeout: 15_000 })

    // ── A text channel: back shows the channels, back again the channel; the unsent message stays ──
    const composer = page.getByPlaceholder('Message #general')
    await composer.fill('half a thought')
    await page.goBack()
    await expect.poll(() => panel(page)).toBe('panel-nav')
    await page.goBack()
    await expect.poll(() => panel(page)).toBe('panel-none')
    await expect(composer).toHaveValue('half a thought')
    await composer.fill('')
    await hintGone(page)

    // ── A menu's second page: back goes to its first page (it used to close the menu), then closes it ──
    await openChannels(page)
    await page.getByRole('button', { name: '#general options' }).click()
    const menu = page.getByRole('dialog', { name: '#general options' })
    await menu.getByRole('menuitem', { name: 'Mute channel' }).click()
    await expect(menu.getByRole('button', { name: 'Back' })).toBeVisible()
    await page.screenshot({ path: join(SHOTS, 'phone-back-menu-page.png') })
    await page.goBack()
    await expect(menu.getByRole('menuitem', { name: 'Mute channel' })).toBeVisible()
    await page.goBack()
    await expect(menu).toHaveCount(0)
    expect(await panel(page)).toBe('panel-nav')

    // ── My settings: section → list → closed. A form with unsaved changes holds you there instead ──
    await openSettings(page, 'Profile')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    const sections = settings.getByRole('navigation', { name: 'Settings sections' })
    await settings.getByLabel(/About me/).fill('Half a bio')
    await page.goBack()
    await expect(settings.getByLabel(/About me/)).toHaveValue('Half a bio')
    await expect(settings.locator('.k-savebar')).toHaveClass(/nudge/)
    await expect(settings.locator('.k-savebar')).toContainText('unsaved changes')
    await page.screenshot({ path: join(SHOTS, 'phone-back-unsaved.png') })
    // The back arrow and the close button hold too.
    await settings.getByRole('button', { name: 'Back', exact: true }).click()
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(settings.getByLabel(/About me/)).toHaveValue('Half a bio')
    await settings.locator('.k-savebar').getByRole('button', { name: 'Undo' }).click()
    await page.goBack()
    await expect(sections).toBeVisible()
    await expect(settings.getByLabel(/About me/)).toHaveCount(0)
    await page.goBack()
    await expect(settings).toHaveCount(0)
    expect(await panel(page)).toBe('panel-nav')

    // ── Server settings: the same two levels ──
    const room = await openServerSettings(page, 'Channels')
    await page.goBack()
    await expect(room.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()
    await page.goBack()
    await expect(room).toHaveCount(0)

    // ── A forum: a post being written survives closing the dialog; back from a post is the list of posts ──
    await page.getByRole('button', { name: 'Create channel' }).first().click()
    const create = page.getByRole('dialog', { name: 'Create channel' })
    await create.getByRole('radio', { name: 'Forum' }).click()
    await create.getByPlaceholder('game-night').fill('help')
    await create.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('heading', { name: 'help' })).toBeVisible()
    await page.goBack() // the drawer was open
    await expect.poll(() => panel(page)).toBe('panel-none')
    await hintGone(page)
    const newPostButton = page.locator('.forum-toolbar').getByRole('button', { name: 'New post' })
    const newPost = page.getByRole('dialog', { name: 'New post' })
    await newPostButton.click()
    await newPost.getByPlaceholder("What's it about?").fill('Crash on start')
    await newPost.getByPlaceholder('Add details, links, or a picture').fill('It stops at the splash screen.')
    await page.goBack()
    await expect(newPost).toHaveCount(0)
    await newPostButton.click()
    await expect(newPost.getByPlaceholder("What's it about?")).toHaveValue('Crash on start')
    await expect(newPost.getByPlaceholder('Add details, links, or a picture')).toHaveValue('It stops at the splash screen.')
    await page.screenshot({ path: join(SHOTS, 'phone-back-post-kept.png') })
    await newPost.getByRole('button', { name: 'Post', exact: true }).click()
    const post = page.locator('.thread-panel')
    await expect(post).toBeVisible()
    await post.getByPlaceholder('Reply to the post').fill('half a reply')
    await page.goBack()
    await expect(post).toHaveCount(0)
    await expect(page.locator('.post-card', { hasText: 'Crash on start' })).toBeVisible()
    expect(await panel(page)).toBe('panel-none')
    // The reply is still there, and a new post starts empty.
    await page.locator('.post-card', { hasText: 'Crash on start' }).click()
    await expect(post.getByPlaceholder('Reply to the post')).toHaveValue('half a reply')
    await post.getByRole('button', { name: 'Back to channel' }).click()
    await newPostButton.click()
    await expect(newPost.getByPlaceholder("What's it about?")).toHaveValue('')
    await page.goBack()
    await expect(newPost).toHaveCount(0)

    // ── The inbox closes on back; the phone app's back button leaves only on a second press ──
    await page.goBack()
    await expect.poll(() => panel(page)).toBe('panel-nav')
    await page.locator('.server-rail').getByRole('button', { name: /^Inbox/ }).click()
    await expect(page.getByRole('dialog', { name: 'Inbox' })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('dialog', { name: 'Inbox' })).toHaveCount(0)
    expect(await panel(page)).toBe('panel-none')
    await page.evaluate(() => {
      const w = window as unknown as Hooks
      w.__exits = 0
      w.__iskraExitHook = () => { w.__exits = (w.__exits ?? 0) + 1 }
    })
    const exits = () => page.evaluate(() => (window as unknown as Hooks).__exits)
    await nativeBack(page)
    await expect.poll(() => panel(page)).toBe('panel-nav')
    await nativeBack(page)
    await expect.poll(() => panel(page)).toBe('panel-none')
    expect(await exits()).toBe(0)
    await nativeBack(page)
    expect(await exits()).toBe(1)
  } finally {
    await server.stop()
  }
})

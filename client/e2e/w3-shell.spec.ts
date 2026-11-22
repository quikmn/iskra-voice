// UI wave 3, the shell part: first run fits 1280×720 in two steps, a message's "⋯" menu stays in the chat pane, a server
// emoji without its picture is a ":name:" chip, and the member list has one order on desktop and phone.
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, joinVia, longPress, openServerSettings, send, serverRoom, SHOTS, startServer, type TestServer } from './helpers'

// A server per test: its owner link works once.
let server: TestServer
test.beforeEach(async () => {
  server = await startServer('Wave Three')
})
test.afterEach(async () => server?.stop())

const DESKTOP = { width: 1280, height: 720 }
const PHONE = { width: 390, height: 844 }

// A 3×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=', 'base64')

const box = async (target: Locator) => {
  const b = (await target.boundingBox())!
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height }
}

/** The first-run card is whole and in the middle: nothing to scroll, nothing cut off. */
async function expectCardFits(page: Page, what: string) {
  const fit = await page.evaluate(() => {
    const frame = document.querySelector('.onboarding')!
    const card = document.querySelector('.onboarding-card')!.getBoundingClientRect()
    const root = document.documentElement
    return {
      scrolls: frame.scrollHeight > frame.clientHeight || root.scrollHeight > root.clientHeight || root.scrollWidth > root.clientWidth,
      top: card.top, bottom: card.bottom, left: card.left, right: card.right, height: innerHeight, width: innerWidth,
      // Text or a button poking out of the card.
      clipped: [...document.querySelectorAll('.onboarding-card *')].filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && (r.right > card.right + 1 || r.left < card.left - 1 || r.bottom > card.bottom + 1)
      }).length,
    }
  })
  expect(fit.scrolls, `${what}: scrolls`).toBe(false)
  expect(fit.clipped, `${what}: clipped`).toBe(0)
  expect(fit.top, what).toBeGreaterThanOrEqual(8)
  expect(fit.bottom, what).toBeLessThanOrEqual(fit.height - 8)
  expect(fit.left, what).toBeGreaterThanOrEqual(8)
  expect(fit.right, what).toBeLessThanOrEqual(fit.width - 8)
  // Centred, both ways.
  expect(Math.abs((fit.top + fit.bottom) / 2 - fit.height / 2), `${what}: centred`).toBeLessThanOrEqual(1)
  expect(Math.abs((fit.left + fit.right) / 2 - fit.width / 2), `${what}: centred`).toBeLessThanOrEqual(1)
}

for (const [size, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
  test(`first run is two steps in one centred card and fits (${size})`, async ({ browser }) => {
    const page = await (await browser.newContext({ viewport })).newPage()
    await page.goto('/')
    const agree = page.getByRole('checkbox', { name: /I agree to the Terms of Use/ })
    const go = page.getByRole('button', { name: 'Continue', exact: true })
    const choices = page.locator('.choice.rich')

    // Step 1: the terms, nothing else to decide yet.
    await expect(agree).toBeVisible()
    await expect(page.getByText('Step 1 of 2')).toBeVisible()
    await expect(choices).toHaveCount(0)
    await expect(go).toBeDisabled()
    await expectCardFits(page, 'terms')
    await page.screenshot({ path: join(SHOTS, `w3-onboarding-terms-${size}.png`) })
    // Ticking the box moves nothing (the hint keeps its line).
    const before = await box(go)
    await agree.check()
    expect(await box(go)).toEqual(before)
    await go.click()

    // Step 2: two choice cards, each with an icon and a chevron.
    await expect(page.getByText('Step 2 of 2')).toBeVisible()
    await expect(choices).toHaveCount(2)
    for (const choice of await choices.all()) {
      await expect(choice.locator('.choice-icon svg')).toBeVisible()
      await expect(choice.locator('.choice-arrow svg')).toBeVisible()
    }
    await expect(page.getByRole('button', { name: /I'm new to Iskra/ })).toBeFocused()
    await expectCardFits(page, 'choice')
    await page.screenshot({ path: join(SHOTS, `w3-onboarding-choice-${size}.png`) })

    // The screens after it fit too.
    await page.getByRole('button', { name: /I already use Iskra/ }).click()
    await expect(choices).toHaveCount(2)
    await expectCardFits(page, 'existing')
    await page.getByRole('button', { name: /Use my recovery key/ }).click()
    await expect(page.getByLabel('Recovery key')).toBeVisible()
    await expectCardFits(page, 'recovery')
    await page.getByRole('button', { name: 'Back' }).click()
    await page.getByRole('button', { name: "I'm new here" }).click()
    await expect(page.getByLabel('Your name')).toBeVisible()
    await expectCardFits(page, 'name')
    // Back to the choices: the terms aren't asked again, and there's no step count for one step.
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(choices).toHaveCount(2)
    await expect(agree).toHaveCount(0)
    await page.context().close()
  })
}

test('first run from an invite link fits too, on a computer and a phone', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: DESKTOP })).newPage()
  await joinVia(host, server.ownerLink(), 'Inviter')
  const link = await createInviteLink(host)
  for (const [size, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
    const page = await (await browser.newContext({ viewport })).newPage()
    await page.goto(link)
    await expect(page.getByText("You've been invited to Wave Three.")).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /I agree to the Terms of Use/ })).toBeVisible()
    await expectCardFits(page, `invite terms ${size}`)
    await page.screenshot({ path: join(SHOTS, `w3-onboarding-invite-terms-${size}.png`) })
    await agreeToTerms(page)
    await expect(page.getByText("You've been invited to Wave Three.")).toBeVisible()
    await expectCardFits(page, `invite choice ${size}`)
    await page.screenshot({ path: join(SHOTS, `w3-onboarding-invite-choice-${size}.png`) })
    await page.context().close()
  }
  await host.context().close()
})

test('a message\'s "⋯" menu stays in the chat pane and on screen; on a phone it is a sheet', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: DESKTOP })).newPage()
  await joinVia(host, server.ownerLink(), 'Menu Host')
  await send(host, 'menu first')
  // The recovery-key banner comes in a moment after joining and moves the page down: wait for it.
  await expect(host.getByRole('button', { name: 'Save it' })).toBeVisible()
  const menu = host.getByRole('dialog', { name: 'Message actions' })

  async function openMenu(text: string) {
    const message = host.locator('.message', { hasText: text }).last()
    await message.hover()
    const more = message.getByRole('button', { name: 'More', exact: true })
    const button = await box(more)
    await more.click()
    await expect(menu.getByRole('menuitem', { name: 'Copy text' })).toBeVisible()
    return { at: await box(menu), button }
  }
  const inWindow = (at: { left: number; top: number; right: number; bottom: number }, size: { width: number; height: number }) => {
    expect(at.left).toBeGreaterThanOrEqual(8)
    expect(at.top).toBeGreaterThanOrEqual(8)
    expect(at.right).toBeLessThanOrEqual(size.width - 8)
    expect(at.bottom).toBeLessThanOrEqual(size.height - 8)
  }

  // Near the top: under the button, its right edge on the button's, left of the member list.
  await expect(host.locator('.members-column')).toBeVisible()
  let { at, button } = await openMenu('menu first')
  const members = await box(host.locator('.members-column'))
  const pane = await box(host.locator('.messages'))
  expect(at.right).toBeLessThanOrEqual(members.left)
  expect(at.right).toBeLessThanOrEqual(pane.right)
  expect(at.left).toBeGreaterThanOrEqual(pane.left)
  expect(Math.abs(at.right - button.right)).toBeLessThanOrEqual(1)
  // The owner's menu is taller than the room under (or over) a message at 720: it slides to stay in the window.
  inWindow(at, DESKTOP)
  await host.screenshot({ path: join(SHOTS, 'w3-message-menu-desktop.png') })
  await host.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // With room under the button, that's where it opens.
  const tall = { width: 1280, height: 900 }
  await host.setViewportSize(tall)
  ;({ at, button } = await openMenu('menu first'))
  expect(at.top).toBeGreaterThanOrEqual(button.bottom)
  expect(Math.abs(at.right - button.right)).toBeLessThanOrEqual(1)
  inWindow(at, tall)
  await host.keyboard.press('Escape')
  await host.setViewportSize(DESKTOP)

  // Near the bottom: it opens upward from the button instead of running off the window.
  for (let i = 0; i < 14; i++) await send(host, `filler ${i}`)
  await send(host, 'menu last')
  ;({ at, button } = await openMenu('menu last'))
  expect(at.bottom).toBeLessThanOrEqual(button.top)
  expect(at.right).toBeLessThanOrEqual(members.left)
  expect(Math.abs(at.right - button.right)).toBeLessThanOrEqual(1)
  inWindow(at, DESKTOP)
  await host.screenshot({ path: join(SHOTS, 'w3-message-menu-desktop-bottom.png') })
  await host.keyboard.press('Escape')

  // A narrow window (the member list is a drawer there): still inside the window and the pane.
  const narrow = { width: 820, height: 600 }
  await host.setViewportSize(narrow)
  ;({ at, button } = await openMenu('menu last'))
  inWindow(at, narrow)
  expect(at.right).toBeLessThanOrEqual((await box(host.locator('.messages'))).right)
  await host.keyboard.press('Escape')

  // On a phone it's a sheet from the bottom, whole and inside the screen.
  const phone = await (await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true })).newPage()
  await joinVia(phone, await (async () => { await host.setViewportSize(DESKTOP); return createInviteLink(host) })(), 'Menu Phone')
  const theirs = phone.locator('.message', { hasText: 'menu last' }).last()
  await expect(theirs).toBeVisible()
  await longPress(phone, theirs.locator('.message-body'))
  const sheet = phone.getByRole('dialog', { name: 'Message actions' })
  await expect(sheet.getByRole('menuitem', { name: 'Reply' })).toBeVisible()
  await expect(phone.locator('.action-sheet')).toBeVisible()
  const sheetAt = await box(sheet)
  expect(sheetAt.left).toBeGreaterThanOrEqual(0)
  expect(sheetAt.right).toBeLessThanOrEqual(PHONE.width)
  expect(sheetAt.top).toBeGreaterThanOrEqual(0)
  expect(sheetAt.bottom).toBeLessThanOrEqual(PHONE.height)
  // Every row can be reached: the last one scrolls into the sheet.
  const lastRow = sheet.getByRole('menuitem').last()
  await lastRow.scrollIntoViewIfNeeded()
  expect((await box(lastRow)).bottom).toBeLessThanOrEqual(PHONE.height)
  await phone.screenshot({ path: join(SHOTS, 'w3-message-menu-phone.png') })
  await phone.context().close()
  await host.context().close()
})

test('a server emoji without its picture is a :name: chip in messages, reactions and the picker', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: DESKTOP })).newPage()
  await joinVia(host, server.ownerLink(), 'Emoji Host')
  await openServerSettings(host, 'Emoji & stickers')
  await host.locator('input[aria-label="Emoji image"]').setInputFiles({ name: 'blob.png', mimeType: 'image/png', buffer: PNG })
  await host.getByLabel('Emoji name').fill('blob')
  await host.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(host.locator('.expression-row input[aria-label="Name of :blob:"]')).toBeVisible()
  await host.keyboard.press('Escape')
  await send(host, 'look :blob: here')
  const hostMessage = host.locator('.message', { hasText: 'look' }).last()
  await expect(hostMessage.locator('.message-text img.custom-emoji[alt=":blob:"]')).toBeVisible()
  await expect(hostMessage.locator('.emoji-chip')).toHaveCount(0)
  // The host reacts with it.
  await hostMessage.hover()
  await hostMessage.getByRole('button', { name: 'Add reaction' }).click()
  await host.getByRole('menuitem', { name: 'More emoji' }).click()
  const hostPicker = host.getByRole('dialog', { name: 'Emoji picker' })
  await hostPicker.getByLabel('Search emoji').fill('blo')
  await hostPicker.getByRole('button', { name: ':blob:' }).click()
  await expect(hostMessage.locator('.reaction img.custom-emoji')).toBeVisible()
  const link = await createInviteLink(host)

  // ── Still loading: the chip holds the place, then the picture takes it.
  const slow = await (await browser.newContext({ viewport: DESKTOP })).newPage()
  let release!: () => void
  const gate = new Promise<void>((done) => { release = done })
  await slow.route(/\/files\//, async (route) => {
    await gate
    await route.continue()
  })
  await joinVia(slow, link, 'Slow')
  const slowMessage = slow.locator('.message', { hasText: 'look' }).last()
  const waiting = slowMessage.locator('.message-text .emoji-chip')
  await expect(waiting).toHaveText(':blob:')
  await expect(waiting).toHaveAttribute('data-emoji-state', 'loading')
  await expect(slowMessage.getByRole('img', { name: ':blob:' }).first()).toBeVisible()
  await slow.screenshot({ path: join(SHOTS, 'w3-emoji-loading-desktop.png') })
  release()
  await expect(slowMessage.locator('.message-text img.custom-emoji[alt=":blob:"]')).toBeVisible()
  await expect(slowMessage.locator('.emoji-chip')).toHaveCount(0)
  await slow.context().close()

  // ── The picture can't be fetched: a chip everywhere, never a broken image.
  const friend = await (await browser.newContext({ viewport: DESKTOP })).newPage()
  await friend.route(/\/files\//, (route) => route.abort())
  await joinVia(friend, link, 'Friend')
  const message = friend.locator('.message', { hasText: 'look' }).last()
  const chip = message.locator('.message-text .emoji-chip')
  await expect(chip).toHaveText(':blob:')
  await expect(chip).toHaveAttribute('data-emoji-state', 'missing')
  await expect(chip).toHaveAccessibleName(':blob: (emoji not available)')
  await expect(message.locator('.reaction .emoji-chip')).toHaveText(':blob:')
  await expect(message.locator('img')).toHaveCount(0)
  // Theme tokens, not literals: the chip's colours follow the theme's surface and text.
  const colours = await chip.evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.cssText = 'background: var(--surface-2); color: var(--text-2)'
    document.body.append(probe)
    const want = getComputedStyle(probe)
    const got = getComputedStyle(el)
    const same = got.backgroundColor === want.backgroundColor && got.color === want.color
    probe.remove()
    return same
  })
  expect(colours).toBe(true)
  // The picker: its cell shows the chip and is still called :blob:.
  await friend.getByRole('button', { name: 'Emoji', exact: true }).click()
  const picker = friend.getByRole('dialog', { name: 'Emoji picker' })
  const cell = picker.locator('.emoji-cell', { has: friend.locator('.emoji-chip') }).first()
  await expect(cell).toBeVisible()
  await expect(cell).toHaveAccessibleName(':blob:')
  const cellAt = await box(cell)
  const chipAt = await box(cell.locator('.emoji-chip'))
  expect(chipAt.left).toBeGreaterThanOrEqual(cellAt.left)
  expect(chipAt.right).toBeLessThanOrEqual(cellAt.right)
  const broken = () => friend.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.offsetWidth > 1).length)
  expect(await broken()).toBe(0)
  await friend.screenshot({ path: join(SHOTS, 'w3-emoji-fallback-desktop.png') })
  await friend.setViewportSize(PHONE)
  await expect(friend.locator('.emoji-picker-layer.sheet')).toBeVisible()
  await expect(picker.locator('.emoji-cell .emoji-chip').first()).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'w3-emoji-fallback-picker-phone.png') })
  await friend.keyboard.press('Escape')
  await expect(chip).toBeVisible()
  expect(await broken()).toBe(0)
  await friend.screenshot({ path: join(SHOTS, 'w3-emoji-fallback-phone.png') })
  await friend.context().close()

  // ── The emoji is deleted: old messages and reactions keep its name as a chip.
  await openServerSettings(host, 'Emoji & stickers')
  await host.getByRole('button', { name: 'Delete :blob:' }).click()
  await host.locator('.expression-row').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(host.locator('.expression-row input[aria-label="Name of :blob:"]')).toHaveCount(0)
  await host.keyboard.press('Escape')
  await expect(hostMessage.locator('.message-text .emoji-chip')).toHaveAccessibleName(':blob: (emoji not available)')
  await expect(hostMessage.locator('.reaction .emoji-chip')).toHaveText(':blob:')
  await expect(hostMessage.locator('img.custom-emoji')).toHaveCount(0)
  await host.screenshot({ path: join(SHOTS, 'w3-emoji-deleted-desktop.png') })
  await host.context().close()
})

test('member list: hoisted roles first in role order, then levels, offline last; the same on a phone', async ({ browser }) => {
  test.setTimeout(120_000) // five people join, three roles are made and given out
  {
    const host = await (await browser.newContext({ viewport: DESKTOP })).newPage()
    await joinVia(host, server.ownerLink(), 'Host')
    const link = await createInviteLink(host)
    const people: Record<string, Page> = {}
    for (const name of ['Mira', 'Sam', 'Bo', 'Zed']) {
      people[name] = await (await browser.newContext({ viewport: DESKTOP })).newPage()
      await joinVia(people[name], link, name)
    }
    const order = (page: Page) => page.locator('.member-list section').evaluateAll((sections) =>
      sections.map((s) => `${s.querySelector('h2')?.textContent?.trim()}: ${[...s.querySelectorAll('.member-name')].map((n) => n.textContent).join(', ')}`))
    await expect.poll(() => order(host)).toEqual(['Owner — 1: Host', 'Members — 4: Bo, Mira, Sam, Zed'])

    // Two roles shown separately (Moderator above Helper) and one that isn't.
    await openServerSettings(host, 'Roles')
    const settings = serverRoom(host, 'Wave Three')
    for (const [name, hoist] of [['Moderator', true], ['Helper', true], ['Quiet', false]] as const) {
      await settings.getByRole('button', { name: 'Create role' }).click()
      const editor = settings.getByRole('group', { name: 'Edit New role' })
      await editor.getByLabel('Role name').fill(name)
      if (hoist) await editor.getByText('Show people with this role separately').click()
      await editor.getByRole('button', { name: 'Save role' }).click()
      await expect(host.locator('.role-list .role-name', { hasText: name })).toBeVisible()
    }
    await expect(host.locator('.role-list .role-name')).toHaveText(['Moderator', 'Helper', 'Quiet'])
    await host.keyboard.press('Escape')

    // Server settings → Members → a member's details (the one way that also works for yourself). The member list
    // stays in the page behind the settings, so its order can be read without closing them.
    const room = await openServerSettings(host, 'Members')
    async function give(name: string, ...roles: string[]) {
      await room.locator('.room-member').filter({ has: host.locator('.room-member-name', { hasText: new RegExp(`^${name}\\s*$`) }) }).click()
      const dialog = host.getByRole('dialog', { name, exact: true })
      for (const role of roles) {
        await dialog.getByRole('checkbox', { name: role }).click()
        await expect(dialog.getByRole('checkbox', { name: role })).toBeChecked()
      }
      await host.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
    // Mira has both hoisted roles (shown under the higher); Sam the lower; Bo only the one that isn't shown separately.
    await give('Mira', 'Helper', 'Moderator')
    await give('Sam', 'Helper')
    await give('Bo', 'Quiet')
    await expect.poll(() => order(host)).toEqual(['Moderator — 1: Mira', 'Helper — 1: Sam', 'Owner — 1: Host', 'Members — 2: Bo, Zed'])
    // The owner has a hoisted role too: shown under it, and the Owner group is gone.
    await give('Host', 'Helper')
    await host.keyboard.press('Escape')
    await expect(room).toHaveCount(0)
    // Zed goes offline.
    await people.Zed.context().close()
    const want = ['Moderator — 1: Mira', 'Helper — 2: Host, Sam', 'Members — 1: Bo', 'Offline — 1: Zed']
    await expect.poll(() => order(host)).toEqual(want)
    await host.screenshot({ path: join(SHOTS, 'w3-member-order-desktop.png') })

    // The same list in the phone drawer.
    const phone = people.Bo
    await phone.setViewportSize(PHONE)
    await phone.getByRole('button', { name: 'Members', exact: true }).click()
    await expect(phone.locator('.members-column')).toBeInViewport()
    await expect.poll(() => order(phone)).toEqual(want)
    await phone.screenshot({ path: join(SHOTS, 'w3-member-order-phone.png') })
    for (const page of [host, people.Mira, people.Sam, people.Bo]) await page.context().close()
  }
})

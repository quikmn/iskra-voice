// Emoji and stickers from your other servers: the picker lists every server you're on; picking one from elsewhere
// copies the picture into this server (the app does it; servers never talk to each other) and the message renders it
// for everyone, as does a reaction. The same picture is kept once. Admins can take the ability away per base role.
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, SHOTS, startServer } from './helpers'

// A 3×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=', 'base64')

test('an emoji from one server can be sent and reacted with on another, and the picture is copied once', async ({ browser }) => {
  const home = await startServer('Home Base')
  const away = await startServer('Away Team')
  try {
    // Viktor owns Home Base (with an emoji) and is a member of Away Team; Friend is only on Away Team.
    const viktor = await (await browser.newContext()).newPage()
    await joinVia(viktor, home.ownerLink(), 'Viktor')
    await openServerSettings(viktor, 'Emoji & stickers')
    await viktor.locator('input[aria-label="Emoji image"]').setInputFiles({ name: 'blob.png', mimeType: 'image/png', buffer: PNG })
    await expect(viktor.getByLabel('Emoji name')).toHaveValue('blob')
    await viktor.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(viktor.locator('.expression-row input[aria-label="Name of :blob:"]')).toBeVisible()
    await viktor.keyboard.press('Escape')

    const owner = await (await browser.newContext()).newPage()
    await joinVia(owner, away.ownerLink(), 'Owner')
    await viktor.goto(await createInviteLink(owner))
    await viktor.getByRole('button', { name: 'Join server' }).click()
    await expect(viktor.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: /^Away Team/ })).toBeVisible()
    await viktor.locator('.server-rail').getByTitle('Away Team', { exact: true }).click()
    await expect(viktor.getByRole('heading', { name: 'general', exact: true })).toBeVisible()

    // Away Team's picker lists Home Base's emoji; picking it copies it over and the message shows the image for everyone.
    await viktor.getByRole('button', { name: 'Emoji', exact: true }).click()
    const picker = viktor.getByRole('dialog', { name: 'Emoji picker' })
    await expect(picker.getByRole('heading', { name: 'Home Base' })).toBeVisible()
    await viktor.screenshot({ path: join(SHOTS, 'emoji-cross-server-picker.png') })
    await picker.getByLabel('Search emoji').fill('blob')
    await picker.getByRole('button', { name: ':blob: (from Home Base)' }).click()
    await expect(picker).toHaveCount(0)
    const box = viktor.getByPlaceholder('Message #general')
    await expect(box).toHaveValue(':blob:')
    await box.press('Enter')
    const sent = owner.locator('.message-text img.custom-emoji[alt=":blob:"]')
    await expect(sent).toBeVisible()
    await expect.poll(() => sent.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(3)
    await viktor.screenshot({ path: join(SHOTS, 'emoji-cross-server-message.png') })

    // The same picture again is the same emoji on Away Team (nothing stored twice); a reaction works too.
    await viktor.getByRole('button', { name: 'Emoji', exact: true }).click()
    await picker.getByLabel('Search emoji').fill('blob')
    await picker.getByRole('button', { name: ':blob: (from Home Base)' }).click()
    await box.press('Enter')
    const blobs = owner.locator('.message-text img.custom-emoji[alt=":blob:"]')
    await expect(blobs).toHaveCount(2)
    const ids = await blobs.evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src))
    expect(ids[0]).toBe(ids[1])
    const blobMessage = (page: typeof owner) => page.locator('.message').filter({ has: page.locator('img.custom-emoji[alt=":blob:"]') }).first()
    await blobMessage(owner).hover()
    await blobMessage(owner).getByRole('button', { name: 'Add reaction' }).click()
    await owner.getByRole('menuitem', { name: 'More emoji' }).click()
    const ownerPicker = owner.getByRole('dialog', { name: 'Emoji picker' })
    await expect(ownerPicker).toBeVisible()
    await expect(ownerPicker.getByRole('heading', { name: 'Home Base' })).toHaveCount(0) // the owner isn't on Home Base
    await owner.keyboard.press('Escape')
    await blobMessage(viktor).hover()
    await blobMessage(viktor).getByRole('button', { name: 'Add reaction' }).click()
    await viktor.getByRole('menuitem', { name: 'More emoji' }).click()
    await picker.getByLabel('Search emoji').fill('blob')
    await picker.getByRole('button', { name: ':blob: (from Home Base)' }).click()
    await expect(blobMessage(owner).locator('.reaction img.custom-emoji')).toBeVisible()

    // A sticker from Home Base, sent on Away Team: the picture comes along and everyone sees it.
    await viktor.locator('.server-rail').getByTitle('Home Base', { exact: true }).click()
    await openServerSettings(viktor, 'Emoji & stickers')
    await viktor.locator('input[aria-label="Sticker image"]').setInputFiles({ name: 'hello.png', mimeType: 'image/png', buffer: PNG })
    await viktor.getByLabel('Sticker name').fill('Hello there')
    await viktor.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(viktor.getByLabel('Name of sticker Hello there')).toBeVisible()
    await viktor.keyboard.press('Escape')
    await viktor.locator('.server-rail').getByTitle('Away Team', { exact: true }).click()
    await viktor.getByRole('button', { name: 'Emoji', exact: true }).click()
    await viktor.getByRole('tab', { name: 'Stickers' }).click()
    await expect(picker.getByRole('heading', { name: 'From Home Base' })).toBeVisible()
    await viktor.screenshot({ path: join(SHOTS, 'sticker-cross-server-picker.png') })
    await picker.getByRole('button', { name: 'Send sticker Hello there' }).click()
    await expect(owner.locator('img.sticker[alt="Sticker: Hello there"]')).toBeVisible()

    // Away Team's owner turns the ability off for members: the other server's emoji leave the picker.
    const room = await openServerSettings(owner, 'Roles')
    await room.getByRole('list', { name: 'Built-in roles' }).getByRole('button', { name: /Member/ }).click()
    const powers = room.getByRole('group', { name: 'What Member can do' })
    const external = powers.getByRole('checkbox', { name: 'Use emoji and stickers from their other servers here' })
    await expect(external).toBeChecked()
    await external.uncheck()
    await powers.getByRole('button', { name: 'Save powers' }).click()
    await expect(powers.getByRole('status')).toHaveText('Saved')
    await owner.keyboard.press('Escape')
    await viktor.getByRole('button', { name: 'Emoji', exact: true }).click()
    await expect(picker.getByRole('heading', { name: 'Away Team' }).or(picker.getByRole('heading', { name: 'Smileys' }))).toBeVisible()
    await expect(picker.getByRole('heading', { name: 'Home Base' })).toHaveCount(0)
  } finally {
    await home.stop()
    await away.stop()
  }
})

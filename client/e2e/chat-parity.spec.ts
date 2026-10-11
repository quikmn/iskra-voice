import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Parity Test')
})
test.afterAll(async () => server?.stop())

// 3×2 PNGs (the last byte of the data differs, so each is its own file).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=', 'base64')
const png = (n: number) => Buffer.concat([PNG, Buffer.from([n])])

const last = (page: Page) => page.locator('.message').last()

async function moreMenu(page: Page, text: string) {
  const message = page.locator('.message', { hasText: text }).last()
  await message.hover()
  await message.getByRole('button', { name: 'More', exact: true }).click()
  return page.getByRole('menu', { name: 'Message options' })
}

test('chat parity: rich text, images, spoilers, drafts, links, unread, reactions, embeds, stickers', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // ── Rich text ──
  await send(host, '# Plans\n- snacks\n- games\nmeet <t:1760000000:D>, see [the docs](https://example.com/docs)')
  const rich = last(friend)
  await expect(rich.locator('.md-heading.md-h1')).toHaveText('Plans')
  await expect(rich.locator('.md-list li')).toHaveCount(2)
  await expect(rich.locator('.md-timestamp')).toContainText('2025')
  await rich.getByRole('link', { name: 'the docs' }).click()
  const leaving = friend.getByRole('dialog', { name: 'Leaving Iskra' })
  await expect(leaving).toContainText('example.com')
  await leaving.getByRole('button', { name: 'Go back' }).click()
  await expect(leaving).toHaveCount(0)

  await send(host, '```ts\nconst answer: number = 42 // yes\n```')
  const code = last(friend).locator('.code-wrap')
  await expect(code.locator('.tok-keyword').first()).toHaveText('const')
  await expect(code.locator('.tok-comment')).toHaveText('// yes')
  await code.hover()
  await code.getByRole('button', { name: 'Copy code' }).click()
  expect(await friend.evaluate(() => navigator.clipboard.readText())).toBe('const answer: number = 42 // yes')
  await friend.screenshot({ path: join(SHOTS, 'parity-rich-text.png') })

  // ── Several images: a grid, one of them a spoiler, then the gallery ──
  await host.locator('.composer input[type=file]').setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: png(1) },
    { name: 'two.png', mimeType: 'image/png', buffer: png(2) },
    { name: 'three.png', mimeType: 'image/png', buffer: png(3) },
  ])
  await host.locator('.pending-upload', { hasText: 'two.png' }).getByRole('button', { name: 'Mark spoiler' }).click()
  await expect(host.locator('.pending-upload', { hasText: 'SPOILER_two.png' })).toBeVisible()
  await expect(host.locator('.pending-upload .upload-progress')).toHaveCount(0)
  await host.getByPlaceholder('Message #general').press('Enter')
  const grid = last(friend).locator('.attachment-grid.n3')
  await expect(grid).toBeVisible()
  await expect(grid.getByRole('button', { name: 'Spoiler' })).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'parity-image-grid.png') })
  await grid.getByRole('button', { name: 'Spoiler' }).click()
  await grid.getByRole('button', { name: 'Open one.png' }).click()
  const gallery = friend.getByRole('dialog', { name: 'one.png' })
  await expect(gallery.locator('.lightbox-count')).toHaveText('1 / 3')
  await friend.keyboard.press('ArrowRight')
  await expect(friend.locator('.lightbox-count')).toHaveText('2 / 3')
  // A swipe to the left goes on to the next one.
  const stage = friend.locator('.lightbox-stage')
  const box = (await stage.boundingBox())!
  await friend.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2)
  await friend.mouse.down()
  await friend.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 5 })
  await friend.mouse.up()
  await expect(friend.locator('.lightbox-count')).toHaveText('3 / 3')
  await friend.screenshot({ path: join(SHOTS, 'parity-gallery.png') })
  await friend.keyboard.press('Escape')
  await expect(friend.locator('.lightbox')).toHaveCount(0)

  // ── A paste too long for one message becomes message.txt, previewed inline ──
  const long = Array.from({ length: 400 }, (_, i) => `line ${i + 1} of a very long story`).join('\n')
  await host.evaluate((text) => navigator.clipboard.writeText(text), long)
  await host.getByPlaceholder('Message #general').focus()
  await host.keyboard.press('Control+V')
  await expect(host.locator('.pending-upload', { hasText: 'message.txt' })).toBeVisible()
  await expect(host.locator('.pending-upload .upload-progress')).toHaveCount(0)
  await host.getByPlaceholder('Message #general').press('Enter')
  const textFile = last(friend).locator('.text-file')
  await expect(textFile.locator('.text-file-body')).toContainText('line 1 of a very long story')
  await expect(textFile.locator('.text-file-body')).not.toContainText('line 400')
  await textFile.getByRole('button', { name: 'Show all 400 lines' }).click()
  await expect(textFile.locator('.text-file-body')).toContainText('line 400 of a very long story')

  // ── Drafts survive a reload ──
  await friend.getByPlaceholder('Message #general').fill('half a thought')
  await friend.waitForTimeout(600)
  await friend.reload()
  await expect(friend.getByPlaceholder('Message #general')).toHaveValue('half a thought')
  await friend.getByPlaceholder('Message #general').fill('')

  // ── Reactions: who reacted ──
  await send(host, 'react to me')
  for (const page of [host, friend]) {
    const message = page.locator('.message', { hasText: 'react to me' })
    await message.hover()
    await message.getByRole('button', { name: 'Add reaction' }).click()
    await page.getByRole('menuitem').first().click()
  }
  const chip = host.locator('.message', { hasText: 'react to me' }).locator('.reaction')
  await expect(chip.locator('.count')).toHaveText('2')
  await chip.click({ button: 'right' })
  const reactions = host.getByRole('dialog', { name: 'Reactions' })
  await expect(reactions.locator('.reaction-people li')).toHaveCount(2)
  await expect(reactions).toContainText('Friend')
  await host.keyboard.press('Escape')

  // ── Copy message link, then open it from another message ──
  await send(host, 'the plan is final')
  await (await moreMenu(host, 'the plan is final')).getByRole('menuitem', { name: 'Copy message link' }).click()
  const link = await host.evaluate(() => navigator.clipboard.readText())
  expect(link).toMatch(/#\/open\/[A-Za-z0-9_-]{43}\/c\/\d+\/m\/\d+$/)
  for (let i = 0; i < 6; i++) await send(host, `filler ${i}`)
  await expect(last(friend)).toContainText('filler 5')
  await send(host, `see ${link}`)
  await last(friend).getByRole('link').click()
  await expect(friend.locator('.message.flash', { hasText: 'the plan is final' })).toBeVisible()

  // ── Mark unread: the "New messages" divider sits there when you come back ──
  await (await moreMenu(friend, 'filler 3')).getByRole('menuitem', { name: 'Mark unread' }).click()
  await friend.getByRole('button', { name: 'Direct messages' }).click()
  await friend.locator('.server-rail').getByTitle('Parity Test').click()
  const divider = friend.locator('#unread-divider')
  await expect(divider).toBeVisible()
  await expect(divider.locator('+ .message')).toContainText('filler 3')

  // ── Embeds load only when asked ──
  await send(host, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  const embed = last(friend).locator('.embed-card')
  await expect(embed.getByRole('button', { name: /Play on YouTube/ })).toBeVisible()
  await expect(friend.locator('iframe')).toHaveCount(0)
  await embed.getByRole('button', { name: /Play on YouTube/ }).click()
  await expect(embed.locator('iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1')

  // ── Stickers: the host adds one, the friend sends it ──
  await openSettings(host, 'Emoji')
  await host.locator('input[aria-label="Sticker image"]').setInputFiles({ name: 'hello.png', mimeType: 'image/png', buffer: png(9) })
  await host.getByLabel('Sticker name').fill('Hello there')
  await host.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(host.getByLabel('Name of sticker Hello there')).toBeVisible()
  await host.keyboard.press('Escape')
  await friend.getByRole('button', { name: 'Emoji', exact: true }).click()
  await friend.getByRole('tab', { name: 'Stickers' }).click()
  await friend.getByRole('button', { name: 'Send sticker Hello there' }).click()
  await expect(last(host).locator('img.sticker')).toHaveAttribute('alt', 'Sticker: Hello there')
  await host.screenshot({ path: join(SHOTS, 'parity-sticker.png') })

  // On a phone the grid and gallery still fit.
  await friend.setViewportSize({ width: 390, height: 844 })
  await friend.waitForTimeout(400)
  await friend.screenshot({ path: join(SHOTS, 'parity-mobile.png') })
})

import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Whiteboards')
})
test.afterAll(async () => server?.stop())

/** Drags across the board canvas (fractions of its size). */
async function drag(page: Page, from: [number, number], to: [number, number], steps = 12) {
  const box = (await page.locator('.wb-canvas').boundingBox())!
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await page.mouse.move(box.x + box.width * (from[0] + (to[0] - from[0]) * t), box.y + box.height * (from[1] + (to[1] - from[1]) * t + Math.sin(t * 6) * 0.03))
  }
  await page.mouse.up()
}

test('two people draw on a whiteboard channel together, live', async ({ browser }) => {
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: 'Whiteboard' }).click()
  await create.getByPlaceholder('game-night').fill('plans')
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(host.getByRole('heading', { name: 'plans' })).toBeVisible()
  await expect(host.getByText('Nothing here yet. Pick a tool and start drawing.')).toBeVisible()

  await friend.locator('.channel', { hasText: 'plans' }).first().click()
  await expect(friend.getByTestId('whiteboard')).toBeVisible()
  const hostCanvas = host.locator('.wb-canvas')
  const friendCanvas = friend.locator('.wb-canvas')

  // The host draws with the pen; the friend sees the stroke.
  await drag(host, [0.2, 0.3], [0.5, 0.45])
  await expect(hostCanvas).toHaveAttribute('data-count', '1')
  await expect(friendCanvas).toHaveAttribute('data-count', '1')

  // The friend draws a red rectangle and an arrow at the same time as the host highlights.
  await friend.getByRole('radio', { name: 'Red' }).click()
  await friend.getByRole('radio', { name: 'Rectangle (R)' }).click()
  await host.getByRole('radio', { name: 'Highlighter (M)' }).click()
  await Promise.all([drag(friend, [0.55, 0.2], [0.8, 0.5]), drag(host, [0.15, 0.6], [0.6, 0.62])])
  await friend.getByRole('radio', { name: 'Arrow (A)' }).click()
  await drag(friend, [0.3, 0.75], [0.6, 0.7])
  await expect(hostCanvas).toHaveAttribute('data-count', '4')
  await expect(friendCanvas).toHaveAttribute('data-count', '4')

  // A sticky note with text (typed into a textarea, drawn on the canvas).
  await host.getByRole('radio', { name: 'Sticky note (N)' }).click()
  const box = (await hostCanvas.boundingBox())!
  await host.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.65)
  await host.getByLabel('Sticky note text').fill('Ship it Friday <b>not html</b>')
  await host.getByLabel('Sticky note text').press('Control+Enter')
  await expect(friendCanvas).toHaveAttribute('data-count', '5')
  await expect(friend.locator('.wb-canvas b')).toHaveCount(0)

  // Undo is per person: the friend's undo removes the friend's arrow only; redo brings it back.
  await friend.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click()
  await expect(hostCanvas).toHaveAttribute('data-count', '4')
  await friend.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)' }).click()
  await expect(hostCanvas).toHaveAttribute('data-count', '5')

  // The eraser removes the first stroke for everyone.
  await host.getByRole('radio', { name: 'Eraser (E)' }).click()
  await drag(host, [0.35, 0.3], [0.35, 0.5])
  await expect(friendCanvas).toHaveAttribute('data-count', '4')

  await host.getByRole('button', { name: 'Fit to content' }).click()
  await host.waitForTimeout(400)
  await host.screenshot({ path: join(SHOTS, 'whiteboard.png') })

  // Save as PNG.
  const download = host.waitForEvent('download')
  await host.getByRole('button', { name: 'Save as PNG' }).click()
  expect((await download).suggestedFilename()).toBe('plans.png')

  // Phone width: the board and its tools still fit; a touch drag draws.
  await friend.setViewportSize({ width: 390, height: 844 })
  await expect(friend.getByTestId('whiteboard')).toBeVisible()
  const width = await friend.evaluate(() => document.documentElement.scrollWidth)
  expect(width).toBeLessThanOrEqual(390)
  await friend.getByRole('radio', { name: 'Pen (P)' }).click()
  await drag(friend, [0.2, 0.2], [0.7, 0.3])
  await expect(hostCanvas).toHaveAttribute('data-count', '5')
  await friend.waitForTimeout(300)
  await friend.screenshot({ path: join(SHOTS, 'whiteboard-phone.png') })

  // A late visitor (after reload) gets the whole board back.
  await friend.reload()
  await friend.getByRole('button', { name: 'Open channels' }).click()
  await friend.locator('.channel', { hasText: 'plans' }).first().click()
  await expect(friend.locator('.wb-canvas')).toHaveAttribute('data-count', '5')

  // The owner clears it for everyone.
  await host.getByRole('button', { name: 'Clear the board' }).click()
  await host.getByRole('dialog', { name: 'Clear this whiteboard?' }).getByRole('button', { name: 'Clear' }).click()
  await expect(friend.locator('.wb-canvas')).toHaveAttribute('data-count', '0')
})

test('an end-to-end encrypted whiteboard syncs between members', async ({ browser }) => {
  test.setTimeout(120_000)
  const secret = await startServer('Secret Boards')
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, secret.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: 'Whiteboard' }).click()
  await create.getByPlaceholder('game-night').fill('secret-sketch')
  await create.getByTestId('e2ee-toggle').check()
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(host.getByRole('heading', { name: 'secret-sketch' })).toBeVisible()
  // Pictures would be readable on the server: not offered on encrypted boards.
  await expect(host.getByRole('button', { name: 'Add a picture' })).toHaveCount(0)

  await friend.locator('.channel', { hasText: 'secret-sketch' }).first().click()
  await expect(friend.getByTestId('whiteboard')).toBeVisible()
  await drag(host, [0.2, 0.3], [0.6, 0.4])
  await expect(friend.locator('.wb-canvas')).toHaveAttribute('data-count', '1', { timeout: 15_000 })
  await friend.getByRole('radio', { name: 'Rectangle (R)' }).click()
  await drag(friend, [0.5, 0.5], [0.8, 0.8])
  await expect(host.locator('.wb-canvas')).toHaveAttribute('data-count', '2', { timeout: 15_000 })
  // Reloaded, the board comes back decrypted.
  await friend.reload()
  await friend.locator('.channel', { hasText: 'secret-sketch' }).first().click()
  await expect(friend.locator('.wb-canvas')).toHaveAttribute('data-count', '2', { timeout: 15_000 })
  await secret.stop()
})

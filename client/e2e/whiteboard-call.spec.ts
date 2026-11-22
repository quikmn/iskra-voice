import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { callTool, createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer, VOICE_JOIN } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Board Call', true)
})
test.afterAll(async () => server?.stop())

const room = (page: Page) => page.locator('.voice-channel', { hasText: 'standup' })

async function joinRoom(page: Page) {
  await room(page).getByRole('button').first().click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
}

test('a call opens a whiteboard, both draw on it, and it stays until cleared', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('standup')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(room(host)).toBeVisible()
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  await joinRoom(host)
  await joinRoom(friend)

  // The host opens a whiteboard; the friend's button shows there's one, and shows it.
  await (await callTool(host, 'Together', 'Open a whiteboard')).click()
  await expect(host.getByTestId('whiteboard')).toBeVisible()
  await (await callTool(friend, 'Together', 'Show the whiteboard')).click()
  await expect(friend.getByTestId('whiteboard')).toBeVisible()

  const box = (await host.locator('.wb-canvas').boundingBox())!
  await host.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3)
  await host.mouse.down()
  for (let i = 1; i <= 10; i++) await host.mouse.move(box.x + box.width * (0.2 + i * 0.05), box.y + box.height * (0.3 + (i % 3) * 0.05))
  await host.mouse.up()
  await expect(friend.locator('.wb-canvas')).toHaveAttribute('data-count', '1')
  await friend.getByRole('button', { name: 'Shapes' }).click()
  await friend.getByRole('radio', { name: 'Ellipse (O)' }).click()
  const fbox = (await friend.locator('.wb-canvas').boundingBox())!
  await friend.mouse.move(fbox.x + fbox.width * 0.5, fbox.y + fbox.height * 0.5)
  await friend.mouse.down()
  await friend.mouse.move(fbox.x + fbox.width * 0.7, fbox.y + fbox.height * 0.8, { steps: 5 })
  await friend.mouse.up()
  await expect(host.locator('.wb-canvas')).toHaveAttribute('data-count', '2')
  await host.waitForTimeout(300)
  await host.screenshot({ path: join(SHOTS, 'whiteboard-call.png') })

  // In the call the bars float over the board too, at phone width as well: all on the page, none over another.
  for (const [page, name] of [[host, 'desktop'], [friend, 'phone']] as const) {
    if (name === 'phone') {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(500)
    }
    const canvas = (await page.locator('.wb-canvas').boundingBox())!
    const pills = await Promise.all(['.wb-pill-tools', '.wb-pill-actions', '.wb-pill-view'].map(async (pill) => (await page.locator(pill).boundingBox())!))
    for (const box of pills) {
      expect(box.x, name).toBeGreaterThanOrEqual(canvas.x)
      expect(box.x + box.width, name).toBeLessThanOrEqual(canvas.x + canvas.width)
      expect(box.y, name).toBeGreaterThanOrEqual(canvas.y)
      expect(box.y + box.height, name).toBeLessThanOrEqual(canvas.y + canvas.height)
    }
    expect(await page.locator('.wb-pill-tools').evaluate((el) => el.scrollWidth - el.clientWidth), name).toBeLessThanOrEqual(0)
  }
  expect(await friend.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await friend.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click()
  await expect(host.locator('.wb-canvas')).toHaveAttribute('data-count', '1')
  await friend.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)' }).click()
  await expect(host.locator('.wb-canvas')).toHaveAttribute('data-count', '2')
  await friend.screenshot({ path: join(SHOTS, 'whiteboard-call-phone.png') })
  await friend.setViewportSize({ width: 1280, height: 720 })

  // Hidden and shown again: still there. Whoever opened it can clear it, which closes it for everyone.
  await host.getByRole('button', { name: 'Hide the whiteboard' }).first().click()
  await expect(host.getByTestId('whiteboard')).toHaveCount(0)
  await (await callTool(host, 'Together', 'Show the whiteboard')).click()
  await expect(host.locator('.wb-canvas')).toHaveAttribute('data-count', '2')
  await host.getByRole('button', { name: 'Clear the board' }).click()
  await host.getByRole('dialog', { name: 'Clear this whiteboard?' }).getByRole('button', { name: 'Clear' }).click()
  await expect(friend.getByTestId('whiteboard')).toHaveCount(0)
  await expect(await callTool(friend, 'Together', 'Open a whiteboard')).toBeVisible()
  await friend.keyboard.press('Escape')
})

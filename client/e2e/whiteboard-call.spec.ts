import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer, VOICE_JOIN } from './helpers'

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
  await host.locator('.call-controls').getByRole('button', { name: 'Open a whiteboard' }).click()
  await expect(host.getByTestId('whiteboard')).toBeVisible()
  await friend.locator('.call-controls').getByRole('button', { name: 'Show the whiteboard' }).click()
  await expect(friend.getByTestId('whiteboard')).toBeVisible()

  const box = (await host.locator('.wb-canvas').boundingBox())!
  await host.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3)
  await host.mouse.down()
  for (let i = 1; i <= 10; i++) await host.mouse.move(box.x + box.width * (0.2 + i * 0.05), box.y + box.height * (0.3 + (i % 3) * 0.05))
  await host.mouse.up()
  await expect(friend.locator('.wb-canvas')).toHaveAttribute('data-count', '1')
  await friend.getByRole('radio', { name: 'Ellipse (O)' }).click()
  const fbox = (await friend.locator('.wb-canvas').boundingBox())!
  await friend.mouse.move(fbox.x + fbox.width * 0.5, fbox.y + fbox.height * 0.5)
  await friend.mouse.down()
  await friend.mouse.move(fbox.x + fbox.width * 0.7, fbox.y + fbox.height * 0.8, { steps: 5 })
  await friend.mouse.up()
  await expect(host.locator('.wb-canvas')).toHaveAttribute('data-count', '2')
  await host.waitForTimeout(300)
  await host.screenshot({ path: join(SHOTS, 'whiteboard-call.png') })

  // Hidden and shown again: still there. Whoever opened it can clear it, which closes it for everyone.
  await host.getByRole('button', { name: 'Hide the whiteboard' }).first().click()
  await expect(host.getByTestId('whiteboard')).toHaveCount(0)
  await host.locator('.call-controls').getByRole('button', { name: 'Show the whiteboard' }).click()
  await expect(host.locator('.wb-canvas')).toHaveAttribute('data-count', '2')
  await host.getByRole('button', { name: 'Clear the board' }).click()
  await host.getByRole('dialog', { name: 'Clear this whiteboard?' }).getByRole('button', { name: 'Clear' }).click()
  await expect(friend.getByTestId('whiteboard')).toHaveCount(0)
  await expect(friend.locator('.call-controls').getByRole('button', { name: 'Open a whiteboard' })).toBeVisible()
})

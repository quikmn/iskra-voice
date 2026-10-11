import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Flaky Test')
})
test.afterAll(async () => server?.stop())

test('a send cut off by a dropped connection shows up once, not twice', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  // Host's socket goes through a proxy that can drop the connection right after a send reaches the server.
  let dropNext = false
  let sockets = 0
  await host.routeWebSocket(/\/ws$/, (ws) => {
    sockets++
    const upstream = ws.connectToServer()
    ws.onMessage((message) => {
      upstream.send(message)
      if (dropNext && typeof message === 'string' && message.includes('"chat.send"')) {
        dropNext = false
        // The server gets the message, but the reply never arrives: the Wi-Fi blinked.
        void ws.close({ code: 1006, reason: 'network' }).catch(() => undefined)
      }
    })
  })
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  dropNext = true
  await send(host, 'sent on flaky wifi')
  // The app reconnects, sends again with the same nonce, and the server answers with the message it already stored.
  const mine = host.locator('.message-text', { hasText: 'sent on flaky wifi' })
  await expect(host.locator('[id^="msg-"] .message-text', { hasText: 'sent on flaky wifi' })).toBeVisible({ timeout: 20_000 })
  await expect(mine).toHaveCount(1)
  expect(sockets).toBe(2) // it really did reconnect
  await expect(host.locator('.message-failed')).toHaveCount(0)
  await expect(host.locator('.message.sending')).toHaveCount(0)
  await expect(friend.locator('.message-text', { hasText: 'sent on flaky wifi' })).toHaveCount(1)
  await host.screenshot({ path: join(SHOTS, 'resend-after-drop.png') })

  // Later sends work normally.
  await send(host, 'and this one too')
  await expect(friend.locator('.message-text', { hasText: 'and this one too' })).toHaveCount(1)
  await expect(host.locator('.message-text', { hasText: 'and this one too' })).toHaveCount(1)
})

import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeEach(async () => {
  server = await startServer('E2EE Binding')
})
test.afterEach(async () => server?.stop())

async function setLevel(page: Page, name: string, level: string) {
  await page.locator('.member-list').getByRole('button', { name }).click()
  await page.getByRole('dialog', { name: `Profile of ${name}` }).getByRole('button', { name: 'More' }).click()
  const dialog = page.getByRole('dialog', { name })
  await dialog.getByLabel('Base role').selectOption(level)
  await expect(dialog.getByLabel('Base role')).toHaveValue(level)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
}

const channelRow = (page: Page, name: string) => page.locator('.channel', { hasText: name })
const text = (page: Page, t: string) => page.locator('.message-text', { hasText: t })

async function say(page: Page, t: string) {
  const box = page.getByPlaceholder('Message #vault')
  await box.fill(t)
  await box.press('Enter')
  await expect(page.locator('.message', { hasText: t })).not.toHaveClass(/sending/)
}

test('encrypted messages are bound to their place: a lying server can’t move, replay or postdate them', async ({ browser }) => {
  test.setTimeout(180_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const link = await createInviteLink(host)

  // Bob's app talks to the server through a man in the middle the test controls: it plays a malicious server.
  const tamper = { replay: false, move: false, capture: false, late: '' }
  const bob = await (await browser.newContext()).newPage()
  await bob.routeWebSocket(/\/ws$/, (ws) => {
    const upstream = ws.connectToServer()
    upstream.onMessage((raw) => {
      if (typeof raw !== 'string') return ws.send(raw)
      const frame = JSON.parse(raw)
      const m = frame.type === 'chat.message' ? frame.body?.message : undefined
      if (m?.e2ee) {
        if (tamper.capture) {
          tamper.capture = false
          tamper.late = m.author
        }
        if (tamper.move && m.e2ee.envelope.header.thread) {
          // A thread's message shown in its parent channel.
          m.channelId = m.e2ee.envelope.header.channel
          return ws.send(JSON.stringify(frame))
        }
        ws.send(raw)
        if (tamper.replay) {
          // The same envelope again, under a new message id.
          tamper.replay = false
          ws.send(JSON.stringify({ ...frame, body: { ...frame.body, nonce: null, message: { ...m, id: m.id + 100_000 } } }))
        }
        return
      }
      if (frame.type === 'result' && tamper.late && Array.isArray(frame.body?.messages)) {
        // History claiming the removed member wrote later than they did.
        for (const h of frame.body.messages) if (h.author === tamper.late && h.e2ee) h.createdAt = Date.now() + 2 * 3_600_000
        return ws.send(JSON.stringify(frame))
      }
      ws.send(raw)
    })
    ws.onMessage((raw) => upstream.send(raw))
  })
  await joinVia(bob, link, 'Bob')
  const carol = await (await browser.newContext()).newPage()
  await joinVia(carol, link, 'Carol')
  await host.locator('.member-list').getByRole('button', { name: 'Carol' }).waitFor()
  await setLevel(host, 'Bob', 'trusted')
  await setLevel(host, 'Carol', 'trusted')

  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByPlaceholder('game-night').fill('vault')
  await create.getByLabel('Who can see it').selectOption('trusted')
  await create.getByTestId('e2ee-toggle').check()
  await expect(create).toContainText('3 people will be able to read it.')
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(host.getByRole('heading', { name: 'vault' })).toBeVisible()
  await channelRow(bob, 'vault').click()
  await channelRow(carol, 'vault').click()

  // Honest traffic: messages and an edit read normally, with no "older format" note.
  await say(host, 'first version')
  await expect(text(bob, 'first version')).toBeVisible({ timeout: 20_000 })
  await host.getByPlaceholder('Message #vault').press('ArrowUp')
  const edit = host.locator('.edit-box textarea')
  await edit.fill('second version')
  await edit.press('Enter')
  await expect(text(bob, 'second version')).toBeVisible({ timeout: 20_000 })
  await expect(text(bob, 'first version')).toHaveCount(0)
  await expect(bob.getByTestId('e2ee-older')).toHaveCount(0)

  // Replayed under a new id: shown as a copy, never as a second message from Host.
  tamper.replay = true
  await say(host, 'meet at the north gate')
  await expect(text(bob, 'meet at the north gate')).toHaveCount(1)
  await expect(bob.getByText('This message is a copy of an earlier one.')).toBeVisible({ timeout: 20_000 })

  // A thread's message moved into the channel: refused there.
  const root = host.locator('.message', { hasText: 'meet at the north gate' })
  await root.hover()
  await root.getByRole('button', { name: 'Start a thread' }).click()
  await host.getByRole('button', { name: 'Create thread' }).click()
  const panel = host.locator('.thread-panel')
  await expect(panel).toBeVisible()
  tamper.move = true
  const reply = panel.getByRole('textbox').last()
  await reply.fill('only for the thread')
  await reply.press('Enter')
  await expect(panel.locator('.message', { hasText: 'only for the thread' })).toBeVisible()
  await expect(bob.getByText('This message was moved here from somewhere else.')).toBeVisible({ timeout: 20_000 })
  await expect(text(bob, 'only for the thread')).toHaveCount(0)
  tamper.move = false
  await panel.getByRole('button', { name: 'Close thread' }).click()
  await bob.waitForTimeout(400)
  await bob.screenshot({ path: join(SHOTS, 'e2ee-binding-flags.png') })

  // Carol writes, then loses access. A server later claiming she wrote after that gets her message flagged.
  tamper.capture = true
  await say(carol, 'carol was here')
  await expect(text(bob, 'carol was here')).toBeVisible({ timeout: 20_000 })
  await expect(bob.getByTestId('e2ee-after-removal')).toHaveCount(0)
  expect(tamper.late).not.toBe('')
  await setLevel(host, 'Carol', 'member')
  await expect(channelRow(carol, 'vault')).toHaveCount(0)
  await host.getByTestId('e2ee-panel-open').click()
  await expect(host.getByRole('dialog', { name: 'Encryption' }).getByTestId('e2ee-members').locator('li')).toHaveCount(2, { timeout: 20_000 })
  await host.keyboard.press('Escape')
  // Bob's app has the removal (signed by whoever made it) before it reloads.
  await bob.getByTestId('e2ee-panel-open').click()
  await expect(bob.getByRole('dialog', { name: 'Encryption' }).getByTestId('e2ee-members').locator('li')).toHaveCount(2, { timeout: 20_000 })
  await bob.keyboard.press('Escape')
  await bob.reload()
  await channelRow(bob, 'vault').click()
  const flagged = bob.locator('.message', { hasText: 'carol was here' })
  await expect(flagged.getByTestId('e2ee-after-removal')).toBeVisible({ timeout: 20_000 })
  await expect(flagged.getByTestId('e2ee-after-removal')).toContainText('may not really be from them')
  await expect(bob.locator('.message', { hasText: 'second version' }).getByTestId('e2ee-after-removal')).toHaveCount(0)
  await bob.waitForTimeout(400)
  await bob.screenshot({ path: join(SHOTS, 'e2ee-after-removal.png') })

  // On a phone.
  await bob.setViewportSize({ width: 390, height: 844 })
  await expect(flagged.getByTestId('e2ee-after-removal')).toBeVisible()
  await bob.waitForTimeout(800)
  await bob.screenshot({ path: join(SHOTS, 'e2ee-after-removal-phone.png') })
})

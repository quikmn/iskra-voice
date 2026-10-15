import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
let own: TestServer | undefined
test.beforeAll(async () => {
  server = await startServer('Alerts Test')
})
test.afterAll(async () => {
  await server?.stop()
  await own?.stop()
})

test('alert words notify like a mention, and quiet hours show in the status menu', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // ── Alert words ──
  await openSettings(host, 'Notifications')
  const settings = host.getByRole('dialog', { name: 'Settings' })
  const word = settings.getByRole('textbox', { name: 'Alert me for these words' })
  await word.fill('pizza')
  await settings.getByRole('button', { name: 'Add', exact: true }).click()
  await word.fill('raid night')
  await word.press('Enter')
  await word.fill('Pizza')
  await word.press('Enter')
  await expect(settings.getByRole('alert')).toHaveText("That's already on your list.")
  await expect(settings.locator('.alert-chip')).toHaveText(['pizza', 'raid night'])

  // ── Quiet hours: the whole day, every day, letting mentions through ──
  await settings.getByRole('checkbox', { name: 'Quiet hours on a schedule' }).check()
  await settings.getByLabel('From', { exact: true }).fill('00:00')
  await settings.getByLabel('To', { exact: true }).fill('00:00')
  for (const day of ['Sun', 'Sat']) {
    const button = settings.locator('.quiet-day', { hasText: day })
    if ((await button.getAttribute('aria-pressed')) === 'false') await button.click()
  }
  await expect(settings.getByText('All day on the days you picked.')).toBeVisible()
  await settings.locator('.quiet-settings').scrollIntoViewIfNeeded()
  await host.screenshot({ path: join(SHOTS, 'alerts-settings.png') })
  await host.keyboard.press('Escape')

  await host.locator('.me-status-button').click()
  await expect(host.getByRole('menuitem', { name: 'Quiet hours all day' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'alerts-status-menu.png') })
  await host.keyboard.press('Escape')

  // ── A message with an alert word, while the host looks elsewhere ──
  await host.getByRole('button', { name: 'Direct messages' }).click()
  await send(friend, 'Anyone up for PIZZA tonight? pizzas are fine too')
  await send(friend, 'just pepperonipizza here') // not a whole word
  const bell = host.getByRole('button', { name: /^Inbox, 1 new/ })
  await expect(bell).toBeVisible()
  await bell.click()
  const inbox = host.getByRole('dialog', { name: 'Inbox' })
  await expect(inbox.locator('.inbox-row.unread', { hasText: 'Friend used one of your alert words' })).toContainText('PIZZA tonight')
  await host.screenshot({ path: join(SHOTS, 'alerts-inbox.png') })
  await host.keyboard.press('Escape')

  await host.locator('.server-icon[title="Alerts Test"]').click()
  const alerted = host.locator('.message.alerted')
  await expect(alerted).toHaveCount(1)
  await expect(alerted.locator('mark.alert-word')).toHaveText('PIZZA')
  await expect(host.locator('.message', { hasText: 'pepperonipizza' })).not.toHaveClass(/alerted/)
  await host.screenshot({ path: join(SHOTS, 'alerts-chat.png') })
})

test('code is highlighted and math is rendered, never as HTML', async ({ browser }) => {
  own = await startServer('Code Test')
  const page = await (await browser.newContext()).newPage()
  await joinVia(page, own.ownerLink(), 'Coder')
  const box = page.getByPlaceholder('Message #general')
  await box.fill('```ts\nconst greet = (name: string) => `hi ${name}` // <img src=x onerror="window.pwned=1">\n```')
  await box.press('Enter')
  await box.fill('```\ndef area(r):\n    """Circle area."""\n    return 3.14159 * r ** 2\n\nfor i in range(3):\n    print(area(i))\n```')
  await box.press('Enter')
  await send(page, 'Tickets are $5 and $10, and Euler: $e^{i\\pi} + 1 = 0$ $\\href{javascript:alert(1)}{click}$')
  await send(page, 'The integral:\n$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$')

  const tagged = page.locator('.code-block', { hasText: 'const greet' })
  await expect(tagged.locator('.hljs-keyword').first()).toHaveText('const')
  await expect(tagged.locator('.hljs-comment')).toContainText('<img src=x')
  await expect(page.locator('.code-block img')).toHaveCount(0)
  const guessed = page.locator('.code-block', { hasText: 'def area' })
  await expect(guessed.locator('code.hljs')).toBeVisible() // detected without a language tag
  await expect(guessed.locator('.hljs-keyword').first()).toHaveText('def')

  const prices = page.locator('.message', { hasText: 'Tickets are' })
  await expect(prices.locator('.message-text')).toContainText('Tickets are $5 and $10, and Euler:')
  await expect(prices.locator('.math-inline math')).toHaveCount(1)
  await expect(prices.locator('code.math-source')).toHaveText('$\\href{javascript:alert(1)}{click}$') // refused: shown as typed
  await expect(prices.locator('a, [href]')).toHaveCount(0)
  const block = page.locator('.math-block math[display="block"]')
  await expect(block).toBeVisible()
  await expect(block.locator('mfrac')).toHaveCount(1)
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined()
  await page.screenshot({ path: join(SHOTS, 'code-math.png') })

  // Phones: long code scrolls sideways inside its block, the page doesn't.
  await page.setViewportSize({ width: 390, height: 800 })
  await send(page, '```js\n' + 'const veryLongLine = ' + '"x".repeat(1); '.repeat(20) + '\n```')
  const wide = page.locator('.code-block', { hasText: 'veryLongLine' })
  await expect(wide).toBeVisible()
  await expect.poll(() => wide.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === 'auto')).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: join(SHOTS, 'code-math-phone.png') })
})

// The message list shows a focus ring when Tab brings focus there, never after a click (then typing or a hotkey).
import { expect, test } from '@playwright/test'
import { joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Focus Ring Test')
})
test.afterAll(async () => server?.stop())

test('the message list gets a focus ring from Tab, not from a click', async ({ page }) => {
  await joinVia(page, server.ownerLink(), 'Host')
  await send(page, 'hello')
  const list = page.locator('.messages').first()
  const outline = () => list.evaluate((el) => document.activeElement === el ? getComputedStyle(el).outlineStyle : 'not focused')

  await list.click({ position: { x: 200, y: 60 } })
  await page.keyboard.press('Shift') // any key makes Chromium treat the click focus as :focus-visible
  expect(await outline()).toBe('none')
  await page.screenshot({ path: `${SHOTS}/focus-ring-click.png` })

  // Keyboard users still see where they are.
  await page.locator('.composer textarea').focus()
  for (let i = 0; i < 30 && (await outline()) === 'not focused'; i++) await page.keyboard.press('Shift+Tab')
  expect(await outline()).toBe('solid')
})

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { devices, expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Link Test')
})
test.afterAll(async () => server?.stop())

async function openDm(page: Page, from: string) {
  await page.getByRole('button', { name: 'Direct messages' }).click()
  await page.locator('.dm-row', { hasText: from }).click()
}

test('link a phone with the text code, read DMs on both devices, then remove it', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // The existing device shows a link code.
  await host.getByRole('button', { name: 'Settings' }).click()
  await host.getByRole('button', { name: 'Link a device' }).click()
  await host.getByRole('button', { name: 'Show code' }).click()
  const codeBox = host.getByTestId('link-code')
  await expect(codeBox).toBeVisible()
  await expect(host.getByRole('img', { name: 'Device link QR code' })).toBeVisible()
  const code = (await codeBox.innerText()).trim()

  // The bundled QR reader (used where the browser has no BarcodeDetector, like Safari) reads our QR code.
  const scanned = await host.evaluate(async () => {
    const svg = document.querySelector('.qr-code')!
    const image = new Image()
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg))
    await image.decode()
    const canvas = Object.assign(document.createElement('canvas'), { width: 400, height: 400 })
    canvas.getContext('2d')!.drawImage(image, 0, 0, 400, 400)
    const { qrDetector } = await import('/src/ui/qrDetector.ts' as string)
    const detector = await qrDetector(false)
    return (await detector.detect(canvas))[0]?.rawValue
  })
  expect(decodeURIComponent(scanned.split('#/link/')[1])).toBe(code)
  await host.screenshot({ path: join(SHOTS, 'link-code.png') })

  // A fresh phone-sized browser types it in.
  const { defaultBrowserType: _, ...iphone } = devices['iPhone 13']
  const phone = await (await browser.newContext({ ...iphone })).newPage()
  await phone.goto('/')
  await phone.getByRole('button', { name: 'I already have Iskra' }).click()
  await phone.getByRole('button', { name: /Link with my other device/ }).click()
  await phone.getByLabel('Or type the code').fill(code)
  await phone.getByRole('button', { name: 'Link this device' }).click()

  // The phone shows a number; it has to be typed on the signed-in device before anything is sent.
  const phoneConfirm = phone.getByTestId('link-confirm')
  await expect(phoneConfirm).toHaveText(/^\d{3} \d{3}$/)
  await expect(host.getByText('Safari on iPhone')).toBeVisible()
  await expect(host.getByTestId('link-confirm')).toHaveCount(0) // the host never shows it
  await phone.screenshot({ path: join(SHOTS, 'link-confirm-phone.png') })
  await host.getByLabel('Number on the new device').fill(await phoneConfirm.innerText())
  await host.getByRole('button', { name: 'Link it', exact: true }).click()
  await expect(host.getByText('Done! Your account is on the new device.')).toBeVisible()

  // The phone is now Host, on the same server, without an invite.
  await expect(phone.getByRole('heading', { name: 'general' })).toBeVisible()
  await host.keyboard.press('Escape')

  // A DM to Host reaches both devices, each with its own keys.
  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  const box = friend.getByPlaceholder('Message Host')
  await box.fill('hello both of you 4242')
  await box.press('Enter')
  await expect(friend.locator('.message-text', { hasText: 'hello both of you 4242' })).toBeVisible()
  await openDm(host, 'Friend')
  await expect(host.locator('.message-text', { hasText: 'hello both of you 4242' })).toBeVisible()
  // Phone width: the server rail and DM list live in a drawer.
  await expect(phone.locator('.server-icon.home .badge')).toHaveText('1')
  await phone.getByRole('button', { name: 'Open channels' }).click()
  await phone.getByRole('button', { name: 'Direct messages' }).click()
  await phone.getByRole('button', { name: 'Open menu' }).first().click()
  await phone.locator('.dm-row', { hasText: 'Friend' }).click()
  await expect(phone.locator('.message-text', { hasText: 'hello both of you 4242' })).toBeVisible()
  await phone.screenshot({ path: join(SHOTS, 'link-phone-dm.png') })

  // It went out as a forward-secret (v2) envelope, sealed to each device's prekey.
  const db = readdirSync(server.world).filter((f) => f.startsWith('iskra.db')).map((f) => readFileSync(join(server.world, f)))
  expect(db.some((bytes) => bytes.includes(Buffer.from('"seal"')))).toBe(true)
  expect(db.some((bytes) => bytes.includes(Buffer.from('4242')))).toBe(false)

  // The host sees both devices and removes the phone.
  await host.getByRole('button', { name: 'Settings' }).click()
  const rows = host.locator('.device-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: 'This device' })).toHaveCount(1)
  await host.waitForTimeout(400) // let the dialog finish fading in
  await host.screenshot({ path: join(SHOTS, 'devices.png') })
  const phoneRow = rows.filter({ hasNotText: 'This device' })
  await phoneRow.getByRole('button', { name: 'Remove' }).click()
  await phoneRow.getByRole('button', { name: 'Remove' }).click()
  await expect(rows).toHaveCount(1)

  // The phone is signed out right away and can't come back.
  await expect(phone.getByText('This device was removed from your account')).toBeVisible()
  await phone.screenshot({ path: join(SHOTS, 'link-revoked.png') })
  await phone.reload()
  await expect(phone.getByText('This device was removed from your account')).toBeVisible()

  // New messages still reach the host.
  await box.fill('just you now')
  await box.press('Enter')
  await host.keyboard.press('Escape')
  await expect(host.locator('.message-text', { hasText: 'just you now' })).toBeVisible()
})

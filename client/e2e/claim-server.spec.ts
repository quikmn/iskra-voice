// Claim a server: a server made from an image ("OwnerClaim": "generate", like the DigitalOcean Marketplace droplet)
// shows a claim code on its console; the app takes its address and that code and joins as owner. On a phone.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { agreeToTerms, SHOTS, startServer } from './helpers'

test('the console code makes you the owner of a new server', async ({ browser }) => {
  const server = await startServer('Droplet', false, {}, { OwnerClaim: 'generate' })
  try {
    const codeFile = join(server.world, 'owner-claim-code.txt')
    const code = /^code=(.+)$/m.exec(readFileSync(codeFile, 'utf8'))![1]
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)

    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
    await page.goto('/')
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Owner')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'I have an invite link' }).click()
    await page.getByRole('dialog', { name: 'Join a server' }).getByRole('button', { name: 'Claim it' }).click()

    const dialog = page.getByRole('dialog', { name: 'Claim a server' })
    await dialog.getByLabel('Server address').fill(server.url)
    // A wrong code: the server's proof doesn't match it, and nothing is joined.
    const wrong = code.slice(0, -1) + (code.endsWith('0') ? '1' : '0')
    await dialog.getByLabel('Claim code').fill(wrong)
    await dialog.getByRole('button', { name: 'Check' }).click()
    await expect(dialog.getByTestId('claim-error')).toHaveText(/doesn't match this server/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.screenshot({ path: join(SHOTS, 'claim-server-wrong-code-phone.png') })

    // Typed the way people do: lower case, spaces instead of dashes.
    await dialog.getByLabel('Claim code').fill(code.toLowerCase().replaceAll('-', ' '))
    await dialog.getByRole('button', { name: 'Check' }).click()
    await expect(dialog.getByText('This is your server.')).toBeVisible()
    await expect(dialog.locator('.invite-server-name')).toHaveText('Droplet')
    await page.screenshot({ path: join(SHOTS, 'claim-server-found-phone.png') })
    await dialog.getByRole('button', { name: 'Join as owner' }).click()

    // Owner, and the code is used up.
    await expect.poll(() => existsSync(codeFile), { timeout: 15_000 }).toBe(false)
    await expect.poll(() => existsSync(join(server.world, 'owner-claim')), { timeout: 15_000 }).toBe(false)
    // The server rewrites server.json just after deleting the code file: wait for it, under load it can lag a moment.
    await expect.poll(() => JSON.parse(readFileSync(join(server.world, 'server.json'), 'utf8')).OwnerClaim ?? null, { timeout: 15_000 }).toBeNull()
  } finally {
    await server.stop()
  }
})

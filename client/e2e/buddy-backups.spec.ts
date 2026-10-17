// Backup buddies, end to end: two real servers on localhost. A friend's server makes a spot, the desktop app's
// server pairs with it and sends its encrypted daily backup there, then the app restores the server from that copy.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { agreeToTerms, appWindow, joinVia, openServerSettings, SHOTS, startServer } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const built = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/index.html'))

test.skip(!built, 'build desktop/ (npm run build) and the client (npm run build) first')

test('a friend keeps our encrypted backups, and the app restores the server from them', async ({ browser }) => {
  test.setTimeout(240_000)
  const holder = await startServer('Anna Holds')
  const source = await startServer('Bo Lives Here')
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const hostRoot = mkdtempSync(join(tmpdir(), 'iskra-hosted-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_HOST_ROOT: hostRoot, ISKRA_LOCAL_ONLY: '1' },
  })
  try {
    // Anna (on her phone) makes a spot for Bo's server on hers and gets a pairing code.
    const anna = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
    await joinVia(anna, holder.ownerLink(), 'Anna')
    await anna.getByRole('button', { name: 'Open channels' }).click()
    const annaRoom = await openServerSettings(anna, 'Backup & move')
    const hold = annaRoom.getByTestId('hold-section')
    await hold.getByLabel('Whose server is it?').fill("Bo's server")
    await hold.getByLabel('Space').selectOption({ label: '1 GB' })
    await hold.getByRole('button', { name: 'Make a spot' }).click()
    const codeBox = hold.getByTestId('spot-code')
    await expect(codeBox).toContainText('Pairing code for Bo')
    const code = (await codeBox.getByLabel('Pairing code').textContent())!.trim()
    expect(code).toMatch(/^iskra-buddy:/)
    await hold.getByTestId('spot-code').scrollIntoViewIfNeeded()
    await anna.screenshot({ path: `${SHOTS}/buddy-spot-code-phone.png` })
    await hold.getByRole('button', { name: 'Done' }).click()
    await expect(hold.getByTestId('spot-row')).toContainText('Waiting for your friend')

    // Bo, in the desktop app, owns his server and pastes the code.
    const page = await appWindow(app)
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Bo')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'I have an invite link' }).click()
    await page.getByLabel('Invite link').fill(source.ownerLink())
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
    await page.getByPlaceholder('Message #general').fill('kept safe at a friend’s')
    await page.getByPlaceholder('Message #general').press('Enter')
    await expect(page.locator('.message', { hasText: 'kept safe at a friend’s' })).toBeVisible()

    await page.locator('.server-header-button').click()
    await page.getByRole('menuitem', { name: 'More settings' }).click()
    await page.getByRole('menuitem', { name: 'Backup & move' }).click()
    const settings = page.getByRole('dialog', { name: /· Server settings$/ })
    const buddies = settings.getByTestId('buddy-section')
    await buddies.getByLabel('Pairing code from your friend').fill('not a code')
    await expect(buddies.getByText("That isn't a pairing code")).toBeVisible()
    await buddies.getByLabel('Pairing code from your friend').fill(code)
    await expect(buddies.getByText(`Backups will go to ${holder.url}.`)).toBeVisible()
    await buddies.getByRole('button', { name: 'Add backup buddy' }).click()

    // The recovery code, shown once: only Bo can open the copies.
    const recoveryBox = buddies.getByTestId('buddy-recovery')
    await expect(recoveryBox).toContainText('Save your recovery code')
    const recovery = (await recoveryBox.getByLabel('Recovery code').textContent())!.trim()
    expect(recovery).toMatch(/^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/)
    await recoveryBox.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SHOTS, 'buddy-recovery-code.png') })
    await recoveryBox.getByRole('button', { name: "I've saved it" }).click()
    await expect(recoveryBox).toBeHidden()

    // Back up now: today's daily backup goes to Anna's server, encrypted.
    await buddies.getByRole('button', { name: 'Back up now' }).click()
    const row = buddies.getByTestId('buddy-row')
    await expect(row).toContainText('Anna Holds')
    await expect(row).toContainText('Up to date', { timeout: 60_000 })
    await row.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SHOTS, 'buddy-up-to-date.png') })

    // Anna sees the copy and how much room it takes; on her disk it's an opaque blob.
    await expect(hold.getByTestId('spot-row')).toContainText('From Bo Lives Here', { timeout: 15_000 })
    await expect(hold.getByTestId('spot-row')).toContainText('1 copy (keeps 3)')
    await expect(hold.getByTestId('spot-row')).toContainText('of 1 GB')
    await hold.getByTestId('spot-row').scrollIntoViewIfNeeded()
    await anna.screenshot({ path: `${SHOTS}/buddy-holder-phone.png` })
    const held = join(holder.world, 'buddy-held')
    const spot = readdirSync(held)[0]
    const blob = readdirSync(join(held, spot)).find((f) => f.endsWith('.blob'))!
    const bytes = readFileSync(join(held, spot, blob))
    expect(bytes.subarray(0, 8).toString()).toBe('ISKRABK1')
    expect(bytes.includes(Buffer.from('kept safe at a friend'))).toBe(false)
    expect(bytes.includes(Buffer.from('SQLite format 3'))).toBe(false)
    await page.keyboard.press('Escape')

    // Bo's computer is gone: in the app, restore the server from Anna's server with the recovery code.
    await page.getByRole('button', { name: 'Join a server' }).click()
    await page.getByRole('button', { name: 'start your own server' }).click()
    await page.getByRole('button', { name: 'Restore from a backup' }).click()
    const restore = page.getByRole('dialog', { name: 'Restore a server from backup' })
    await restore.getByRole('radio', { name: "From a buddy's server" }).click()
    await restore.getByLabel("Your friend's server address").fill(holder.url)
    // A code Anna's server doesn't know is turned away.
    await restore.getByLabel('Recovery code').fill('ABCDE-FGHJK-MNPQR-STVWX-YZ012')
    await restore.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(restore.getByText(/isn't known there/)).toBeVisible({ timeout: 30_000 })
    await restore.getByLabel('Recovery code').fill(recovery.toLowerCase())
    await page.screenshot({ path: join(SHOTS, 'buddy-restore.png') })
    await restore.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(restore).toBeHidden({ timeout: 90_000 })

    // The saved server now points at the restored copy, with everything it had; Bo is still its owner.
    const folder = join(hostRoot, 'restored')
    expect(existsSync(join(folder, 'server.json'))).toBe(true)
    await source.stop()
    await expect(page.locator('.message', { hasText: 'kept safe at a friend’s' })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.me-text')).toContainText('owner')
    await page.screenshot({ path: join(SHOTS, 'buddy-restored.png') })
  } finally {
    await app.close()
    await source.stop()
    await holder.stop()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(hostRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})

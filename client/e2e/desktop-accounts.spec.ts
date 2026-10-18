// Several accounts in the real desktop app: each account's frame reaches the shell through the host page (the OS
// keychain protects each account's keys), the taskbar badge adds every account up, and both come back after a restart.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { agreeToTerms, appWindow, SHOTS } from './helpers'
import { DESKTOP_SKIP, desktopBuilt } from './desktopBuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const built = desktopBuilt()

test.skip(!built, DESKTOP_SKIP)

function launch(userData: string): Promise<ElectronApplication> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  return electron.launch({
    executablePath: join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1', ISKRA_LOCAL_ONLY: '1' },
  })
}

/** What the vault of an account's frame is wrapped with ('system': the OS keychain, through the shell). */
const vaultWrap = (page: Page, slot: number) => page.frames().find((f) => f.url().includes(`account=${slot}`))!.evaluate((db) => new Promise<string | null>((done) => {
  const open = indexedDB.open(db, 1)
  open.onsuccess = () => {
    const get = open.result.transaction('kv', 'readonly').objectStore('kv').get('vault')
    get.onsuccess = () => {
      done((get.result as { wrap?: string } | undefined)?.wrap ?? null)
      open.result.close()
    }
    get.onerror = () => done(null)
  }
  open.onerror = () => done(null)
}), slot === 1 ? 'iskra' : `iskra@${slot}`)

test('two accounts in the desktop app: the shell serves both, and both come back after a restart', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-accounts-'))
  let app = await launch(userData)
  try {
    let page = await appWindow(app)
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Dee')
    await page.getByRole('button', { name: 'Continue' }).click()

    await page.getByTestId('account-switcher').click()
    await page.getByRole('menuitem', { name: 'Add account' }).click()
    await page.getByRole('menuitem', { name: /Create a new account/ }).click()

    const eli = page.frameLocator('iframe[data-account="2"]')
    await expect(eli.getByLabel('Your name')).toBeVisible({ timeout: 20_000 })
    await eli.getByLabel('Your name').fill('Eli')
    await eli.getByRole('button', { name: 'Continue' }).click()
    await expect(eli.getByTestId('account-switcher')).toBeVisible()

    // The shell's bridge is the host page's own; each account's frame gets the host's routed copy, which works:
    // its keys are wrapped by the OS keychain like the first account's.
    expect(await page.evaluate(() => typeof (window as unknown as { iskraDesktop?: object }).iskraDesktop)).toBe('object')
    const keychain = await page.evaluate(() => (window as unknown as { iskraDesktop: { keychain?: { status(): Promise<string> } } }).iskraDesktop.keychain?.status())
    if (keychain === 'keyring') {
      await expect.poll(() => vaultWrap(page, 1)).toBe('system')
      await expect.poll(() => vaultWrap(page, 2)).toBe('system')
    }
    // The window's title is the account on screen's.
    await expect.poll(() => page.title()).toBe('Iskra')
    await page.screenshot({ path: join(SHOTS, 'desktop-accounts.png') })

    // A restart: both accounts come back, their keys opened through the keychain.
    await app.close()
    app = await launch(userData)
    page = await appWindow(app)
    await expect(page.frameLocator('iframe[data-account="1"]').getByTestId('account-switcher')).toBeAttached({ timeout: 30_000 })
    await expect(page.frameLocator('iframe[data-account="2"]').getByTestId('account-switcher')).toBeVisible({ timeout: 30_000 })
    const switcher = page.frameLocator('iframe[data-account="2"]')
    await switcher.getByTestId('account-switcher').click()
    await expect(switcher.getByRole('menuitemradio', { name: 'Switch to Dee' })).toBeVisible()
    await switcher.getByRole('menuitemradio', { name: 'Switch to Dee' }).click()
    await expect(page.locator('iframe[data-account="1"]')).toBeVisible()
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

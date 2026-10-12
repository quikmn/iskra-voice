// Settings → Updates and the owner's "Update available" notice, against a real server reading releases from a file.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, SHOTS, startServer, type TestServer } from './helpers'

const servers: TestServer[] = []
const folders: string[] = []
test.afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop()))
  for (const f of folders) rmSync(f, { recursive: true, force: true })
})

/** Two releases in GitHub's format: a normal one and a newer prerelease. */
function feedFile(): string {
  const folder = mkdtempSync(join(tmpdir(), 'iskra-feed-'))
  folders.push(folder)
  const release = (version: string, prerelease: boolean) => ({
    tag_name: `v${version}`, draft: false, prerelease, published_at: '2026-10-11T12:00:00Z',
    assets: [`iskra-server-${version}-linux-x64.tar.gz`, `iskra-server-${version}-win-x64.zip`, 'SHA256SUMS.txt'].map((name) => ({
      name, size: 1000, browser_download_url: `https://github.com/quikmn/iskra-voice/releases/download/v${version}/${name}`,
    })),
  })
  const file = join(folder, 'releases.json')
  writeFileSync(file, JSON.stringify([release('2.0.0-alpha.13', true), release('2.0.0-alpha.12', false)]))
  return file
}

test('the owner checks for updates, sees what is new and picks how updates happen', async ({ browser }) => {
  const server = await startServer('Update Night', false, {
    Updates__Version: '2.0.0-alpha.11',
    Updates__FeedFile: feedFile(),
    Updates__Rid: 'win-x64', // a standalone Windows server: told about updates, can't install them itself
  })
  servers.push(server)
  const owner = await (await browser.newContext()).newPage()
  await joinVia(owner, server.ownerLink(), 'Owner')
  const friend = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(friend, await createInviteLink(owner), 'Friend')

  await openServerSettings(owner, 'Server updates')
  const section = owner.getByTestId('updates-section')
  await expect(section.getByText('Iskra 2.0.0-alpha.11')).toBeVisible()
  await section.getByRole('button', { name: 'Check now' }).click()
  await expect(section.getByText('Update available: 2.0.0-alpha.12')).toBeVisible()
  await expect(section.getByRole('link', { name: 'What’s new' })).toHaveAttribute('href', 'https://github.com/quikmn/iskra-voice/releases/tag/v2.0.0-alpha.12')
  // Not on Linux with systemd: no "Update now", and "Install automatically" says why.
  await expect(section.getByRole('button', { name: 'Update now' })).toHaveCount(0)
  await expect(section.getByRole('radio', { name: 'Install automatically' })).toBeDisabled()
  await expect(section.getByText(/Installing by itself works on Linux servers run by systemd/)).toBeVisible()
  await expect(section.getByRole('radio', { name: 'Tell me' })).toHaveAttribute('aria-checked', 'true')
  await owner.screenshot({ path: join(SHOTS, 'server-updates-settings.png') })

  // Test versions too.
  await section.getByRole('checkbox', { name: /Include test versions/ }).click()
  await expect(section.getByText('Update available: 2.0.0-alpha.13')).toBeVisible()
  await section.getByRole('checkbox', { name: /Include test versions/ }).click()
  await expect(section.getByText('Update available: 2.0.0-alpha.12')).toBeVisible()

  // The notice above the chat, for the owner only.
  await owner.keyboard.press('Escape')
  const notice = owner.locator('.update-nudge')
  await expect(notice).toContainText('Update available for Update Night: Iskra 2.0.0-alpha.12')
  await owner.screenshot({ path: join(SHOTS, 'server-updates-notice.png') })
  await expect(friend.locator('.update-nudge')).toHaveCount(0)
  await notice.getByRole('button', { name: 'Open Updates' }).click()
  await expect(owner.getByTestId('updates-section')).toBeVisible()
  await owner.keyboard.press('Escape')
  await notice.getByRole('button', { name: 'Later' }).click()
  await expect(owner.locator('.update-nudge')).toHaveCount(0)

  // Turning checks off.
  await openServerSettings(owner, 'Server updates')
  await owner.getByTestId('updates-section').getByRole('radio', { name: 'Off' }).click()
  await expect(owner.getByTestId('updates-section').getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true')
  await expect(owner.getByText('Never looks for new versions.')).toBeVisible()
})

test('Settings → Updates fits a phone', async ({ browser }) => {
  const server = await startServer('Phone Updates', false, { Updates__Version: '2.0.0-alpha.11', Updates__FeedFile: feedFile(), Updates__Rid: 'linux-x64' })
  servers.push(server)
  const owner = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(owner, server.ownerLink(), 'Owner')
  await owner.getByRole('button', { name: 'Open channels' }).click() // phones: the channel list (and Settings) live in a drawer
  await openServerSettings(owner, 'Server updates')
  const section = owner.getByTestId('updates-section')
  await section.getByRole('button', { name: 'Check now' }).click()
  await expect(section.getByText('Update available: 2.0.0-alpha.12')).toBeVisible()
  // Linux, but not started by systemd with the guard: explained.
  await expect(section.getByText(/Add iskra-update-guard to the systemd service/)).toBeVisible()
  const overflow = await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await owner.screenshot({ path: join(SHOTS, 'server-updates-phone.png') })
})

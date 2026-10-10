import { join } from 'node:path'
import { expect, test, type Frame, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Profiles Test')
})
test.afterAll(async () => server?.stop())

// A 3×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=', 'base64')

// Tries to reach the network and to leave the sandbox, and reports what happened.
const PAGE = (exfil: string) => `<!doctype html>
<html><body style="font: 20px system-ui; padding: 24px">
<h1>Host's corner</h1>
<p id="origin"></p><p id="fetch">fetching…</p><p id="storage"></p><p id="rtc"></p>
<img src="https://example.com/track.png" alt="">
<script>
  document.getElementById('origin').textContent = 'origin: ' + window.origin
  // A same-origin child frame would have its own WebRTC.
  let rtc = 'blocked'
  try { const f = document.createElement('iframe'); document.body.append(f); if (f.contentWindow.RTCPeerConnection) rtc = 'open' } catch {}
  try { document.body.insertAdjacentHTML('beforeend', '<iframe></iframe>'); if (document.querySelector('iframe').contentWindow.RTCPeerConnection) rtc = 'open' } catch {}
  if (typeof RTCPeerConnection !== 'undefined') rtc = 'open'
  document.getElementById('rtc').textContent = 'rtc: ' + rtc
  try { localStorage.setItem('x', '1'); document.getElementById('storage').textContent = 'storage: open' }
  catch { document.getElementById('storage').textContent = 'storage: blocked' }
  fetch('/').then(() => { document.getElementById('fetch').textContent = 'fetch: worked' },
                  () => { document.getElementById('fetch').textContent = 'fetch: blocked' })
  setTimeout(() => { location.href = ${JSON.stringify(exfil)} }, 400)
</script>
</body></html>`

async function openSettings(page: Page, section?: string) {
  await page.locator('.me-bar').getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  if (section) await dialog.getByRole('button', { name: section, exact: true }).click()
}

test('profiles: avatar, bio, profile card, sandboxed page and themes', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // Host sets a picture, pronouns and a bio.
  await openSettings(host)
  await host.locator('input[aria-label="Profile picture"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG })
  await host.getByRole('button', { name: 'Use picture' }).click()
  await expect(host.getByText('Picture updated')).toBeVisible()
  await host.getByLabel('Pronouns').fill('they/them')
  await host.getByLabel(/About me/).fill('Hosting **since forever**.')
  await host.getByRole('button', { name: 'Save profile' }).click()
  await expect(host.getByText('Saved', { exact: true })).toBeVisible()

  // And publishes a page that tries to misbehave.
  await host.getByRole('button', { name: 'Make a page' }).click()
  const exfil = `${server.url}/exfil-check`
  await host.getByLabel('Page HTML').fill(PAGE(exfil))
  // The live preview runs it in the same sandbox.
  await expect.poll(async () => {
    const preview = host.frames().find((f) => f.url().startsWith('about:srcdoc') && f.parentFrame()?.url().includes('page-preview.html'))
    return preview ? await preview.locator('#fetch').textContent().catch(() => null) : null
  }).toBe('fetch: blocked')
  await host.getByRole('button', { name: 'Publish' }).click()
  await expect(host.getByText('Published', { exact: true })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'profile-page-editor.png') })
  await host.keyboard.press('Escape') // the page editor
  await host.keyboard.press('Escape') // settings

  // The friend sees the card: picture, pronouns, bio.
  const requests: string[] = []
  friend.on('requestfinished', (r) => requests.push(r.url()))
  const blocked: string[] = []
  friend.on('requestfailed', (r) => blocked.push(`${r.url()} ${r.failure()?.errorText}`))
  const avatar = friend.locator('.member-list .member', { hasText: 'Host' }).locator('img.avatar-image')
  await expect(avatar).toBeVisible()
  await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256)
  await friend.locator('.member-list').getByRole('button', { name: /Host/ }).click()
  const card = friend.getByRole('dialog', { name: 'Profile of Host' })
  await expect(card).toContainText('they/them')
  await expect(card.locator('.profile-bio strong')).toHaveText('since forever')
  await friend.waitForTimeout(300) // let the card animate in
  await friend.screenshot({ path: join(SHOTS, 'profile-card.png') })

  // The page opens without scripts: static HTML and CSS only.
  await card.getByRole('button', { name: 'Open profile page' }).click()
  const viewer = friend.getByRole('dialog', { name: "Host's page" })
  await expect(viewer).toBeVisible()
  let pageFrame: Frame | undefined
  await expect.poll(() => (pageFrame = friend.frames().find((f) => f.url().includes('/pages/'))) !== undefined).toBe(true)
  await expect(pageFrame!.locator('h1')).toHaveText("Host's corner")
  await expect(pageFrame!.locator('#fetch')).toHaveText('fetching…')
  await expect(pageFrame!.parentFrame()!.locator('iframe')).toHaveAttribute('sandbox', '')
  await expect(viewer).toContainText("Run this page's scripts? The author could learn your IP address.")
  await friend.screenshot({ path: join(SHOTS, 'profile-page-static.png') })

  // With scripts on: still an opaque origin, no storage, no fetch, no WebRTC, can't navigate away.
  await viewer.getByRole('button', { name: 'Run scripts' }).click()
  await expect.poll(() => (pageFrame = friend.frames().find((f) => f.url().includes('/pages/') && f.url().includes('scripts=1'))) !== undefined).toBe(true)
  await expect(pageFrame!.locator('#fetch')).toHaveText('fetch: blocked')
  await expect(pageFrame!.locator('#rtc')).toHaveText('rtc: blocked')
  await expect(pageFrame!.locator('#origin')).toHaveText('origin: null')
  await expect(pageFrame!.locator('#storage')).toHaveText('storage: blocked')
  const wrapper = pageFrame!.parentFrame()!
  await expect(wrapper.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(wrapper.locator('iframe')).toHaveAttribute('referrerpolicy', 'no-referrer')
  await friend.waitForTimeout(1000) // the page tries to navigate after 400 ms
  // Nothing left the sandbox: the tracking image was stopped by CSP, the navigation never happened.
  expect(requests.filter((u) => u.includes('exfil-check') || u.includes('example.com'))).toEqual([])
  expect(blocked).toContain('https://example.com/track.png csp')
  expect(friend.url()).toContain('localhost')
  await friend.screenshot({ path: join(SHOTS, 'profile-page.png') })
  await friend.keyboard.press('Escape')

  // On a phone, the card is a bottom sheet.
  await friend.setViewportSize({ width: 390, height: 844 })
  await friend.getByRole('button', { name: 'Members' }).first().click()
  await friend.locator('.member-list').getByRole('button', { name: /Host/ }).click()
  await expect(friend.locator('.profile-card-backdrop.sheet')).toBeVisible()
  await friend.waitForTimeout(300)
  await friend.screenshot({ path: join(SHOTS, 'profile-card-phone.png') })
  await friend.keyboard.press('Escape')

  // Themes: switch, survive a reload, reject a malicious one.
  await openSettings(host, 'Appearance')
  await host.getByRole('radio', { name: 'Nord' }).click()
  const accent = () => host.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
  await expect.poll(accent).toBe('#88c0d0')
  await host.screenshot({ path: join(SHOTS, 'theme-nord.png') })
  await host.reload()
  await expect(host.getByRole('heading', { name: 'general' })).toBeVisible()
  expect(await accent()).toBe('#88c0d0')
  await openSettings(host, 'Appearance')
  await host.getByRole('button', { name: 'Write your own' }).click()
  await host.getByLabel('Theme JSON').fill('{"meta":{"name":"Evil"},"colors":{"accent":"red; background:url(https://example.com/x)"}}')
  await host.getByRole('button', { name: 'Apply' }).click()
  await expect(host.locator('.theme-errors')).toContainText('colors.accent')
  expect(await accent()).toBe('#88c0d0')
  await host.getByLabel('Theme JSON').fill('{"meta":{"name":"Mine"},"colors":{"accent":"#ff8800"},"radius":2}')
  await host.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(accent).toBe('#ff8800')
  await host.getByRole('radio', { name: /Iskra \(default\)/ }).click()
  await expect.poll(accent).toBe('#7c6fff')
})

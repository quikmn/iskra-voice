// One-off: what leaks with the viewer as it was (prompt + prelude). Prints the hits.
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, startServer, type TestServer } from './helpers'
import { controlScript, probePage, startAttacker } from './leak-probe'

test.use({ launchOptions: { args: ['--allow-loopback-in-peer-connection', '--use-fake-ui-for-media-stream'] } })

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Leak Evidence')
})
test.afterAll(async () => server?.stop())

async function publish(host: Page, html: string) {
  await host.locator('.me-bar').getByRole('button', { name: 'Settings', exact: true }).click()
  const editButton = host.getByRole('button', { name: /Make a page|Edit page/ })
  await editButton.click()
  await host.getByLabel('Page HTML').fill(html)
  await host.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(host.getByText('Published', { exact: true })).toBeVisible()
  await host.keyboard.press('Escape')
  await host.keyboard.press('Escape')
}

test('evidence', async ({ browser }) => {
  test.setTimeout(180_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  const control = await startAttacker()
  await friend.evaluate(controlScript(control))
  await friend.waitForTimeout(3000)
  console.log('CONTROL (app page, no wall):', control.hits().join(', '))
  await control.close()

  for (const scripts of [false, true]) {
    const a = await startAttacker()
    await publish(host, probePage(a, true))
    await friend.locator('.member-list').getByRole('button', { name: /Host/ }).click()
    await friend.getByRole('button', { name: 'Open profile page' }).click()
    if (scripts) await friend.getByRole('button', { name: 'Run scripts' }).click()
    await friend.waitForTimeout(3000)
    console.log('FRAMES', friend.frames().map((f) => f.url().slice(0, 80)).join(' | '))
    const frame = friend.frames().find((f) => f.url().includes('/pages/'))
    console.log(`LOG (${scripts ? 'scripts' : 'static'}):`, await frame?.locator('#log').textContent().catch(() => '(unreadable)'))
    await friend.waitForTimeout(4000)
    console.log(`HITS (${scripts ? 'scripts on, prelude' : 'static'}):`, a.hits().join(', ') || 'none')
    await friend.keyboard.press('Escape')
    await a.close()
  }
})

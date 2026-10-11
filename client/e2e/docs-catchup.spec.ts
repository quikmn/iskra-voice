import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Docs and Catch-up')
})
test.afterAll(async () => server?.stop())

const WELCOME = [
  '# Welcome to the crew',
  'Read this first, then say hi in #general.',
  '',
  '## Game nights',
  '- Fridays at **20:00**',
  '- Bring snacks',
  '',
  '| Day | Game | Host |',
  '| --- | --- | :---: |',
  '| Friday | Valheim | Host |',
  '| Sunday | Chess | Friend |',
  '',
  '## Rules',
  '1. Be kind',
  '2. No spoilers',
].join('\n')

test('a docs channel: the owner writes a page, a member reads it live; then catch up on a busy channel', async ({ browser }) => {
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // The owner makes a docs channel: everyone reads, trusted and above edit.
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: 'Docs' }).click()
  await create.getByPlaceholder('game-night').fill('handbook')
  await expect(create.getByLabel('Who can edit')).toHaveValue('trusted')
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(host.getByRole('heading', { name: 'handbook' })).toBeVisible()
  await expect(host.getByText('Nothing written yet')).toBeVisible()

  // Writes the first page, with the preview beside the text.
  await host.getByRole('button', { name: 'Write the first page' }).click()
  await host.getByPlaceholder('Page title').fill('Start here')
  await host.getByLabel('Page text').fill(WELCOME)
  await expect(host.locator('.docs-preview table')).toBeVisible()
  await host.waitForTimeout(300)
  await host.screenshot({ path: join(SHOTS, 'docs-editor.png') })
  await host.getByRole('button', { name: 'Create page' }).click()
  const reader = host.locator('.docs-reader')
  await expect(reader.getByRole('heading', { name: 'Start here', level: 1 })).toBeVisible()
  await expect(reader.locator('.doc-table td', { hasText: 'Valheim' })).toBeVisible()

  // A sub-page, and "Start here" pinned above the channel list.
  await reader.getByRole('button', { name: 'Page options' }).click()
  await host.getByRole('menuitem', { name: 'Add a page inside' }).click()
  await host.getByPlaceholder('Page title').fill('Server setup')
  await host.getByLabel('Page text').fill('Install Iskra, then join with the invite link.')
  await host.getByRole('button', { name: 'Create page' }).click()
  await expect(host.locator('.docs-crumbs')).toContainText('Start here')
  await host.locator('.docs-tree-item', { hasText: 'Start here' }).click()
  await reader.getByRole('button', { name: 'Page options' }).click()
  await host.getByRole('menuitem', { name: 'Make this the Start here page' }).click()
  await expect(host.locator('.channel.start-here')).toHaveText('Start here')
  await host.screenshot({ path: join(SHOTS, 'docs-page.png') })

  // The member sees "Start here" too, reads the page, and has no Edit button.
  const start = friend.locator('.channel.start-here')
  await expect(start).toBeVisible()
  await start.click()
  const friendReader = friend.locator('.docs-reader')
  await expect(friendReader.getByRole('heading', { name: 'Start here', level: 1 })).toBeVisible()
  await expect(friendReader.locator('.md-heading', { hasText: 'Game nights' })).toBeVisible()
  await expect(friendReader.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await expect(friendReader.getByText('Pages in this section')).toBeVisible()

  // The owner edits; the member's open page updates by itself.
  await reader.getByRole('button', { name: 'Edit', exact: true }).click()
  const text = host.getByLabel('Page text')
  await text.fill(WELCOME.replace('- Bring snacks', '- Bring snacks\n- Voice chat in #lounge'))
  await host.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(friendReader.getByText('Voice chat in #lounge')).toBeVisible()

  // History shows both versions.
  await friendReader.getByRole('button', { name: 'History' }).click()
  const history = friend.getByRole('dialog', { name: /History of/ })
  await expect(history.locator('.docs-revision-row')).toHaveCount(2) // created, then edited
  await history.getByRole('button', { name: 'Close' }).click()

  // Search finds the page by its text.
  await friend.locator('.docs-filter input').fill('spoilers')
  await expect(friend.locator('.docs-tree-item.hit', { hasText: 'Start here' })).toBeVisible()
  await friend.locator('.docs-filter input').fill('')

  // On a phone the tree and the page are separate screens.
  await friend.setViewportSize({ width: 390, height: 844 })
  await expect(friendReader.getByRole('heading', { name: 'Start here', level: 1 })).toBeVisible()
  await friend.waitForTimeout(500)
  await friend.screenshot({ path: join(SHOTS, 'docs-phone.png') })
  await friend.getByRole('button', { name: 'All pages' }).click()
  await expect(friend.locator('.docs-tree-item', { hasText: 'Server setup' })).toBeVisible()
  await friend.setViewportSize({ width: 1280, height: 720 })

  // Catch up: while the owner reads docs, the friend talks a lot in #general.
  await friend.locator('.channel-list .channel', { hasText: 'general' }).click()
  await expect(friend.getByRole('heading', { name: 'general' })).toBeVisible()
  const lines = Array.from({ length: 36 }, (_, i) => `Message ${i + 1} about the raid`)
  lines[5] = '@Host can you bring the map?'
  lines[12] = 'Guide: https://example.com/raid-guide'
  for (const line of lines) {
    await send(friend, line)
    await friend.waitForTimeout(520) // the server takes 2 messages a second
  }
  await expect(friend.locator('.message', { hasText: 'Message 36 about the raid' })).toBeVisible()
  await expect(friend.locator('.message.failed')).toHaveCount(0)

  await host.locator('.channel-list .channel', { hasText: 'general' }).click()
  const catchUp = host.getByRole('button', { name: 'Catch up' })
  await expect(catchUp).toBeVisible()
  await catchUp.click()
  const panel = host.getByRole('dialog', { name: 'What you missed' })
  await expect(panel.locator('.catchup-overview')).toHaveText(/^36 messages from 1 person (in under a minute|over \d+ min); 1 mention of you, 1 link$/)
  await expect(panel.getByRole('region', { name: 'For you' })).toContainText('can you bring the map?')
  await expect(panel.getByRole('region', { name: 'Links and files' })).toContainText('example.com/raid-guide')
  await expect(panel.getByRole('region', { name: 'Who was talking' })).toContainText('Friend')
  await host.waitForTimeout(400)
  await host.screenshot({ path: join(SHOTS, 'catchup-panel.png') })

  // An item jumps to its message.
  await panel.getByRole('region', { name: 'For you' }).locator('.catchup-item').first().click()
  await expect(panel).toBeHidden()
  await expect(host.locator('.message', { hasText: 'can you bring the map?' })).toBeInViewport()

  // Phone width: the panel fits.
  await host.setViewportSize({ width: 390, height: 844 })
  await host.getByRole('button', { name: 'Catch up' }).click()
  await expect(host.getByRole('dialog', { name: 'What you missed' }).locator('.catchup-overview')).toBeVisible()
  await host.waitForTimeout(500)
  await host.screenshot({ path: join(SHOTS, 'catchup-phone.png') })
})

// Whisper and priority speakers with fake media: Alice sets up a whisper list with Bob, holds the whisper button and
// only Bob hears her (Carol, in the same channel, gets nothing); the owner talks with priority and everyone sees it.
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Whisper Test', true)
})
test.afterAll(async () => server?.stop())

const voiceChannel = (page: Page, name: string) => page.locator('.voice-channel', { hasText: name })
const whisperAudio = (page: Page) => page.locator('audio[data-whisper]')

async function joinLounge(page: Page) {
  await voiceChannel(page, 'lounge').getByRole('button').first().click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
}

test('whisper reaches only the list, and priority shows for everyone', async ({ browser }) => {
  test.setTimeout(180_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const alice = await (await browser.newContext()).newPage()
  await joinVia(alice, await createInviteLink(host), 'Alice')
  const bob = await (await browser.newContext()).newPage()
  await joinVia(bob, await createInviteLink(host), 'Bob')
  const carol = await (await browser.newContext()).newPage()
  await joinVia(carol, await createInviteLink(host), 'Carol')

  await host.getByRole('button', { name: 'Create voice channel' }).first().click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(voiceChannel(alice, 'lounge')).toBeVisible()

  // ── Alice: Settings → Voice & audio → Whisper, list 1 = Bob, named "Bob only".
  await openSettings(alice, 'Voice & audio')
  const list = alice.getByTestId('whisper-list-1')
  await list.getByLabel('Name').fill('Bob only')
  await list.getByRole('radio', { name: 'People' }).click()
  await alice.getByTestId('whisper-add-1').selectOption({ label: 'Bob' })
  await expect(list.locator('.whisper-chip')).toHaveText('Bob')
  await list.scrollIntoViewIfNeeded()
  await alice.screenshot({ path: join(SHOTS, 'whisper-settings.png') })
  await alice.keyboard.press('Escape')

  for (const page of [alice, bob, carol]) await joinLounge(page)
  await expect(voiceChannel(host, 'lounge').locator('.voice-participants li')).toHaveCount(3)

  // ── Alice holds "Whisper: Bob only": Bob is told and hears it; Carol gets nothing.
  const hold = alice.getByTestId('whisper-hold-1')
  await expect(hold).toHaveText('Whisper: Bob only')
  await hold.hover()
  await alice.mouse.down()
  await expect(alice.getByTestId('whisper-status')).toHaveText('Whispering to Bob only: 1 person hears you', { timeout: 20_000 })
  await expect(bob.getByTestId('whisper-incoming')).toHaveText('Alice is whispering to you', { timeout: 20_000 })
  await expect(whisperAudio(bob)).toHaveCount(1)
  await alice.screenshot({ path: join(SHOTS, 'whisper-whispering.png') })
  await bob.screenshot({ path: join(SHOTS, 'whisper-incoming.png') })
  await carol.waitForTimeout(1_500)
  await expect(carol.getByTestId('whisper-incoming')).toHaveCount(0)
  await expect(whisperAudio(carol)).toHaveCount(0)

  // Letting go: back to talking to the channel; Bob's indicator goes.
  await alice.mouse.up()
  await expect(alice.getByTestId('whisper-status')).toHaveCount(0)
  await expect(bob.getByTestId('whisper-incoming')).toHaveCount(0, { timeout: 10_000 })

  // ── The owner (a priority speaker) holds Priority: the badge shows for everyone in the channel list.
  await joinLounge(host)
  const priority = host.getByTestId('priority-hold')
  await priority.hover()
  await host.mouse.down()
  const hostRow = voiceChannel(carol, 'lounge').locator('.voice-participants li', { hasText: 'Host' })
  await expect(hostRow.locator('.priority-badge')).toHaveText('Priority', { timeout: 10_000 })
  await expect(host.locator('.whisper-status.priority')).toHaveText('Talking with priority')
  await carol.screenshot({ path: join(SHOTS, 'whisper-priority.png') })
  await host.mouse.up()
  await expect(hostRow.locator('.priority-badge')).toHaveCount(0, { timeout: 10_000 })

  // Members aren't priority speakers: no button for them.
  await expect(alice.getByTestId('priority-hold')).toHaveCount(0)
})

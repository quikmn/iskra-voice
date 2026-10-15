// Game nights: the owner splits a voice channel into teams (temporary team channels, everyone moved), then brings
// everyone back; a looking-for-group post fills up and pings everyone in it. Screenshots at phone width too.
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Game Night', true)
})
test.afterAll(async () => server?.stop())

const voiceChannel = (page: Page, name: string) => page.locator('.voice-channel', { hasText: name })
const PHONE = { width: 390, height: 844 }

async function joinVoice(page: Page, name: string) {
  await voiceChannel(page, name).getByRole('button').first().click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
}

test('teams: split a voice channel into team channels, then bring everyone back', async ({ browser }) => {
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const invite = await createInviteLink(host)
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, invite, 'Friend')
  const third = await (await browser.newContext()).newPage()
  await joinVia(third, invite, 'Third')

  await host.getByRole('button', { name: 'Create voice channel' }).first().click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  for (const page of [host, friend, third]) await joinVoice(page, 'lounge')
  await expect(voiceChannel(host, 'lounge').locator('.voice-participants li')).toHaveCount(3, { timeout: 15_000 })

  // The voice channel's menu: Split into teams.
  await voiceChannel(host, 'lounge').hover()
  await host.getByRole('button', { name: 'lounge options' }).click()
  await host.getByRole('menuitem', { name: 'Split into teams…' }).click()
  const dialog = host.getByRole('dialog', { name: 'Split into teams' })
  await expect(dialog.getByRole('heading', { name: 'Teams from lounge' })).toBeVisible()
  await expect(dialog.getByTestId('teams-preview').locator('.teams-card')).toHaveCount(2)
  await expect(dialog.getByTestId('teams-preview').locator('.teams-member')).toHaveCount(3)
  await dialog.getByRole('button', { name: 'Reshuffle' }).click()
  await dialog.getByRole('radio', { name: 'Balanced' }).click()
  await dialog.getByLabel("Friend's skill").fill('9')
  await expect(dialog.getByText(/Difference between the strongest and weakest team/)).toBeVisible()
  await dialog.getByLabel('Game (optional)').fill('Valheim')
  await host.screenshot({ path: join(SHOTS, 'teams-preview.png') })
  await dialog.getByTestId('teams-go').click()
  await expect(dialog).toHaveCount(0)

  // Two team channels right after the lounge; everyone's app follows the move.
  await expect(voiceChannel(friend, 'valheim-team-1')).toBeVisible()
  await expect(voiceChannel(friend, 'valheim-team-2')).toBeVisible()
  await expect(voiceChannel(host, 'lounge').locator('.voice-participants li')).toHaveCount(0, { timeout: 20_000 })
  await expect(friend.getByTestId('teams-bar')).toContainText(/You're in valheim-team-\d/, { timeout: 20_000 })
  await expect(friend.getByTestId('teams-bar').getByRole('button')).toHaveCount(0) // no move power
  await expect(host.getByTestId('teams-bar')).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'teams-split.png') })
  await third.setViewportSize(PHONE)
  await expect(third.getByTestId('teams-bar')).toBeVisible()
  await third.screenshot({ path: join(SHOTS, 'teams-split-phone.png') })

  await expect(voiceChannel(host, 'valheim-team-1').locator('.voice-participants li')).not.toHaveCount(0, { timeout: 20_000 })
  await expect(voiceChannel(host, 'valheim-team-2').locator('.voice-participants li')).not.toHaveCount(0, { timeout: 20_000 })

  // Bring everyone back: the team channels go.
  await host.getByTestId('teams-bar').getByRole('button', { name: 'Bring everyone back' }).click()
  await host.getByTestId('teams-back').click()
  await expect(voiceChannel(host, 'lounge').locator('.voice-participants li')).toHaveCount(3, { timeout: 20_000 })
  await expect(voiceChannel(friend, 'valheim-team-1')).toHaveCount(0)
  await expect(friend.getByTestId('teams-bar')).toHaveCount(0)
})

test('LFG: a post fills up, the poster hears about joins, and everyone gets the full ping', async ({ browser }) => {
  test.setTimeout(120_000)
  const lfgServer = await startServer('LFG Night')
  try {
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, lfgServer.ownerLink(), 'Buddy')
  const invite = await createInviteLink(friend)
  const host = await (await browser.newContext({ viewport: PHONE, hasTouch: true })).newPage()
  await joinVia(host, invite, 'Poster')
  const other = await (await browser.newContext()).newPage()
  await joinVia(other, invite, 'Pal')

  // "/lfg 2 Valheim" opens the dialog, filled in.
  const box = host.getByPlaceholder('Message #general')
  await box.fill('/lfg 2 Valheim')
  await box.press('Enter')
  const dialog = host.getByRole('dialog', { name: 'Looking for group' })
  await expect(dialog.getByLabel('Game')).toHaveValue('Valheim')
  await expect(dialog.getByLabel('Looking for')).toHaveValue('2')
  await dialog.getByLabel('Note (optional)').fill('Chill run')
  await host.screenshot({ path: join(SHOTS, 'lfg-dialog-phone.png') })
  await dialog.getByTestId('lfg-post').click()
  await expect(dialog).toHaveCount(0)
  await expect(box).toHaveValue('')

  const card = (page: Page) => page.getByTestId('lfg-card').last()
  await expect(card(friend)).toContainText('Valheim')
  await expect(card(friend)).toContainText('2 slots left')
  await card(friend).getByRole('button', { name: 'Join', exact: true }).click()
  await expect(card(host)).toContainText('1 slot left')
  await expect(host.getByTestId('lfg-toast')).toContainText('Buddy joined your group for Valheim')

  await card(other).getByRole('button', { name: 'Join', exact: true }).click()
  for (const page of [host, friend, other]) {
    await expect(page.getByTestId('lfg-toast')).toContainText('Your group for Valheim is full')
    await expect(card(page)).toContainText('Full: time to play!')
  }
  await expect(card(friend).getByRole('button', { name: 'Leave' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'lfg-full-phone.png') })
  } finally {
    await lfgServer.stop()
  }
})

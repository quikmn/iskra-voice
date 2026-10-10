// Backup & move and Import from Discord, against real servers.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { createInviteLink, freePort, joinVia, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

const SERVER_DLL = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/src/Iskra.Server/bin/Debug/net10.0/iskra-server.dll')

const servers: TestServer[] = []
const cleanup: (() => Promise<void> | void)[] = []
test.afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop()))
  for (const step of cleanup) await step()
})

/** A small DiscordChatExporter export: one channel in a category, a reply, reactions, a pin and a file it didn't download. */
function discordExport(): string {
  const user = (id: string, name: string, nickname: string, isBot = false) => ({
    id, name, discriminator: '0000', nickname, color: null, isBot, roles: [], avatarUrl: `https://cdn.discordapp.com/avatars/${id}/a.png`,
  })
  const ann = user('200', 'ann', 'Annie')
  const bob = user('201', 'bob', 'Bob')
  const base = { timestampEdited: null, callEndedTimestamp: null, embeds: [], stickers: [], mentions: [], inlineEmojis: [] }
  return JSON.stringify({
    guild: { id: '1', name: 'Old Discord', iconUrl: '' },
    channel: { id: '100', type: 'GuildTextChat', categoryId: '50', category: 'Games', name: 'Game Night', topic: null },
    dateRange: { after: null, before: null },
    exportedAt: '2026-01-01T00:00:00+00:00',
    messages: [
      { ...base, id: '1001', type: 'Default', timestamp: '2021-03-04T19:00:00+00:00', isPinned: true, content: 'Who is in for **Friday**?', author: ann,
        attachments: [], reactions: [
          { emoji: { id: '', name: '🎲', code: 'game_die', isAnimated: false, imageUrl: '' }, count: 4, users: [] },
          { emoji: { id: '77', name: 'pog', code: 'pog', isAnimated: false, imageUrl: '' }, count: 2, users: [] },
        ] },
      { ...base, id: '1002', type: 'Reply', timestamp: '2021-03-04T19:02:00+00:00', isPinned: false, content: 'Me! Bringing snacks', author: bob,
        attachments: [{ id: '9', url: 'https://cdn.discordapp.com/attachments/1/9/map.png', fileName: 'map.png', fileSizeBytes: 48213 }],
        reactions: [], reference: { messageId: '1001', channelId: '100', guildId: '1' } },
      { ...base, id: '1003', type: 'GuildMemberJoin', timestamp: '2021-03-04T19:03:00+00:00', isPinned: false, content: 'Joined the server.', author: bob, attachments: [], reactions: [] },
    ],
    messageCount: 3,
  })
}

test('owner imports a Discord export; it reads like the original, marked as imported', async ({ browser }) => {
  const server = await startServer('Import Night')
  servers.push(server)
  const owner = await (await browser.newContext()).newPage()
  await joinVia(owner, server.ownerLink(), 'Owner')

  // Only the owner sees the section.
  const friend = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(friend, await createInviteLink(owner), 'Friend')

  await openSettings(owner, 'Import from Discord')
  const section = owner.getByTestId('import-section')
  await expect(section.getByRole('link', { name: 'DiscordChatExporter' })).toBeVisible()
  await section.locator('input[type=file]').setInputFiles({ name: 'Old Discord - Games - Game Night [100].json', mimeType: 'application/json', buffer: Buffer.from(discordExport()) })
  await section.getByRole('button', { name: 'Import', exact: true }).click()
  const status = section.getByTestId('import-status')
  await expect(status).toContainText('2 messages')
  await expect(status).toContainText('Games')
  await expect(status).toContainText("1 file wasn't in the export")
  await owner.screenshot({ path: `${SHOTS}/import-settings.png` })

  // Straight to the channel from the summary.
  await status.getByRole('button', { name: '#game-night' }).click()
  await owner.keyboard.press('Escape')
  await expect(owner.getByRole('heading', { name: 'game-night' })).toBeVisible()
  const first = owner.locator('.message', { hasText: 'Who is in for' }).first()
  await expect(first.locator('.author')).toHaveText('Annie')
  await expect(first.getByText('Imported from Discord')).toBeVisible()
  await expect(first.locator('.imported-reactions')).toContainText('4')
  await expect(first.locator('.imported-reactions')).toContainText(':pog:')
  const reply = owner.locator('.message', { hasText: 'Bringing snacks' })
  await expect(reply.locator('.reply-author')).toContainText('Annie')
  await expect(reply.getByText('not included in the export')).toBeVisible()
  await expect(owner.locator('.message', { hasText: 'Joined the server' })).toHaveCount(0)
  await owner.screenshot({ path: `${SHOTS}/import-chat.png` })

  // Everyone sees the new channel; on a phone too.
  await friend.getByRole('button', { name: 'Open channels' }).click()
  await friend.locator('.channel', { hasText: 'game-night' }).click()
  await expect(friend.locator('.message', { hasText: 'Who is in for' }).first().getByText('Imported from Discord')).toBeVisible()
  await expect(friend.locator('.channel-sidebar')).not.toBeInViewport()
  await friend.screenshot({ path: `${SHOTS}/import-phone.png` })
})

test('owner backs up, restores the server elsewhere and moves everyone there', async ({ browser }) => {
  test.setTimeout(120_000)
  const old = await startServer('Moving Day')
  servers.push(old)
  const ownerContext = await browser.newContext()
  const owner = await ownerContext.newPage()
  await joinVia(owner, old.ownerLink(), 'Owner')
  await send(owner, 'see you on the other side')
  const friend = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(friend, await createInviteLink(owner), 'Friend')
  await expect(friend.getByText('see you on the other side')).toBeVisible()

  // Catch the download the page starts, whichever tab it lands in.
  let backup: Buffer | null = null
  await ownerContext.route('**/backup/*', async (route) => {
    const response = await route.fetch()
    backup = await response.body()
    await route.fulfill({ response })
  })

  await openSettings(owner, 'Backup & move')
  const section = owner.getByTestId('backup-section')
  await section.getByLabel('Passphrase', { exact: true }).fill('correct horse battery staple')
  await section.getByLabel('Passphrase again').fill('correct horse battery staple')
  await expect(section.getByText('Strong.')).toBeVisible()
  await section.getByRole('button', { name: 'Make backup' }).click()
  await expect(section.getByText(/Backup ready: Moving-Day-.*\.iskrabackup/)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => backup !== null, { timeout: 15_000 }).toBe(true)
  await owner.screenshot({ path: `${SHOTS}/backup-settings.png` })

  // Restore it with the command line into a new folder and run that copy on another port.
  const file = join(mkdtempSync(join(tmpdir(), 'iskra-e2e-backup-')), 'moving-day.iskrabackup')
  writeFileSync(file, backup!)
  const target = join(mkdtempSync(join(tmpdir(), 'iskra-e2e-restored-')), 'world')
  const restore = spawnSync('dotnet', [SERVER_DLL, 'restore', file, target, '--passphrase-stdin', '--json'], { input: 'correct horse battery staple\n', encoding: 'utf8' })
  expect(restore.status, restore.stderr).toBe(0)
  expect(JSON.parse(restore.stdout.trim().split('\n').at(-1)!).name).toBe('Moving Day')
  const port = await freePort()
  const settings = JSON.parse(readFileSync(join(target, 'server.json'), 'utf8'))
  writeFileSync(join(target, 'server.json'), JSON.stringify({ ...settings, Port: port, PublicUrl: null, LocalOnly: true }))
  const proc: ChildProcess = spawn('dotnet', [SERVER_DLL, target], { stdio: 'ignore' })
  const newUrl = `http://localhost:${port}`
  cleanup.push(async () => {
    if (proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r))
      proc.kill()
      await exited
    }
    rmSync(dirname(target), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(dirname(file), { recursive: true, force: true })
  })
  await expect.poll(async () => (await fetch(newUrl).catch(() => null))?.ok ?? false, { timeout: 30_000 }).toBe(true)

  // The guided move: an address that isn't this server is caught, the restored copy is recognised.
  await owner.getByRole('button', { name: 'Move this server…' }).click()
  const dialog = owner.getByRole('dialog', { name: 'Move this server' })
  await dialog.getByRole('button', { name: 'I have a backup' }).click()
  await expect(dialog.getByText('Restore from a backup')).toBeVisible()
  await dialog.getByRole('button', { name: "It's running there" }).click()
  const other = await startServer('Someone Else')
  servers.push(other)
  await dialog.getByLabel('New address').fill(other.url)
  await dialog.getByRole('button', { name: 'Check' }).click()
  await expect(dialog.getByText('A different server answers there')).toBeVisible()
  await dialog.getByLabel('New address').fill(newUrl)
  await dialog.getByRole('button', { name: 'Check' }).click()
  await expect(dialog.getByText("That's this server")).toBeVisible()
  await owner.screenshot({ path: `${SHOTS}/move-dialog.png` })
  await dialog.getByRole('button', { name: 'Move everyone' }).click()
  await expect(dialog.getByText('Everyone is being sent to')).toBeVisible()
  await dialog.locator('.modal-footer').getByRole('button', { name: 'Close' }).click()

  // Both follow the signed notice to the new address, with the history intact, and keep chatting there.
  await owner.keyboard.press('Escape')
  await expect(friend.getByText('see you on the other side')).toBeVisible()
  await openSettings(owner, 'Overview')
  await expect(owner.getByRole('dialog', { name: 'Settings' }).getByText(newUrl)).toBeVisible({ timeout: 15_000 })
  await owner.keyboard.press('Escape')
  await send(owner, 'made it')
  await expect(friend.getByText('made it')).toBeVisible({ timeout: 15_000 })
  await friend.screenshot({ path: `${SHOTS}/move-phone.png` })
})

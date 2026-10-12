// Privacy & data ("Download my data") and the owner's Security log with data retention, against a real server.
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

const servers: TestServer[] = []
test.afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop()))
})

/** The files in a zip, read through its central directory (enough for the server's exports). */
function unzip(zip: Buffer): Record<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const files: Record<string, Buffer> = {}
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10)
    const size = zip.readUInt32LE(at + 20)
    const nameLength = zip.readUInt16LE(at + 28)
    const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    const local = zip.readUInt32LE(at + 42)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const data = zip.subarray(start, start + size)
    files[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data)
    at += 46 + skip
  }
  return files
}

test('a member downloads what the server keeps about them, and what their phone keeps', async ({ browser }) => {
  const server = await startServer('Data Night')
  servers.push(server)
  const owner = await (await browser.newContext()).newPage()
  await joinVia(owner, server.ownerLink(), 'Owner')
  await send(owner, 'owner only words')

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const member = await context.newPage()
  await joinVia(member, await createInviteLink(owner), 'Mia')
  await send(member, 'mia says hello')

  let zip: Buffer | null = null
  await context.route('**/export/*', async (route) => {
    const response = await route.fetch()
    zip = await response.body()
    await route.fulfill({ response })
  })

  await member.getByRole('button', { name: 'Open channels' }).click()
  await openSettings(member, 'Privacy & data')
  const section = member.getByTestId('privacy-section')
  await expect(section.getByRole('heading', { name: 'What servers keep' })).toBeVisible()
  await section.locator('li', { hasText: 'Data Night' }).getByRole('button', { name: 'Download my data' }).click()
  await expect(section.getByText(/Downloading your data from Data Night/)).toBeVisible()
  await expect.poll(() => zip !== null, { timeout: 15_000 }).toBe(true)
  const files = unzip(zip!)
  expect(Object.keys(files).sort()).toEqual(['README.txt', 'data.json'])
  const data = JSON.parse(files['data.json'].toString('utf8'))
  expect(data.membership[0].name).toBe('Mia')
  expect(data.messages.map((m: { text: string }) => m.text)).toEqual(['mia says hello'])
  expect(files['data.json'].toString('utf8')).not.toContain('owner only words')
  await member.screenshot({ path: `${SHOTS}/privacy-phone.png` })

  // What the device keeps: a JSON file, without any keys.
  const download = member.waitForEvent('download')
  await section.getByRole('button', { name: 'Download data on this device' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^iskra-device-data-\d{4}-\d{2}-\d{2}\.json$/)
  const device = JSON.parse(readFileSync((await file.path())!, 'utf8'))
  expect(device.format).toBe('iskra-device-export/v1')
  expect(device.servers.map((s: { name: string }) => s.name)).toEqual(['Data Night'])
  expect(JSON.stringify(device)).not.toMatch(/secret/i)
  await expect(section.getByText(/Saved iskra-device-data-/)).toBeVisible()
})

test('the owner reads the security log, sets retention and exports the log', async ({ browser }) => {
  const server = await startServer('Log Night')
  servers.push(server)
  const context = await browser.newContext()
  const owner = await context.newPage()
  await joinVia(owner, server.ownerLink(), 'Owner')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(owner), 'Friend')

  // Not for anyone but the owner.
  await friend.locator('.server-header-button').click()
  await expect(friend.getByRole('menuitem', { name: 'Server settings', exact: true })).toHaveCount(0)
  await friend.keyboard.press('Escape')

  await openServerSettings(owner, 'Sign-ins & security')
  const log = owner.getByTestId('security-log-section')
  await expect(log.locator('.audit-entry', { hasText: 'Friend' }).filter({ hasText: 'Joined' })).toBeVisible()
  await expect(log.locator('.audit-entry', { hasText: 'Owner' }).filter({ hasText: 'Joined' })).toBeVisible()
  await log.getByLabel('Event').selectOption('auth.failed')
  await expect(log.getByText('No entries of this kind.')).toBeVisible()
  await log.getByLabel('Event').selectOption('')

  // Shorter retention asks first, then saves.
  const retention = owner.getByTestId('retention-section')
  await expect(retention.getByRole('spinbutton', { name: 'Security log' })).toHaveValue('365')
  await retention.getByLabel('Messages, DMs and group messages').fill('30')
  await retention.getByRole('button', { name: 'Save' }).click()
  await expect(retention.getByRole('alert')).toContainText('deleted within the hour')
  await retention.getByRole('button', { name: 'Delete and save' }).click()
  await expect(retention.getByText('Saved.')).toBeVisible()
  await expect(retention.getByLabel('Messages, DMs and group messages')).toHaveValue('30')
  await retention.getByRole('checkbox', { name: /Record IP addresses/ }).click()
  await expect(retention.getByRole('checkbox', { name: /Record IP addresses/ })).toBeChecked()

  await log.getByRole('button', { name: 'Refresh' }).click()
  await expect(log.locator('.audit-entry', { hasText: 'Changed data retention' }).first()).toBeVisible()
  await owner.screenshot({ path: `${SHOTS}/security-log.png`, fullPage: true })

  const download = owner.waitForEvent('download')
  await log.getByRole('button', { name: 'Export (JSON)' }).click()
  const exported = JSON.parse(readFileSync((await (await download).path())!, 'utf8'))
  expect(exported.format).toBe('iskra-security-log/v1')
  expect(exported.entries.map((e: { event: string }) => e.event)).toContain('retention.update')
  await expect(log.getByText(/Saved \d+ entries/)).toBeVisible()
})

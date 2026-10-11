import { join } from 'node:path'
import { devices, expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeEach(async () => {
  server = await startServer('Link History')
})
test.afterEach(async () => server?.stop())

const home = (page: Page) => page.getByRole('button', { name: 'Direct messages' }).click()

async function say(page: Page, placeholder: string, text: string) {
  const box = page.getByPlaceholder(placeholder)
  await box.fill(text)
  await box.press('Enter')
  await expect(page.locator('.message-text', { hasText: text })).toBeVisible()
}

test('a linked device brings DM and group history; groups on a removed server are archived', async ({ browser }) => {
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const link = await createInviteLink(host)
  const bob = await (await browser.newContext()).newPage()
  await joinVia(bob, link, 'Bob')
  const carol = await (await browser.newContext()).newPage()
  await joinVia(carol, link, 'Carol')

  // Some history: a group and a DM.
  await home(host)
  await host.getByRole('button', { name: 'New group' }).first().click()
  const dialog = host.getByRole('dialog', { name: 'New group' })
  await dialog.getByLabel('Group name (optional)').fill('History club')
  for (const name of ['Bob', 'Carol']) await dialog.locator('.person-pick', { hasText: name }).click()
  await dialog.getByRole('button', { name: 'Create group' }).click()
  await say(host, 'Message History club', 'group secret 5150')
  await home(bob)
  await bob.locator('.group-row', { hasText: 'History club' }).click()
  await say(bob, 'Message History club', 'bob was here 6262')
  await expect(host.locator('.message-text', { hasText: 'bob was here 6262' })).toBeVisible()
  await bob.locator('.server-icon[title="Link History"]').click()
  await bob.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await bob.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await say(bob, 'Message Host', 'dm secret 8080')

  // A long DM history on the host (written straight into its local copy), so the transfer takes several parts.
  await host.evaluate(async () => {
    const { useDms } = await import('/src/state/dms.ts' as string)
    const peer = 'Z'.repeat(43)
    const filler = 'x'.repeat(1200)
    const messages = Array.from({ length: 3000 }, (_, i) => ({ id: `old${i}`, from: peer, to: peer, text: `${i} ${filler}`, sentAt: 1_700_000_000_000 + i }))
    useDms.setState((s: { conversations: Record<string, unknown> }) => ({ conversations: { ...s.conversations, [peer]: { messages, loaded: true, unread: 0 } } }))
  })

  // Link a phone, bringing the history.
  await openSettings(host, 'Devices')
  await host.getByRole('button', { name: 'Link a device' }).click()
  await expect(host.getByLabel('Bring my message history (direct messages and groups)')).toBeChecked()
  await host.getByRole('button', { name: 'Show code' }).click()
  const code = (await host.getByTestId('link-code').innerText()).trim()
  const { defaultBrowserType: _, ...iphone } = devices['iPhone 13']
  const phone = await (await browser.newContext({ ...iphone })).newPage()
  // A slow connection, so the progress shows: each history part takes a moment to arrive.
  await phone.route('**/part/**', async (route) => {
    await new Promise((r) => setTimeout(r, 800))
    await route.continue()
  })
  await phone.goto('/')
  await phone.getByRole('button', { name: 'I already have Iskra' }).click()
  await phone.getByRole('button', { name: /Link with my other device/ }).click()
  await phone.getByLabel('Or type the code').fill(code)
  await phone.getByRole('button', { name: 'Link this device' }).click()
  await host.getByLabel('Number on the new device').fill(await phone.getByTestId('link-confirm').innerText())
  await host.getByRole('button', { name: 'Link it', exact: true }).click()
  // Both sides show progress while the parts move.
  await expect(phone.getByRole('progressbar', { name: 'History received' })).toBeVisible()
  await expect(host.getByRole('progressbar', { name: 'History sent' })).toBeVisible()
  expect(await host.evaluate(async () => {
    const { buildHistory } = await import('/src/state/link.ts' as string)
    const { PART_BYTES } = await import('/src/core/link.ts' as string)
    return buildHistory().length / PART_BYTES
  })).toBeGreaterThan(3)
  await phone.screenshot({ path: join(SHOTS, 'link-history-phone.png') })
  await expect(host.getByText('Done! Your account is on the new device.')).toBeVisible({ timeout: 60_000 })
  await expect(phone.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 60_000 })

  // The phone has all of it: the group (with its signed history) and both DM conversations.
  const counts = await phone.evaluate(async () => {
    const { useDms } = await import('/src/state/dms.ts' as string)
    const { useGroups } = await import('/src/state/groups.ts' as string)
    for (let i = 0; i < 50 && !Object.keys(useGroups.getState().groups).length; i++) await new Promise((r) => setTimeout(r, 100))
    const conversations = useDms.getState().conversations as Record<string, { messages: unknown[] }>
    return { old: conversations['Z'.repeat(43)]?.messages.length ?? 0, groups: Object.keys(useGroups.getState().groups).length }
  })
  expect(counts).toEqual({ old: 3000, groups: 1 })
  await phone.getByRole('button', { name: 'Open channels' }).click()
  await phone.getByRole('button', { name: 'Direct messages' }).click()
  await phone.getByRole('button', { name: 'Open menu' }).first().click()
  await phone.locator('.group-row', { hasText: 'History club' }).click()
  await expect(phone.locator('.message-text', { hasText: 'group secret 5150' })).toBeVisible()
  await expect(phone.locator('.message-text', { hasText: 'bob was here 6262' })).toBeVisible()
  await expect(phone.locator('.system-line', { hasText: 'You created the group with Bob and Carol' })).toBeVisible()
  await phone.getByRole('button', { name: 'Open menu' }).first().click()
  await phone.locator('.dm-row', { hasText: 'Bob' }).first().click()
  await expect(phone.locator('.message-text', { hasText: 'dm secret 8080' })).toBeVisible()

  // Carol removes the server from her list: the group is archived, read-only, and can be removed.
  await carol.locator('.server-icon[title="Link History"]').click()
  await openSettings(carol, 'Overview')
  await carol.getByRole('button', { name: 'Remove server' }).click()
  await carol.getByRole('button', { name: 'Remove', exact: true }).click()
  await home(carol)
  const archived = carol.locator('.group-row', { hasText: 'History club' })
  await expect(archived).toContainText('Archived')
  await expect(carol.getByText('Archived groups')).toBeVisible()
  await archived.click()
  await expect(carol.locator('.archived-banner')).toBeVisible()
  await expect(carol.locator('.message-text', { hasText: 'group secret 5150' })).toBeVisible()
  await expect(carol.locator('.composer.read-only')).toContainText('archived')
  // Names are remembered even though the server that knew them is gone.
  await expect(carol.locator('.group-title')).toHaveText('History club')
  await expect(carol.locator('.author', { hasText: 'Host' }).first()).toBeVisible()
  await expect(carol.getByRole('button', { name: 'Start voice call' })).toHaveCount(0)
  await carol.screenshot({ path: join(SHOTS, 'group-archived.png') })
  await carol.locator('.archived-banner').getByRole('button', { name: 'Remove' }).click()
  await expect(carol.locator('.group-row')).toHaveCount(0)
})

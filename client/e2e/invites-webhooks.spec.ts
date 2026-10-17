import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { joinVia, openServerSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Invites Webhooks Test')
})
test.afterAll(async () => server?.stop())

test('moderators see which invite people joined with, and a GitHub push becomes a card', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // ── A labelled invite.
  await host.getByRole('button', { name: 'Invite friends' }).click()
  const link = host.getByTestId('invite-link')
  await expect(link).toHaveValue(/#\/join\//)
  const unlabelled = await link.inputValue()
  await host.getByTestId('invite-label-input').fill('Reddit post')
  await host.getByTestId('invite-label-input').press('Enter')
  await expect(link).not.toHaveValue(unlabelled)
  await expect(link).toHaveValue(/#\/join\//)
  const invite = await link.inputValue()
  await expect(host.getByTestId('invite-label')).toHaveText('Reddit post')
  await host.screenshot({ path: join(SHOTS, 'invite-label.png') })
  await host.keyboard.press('Escape')

  const sam = await (await browser.newContext()).newPage()
  await joinVia(sam, invite, 'Sam')
  const kim = await (await browser.newContext()).newPage()
  await joinVia(kim, unlabelled, 'Kim')
  await expect(host.locator('.member-list')).toContainText('Kim')

  // ── Server settings → Members: who came through which invite, and a filter.
  const room = await openServerSettings(host, 'Members')
  const samRow = room.locator('.room-member', { hasText: 'Sam' })
  await expect(samRow.getByTestId('joined-via-text')).toHaveText('Joined with “Reddit post” from Host')
  await expect(room.locator('.room-member', { hasText: 'Kim' }).getByTestId('joined-via-text')).toHaveText(/^Joined with invite \S+ from Host$/)
  await room.getByTestId('join-filter').selectOption({ label: '“Reddit post” (1)' })
  await expect(room.locator('.room-member')).toHaveCount(1)
  await expect(room.locator('.room-member')).toContainText('Sam')
  await host.screenshot({ path: join(SHOTS, 'invite-joined-with.png') })
  await host.setViewportSize({ width: 390, height: 844 })
  await host.screenshot({ path: join(SHOTS, 'invite-joined-with-phone.png') })
  await host.setViewportSize({ width: 1280, height: 800 })
  await room.getByTestId('join-filter').selectOption({ label: 'Any invite' })
  await expect(room.locator('.room-member', { hasText: 'Kim' })).toBeVisible()
  // Members don't get the column (the server wouldn't tell them).
  await host.keyboard.press('Escape')

  // ── A webhook with the GitHub format and a signing secret.
  await host.getByRole('button', { name: /server options/ }).click()
  await host.getByRole('menuitem', { name: 'More settings' }).click()
  await host.getByRole('menuitem', { name: 'Bots & webhooks' }).click()
  await host.getByLabel('Name').fill('Dev')
  await host.getByRole('button', { name: 'Create webhook' }).click()
  const urlBox = host.getByLabel('Webhook URL')
  await expect(urlBox).toHaveValue(/\/hooks\/[\w-]+\/[\w-]+$/)
  await host.getByTestId('webhook-format').selectOption('github')
  await expect(urlBox).toHaveValue(/\/hooks\/[\w-]+\/[\w-]+\/github$/)
  await expect(host.getByTestId('webhook-sign-tip')).toBeVisible()
  const hookUrl = await urlBox.inputValue()
  await host.screenshot({ path: join(SHOTS, 'webhook-github-url.png') })
  await host.getByRole('button', { name: 'Done' }).click()

  await host.getByTestId('webhook-signing-open').click()
  const signing = host.getByTestId('webhook-signing')
  await expect(signing.getByTestId('webhook-signing-only')).toBeVisible()
  await signing.getByRole('button', { name: 'Generate' }).click()
  const secret = await signing.getByTestId('webhook-signing-input').inputValue()
  expect(secret).toMatch(/^[\w-]{43}$/)
  await host.screenshot({ path: join(SHOTS, 'webhook-signing-secret.png') })
  await signing.getByRole('button', { name: 'Save' }).click()
  await expect(host.locator('.hook-meta')).toContainText('signed')

  // GitHub posts a push (signed); an unsigned one is refused.
  const body = JSON.stringify({
    ref: 'refs/heads/main', compare: 'https://github.com/octocat/Hello-World/compare/6113728f27ae...59b20b8d5c6f',
    repository: { full_name: 'octocat/Hello-World', html_url: 'https://github.com/octocat/Hello-World' },
    sender: { login: 'octocat', avatar_url: 'https://tracker.example/octocat.gif' },
    commits: [{
      id: '59b20b8d5c6ff8d09518454d4dd8b7a2b5d5a4e3', message: 'Update README.md\n\nClearer setup steps',
      author: { name: 'The Octocat', username: 'octocat' }, added: [], removed: [], modified: ['README.md'],
    }],
  })
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  const refused = await fetch(hookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push' }, body })
  expect(refused.status).toBe(401)
  // A signed webhook refuses the plain (Discord-style) URL too.
  const plain = await fetch(hookUrl.replace(/\/github$/, ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'fake card' }) })
  expect(plain.status).toBe(401)
  const posted = await fetch(hookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': signature }, body,
  })
  expect(posted.status).toBe(204)
  await host.keyboard.press('Escape')

  const card = sam.locator('.message', { hasText: '[octocat/Hello-World:main] 1 new commit' })
  await expect(card).toBeVisible()
  await expect(card.locator('.embed-title a')).toHaveText('[octocat/Hello-World:main] 1 new commit')
  await expect(card).toContainText('Update README.md · The Octocat · 1 file')
  await expect(card).toContainText('Clearer setup steps')
  await expect(card.locator('img[src*="tracker.example"]')).toHaveCount(0)
  await sam.screenshot({ path: join(SHOTS, 'webhook-github-push.png') })
})

// Follows: "Follow in #general" from a member's menu makes their posts there count like a mention (inbox, marked
// message); the follow shows up under My settings → Notifications, where it can be removed.
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, send, SHOTS, startServer } from './helpers'

test('following a person in a channel puts their posts in the inbox like a mention', async ({ browser }) => {
  const server = await startServer('Follows')
  try {
    const host = await (await browser.newContext()).newPage()
    await joinVia(host, server.ownerLink(), 'Host')
    const friend = await (await browser.newContext()).newPage()
    await joinVia(friend, await createInviteLink(host), 'Friend')
    const other = await (await browser.newContext()).newPage()
    await joinVia(other, await createInviteLink(host), 'Other')

    // The host follows Friend in #general from the member list.
    await host.locator('.member-list').getByRole('button', { name: /Friend/ }).click({ button: 'right' })
    await host.getByRole('menuitem', { name: 'Follow in #general' }).click()
    await host.locator('.member-list').getByRole('button', { name: /Friend/ }).click({ button: 'right' })
    await expect(host.getByRole('menuitem', { name: 'Unfollow in #general' })).toBeVisible()
    await host.keyboard.press('Escape')

    // While the host looks at DMs, the friend posts (followed) and someone else posts (not).
    await host.getByRole('button', { name: 'Direct messages' }).click()
    await send(other, 'nobody follows me')
    await send(friend, 'hello from a followed friend')
    const bell = host.getByRole('button', { name: /^Inbox, 1 new/ })
    await expect(bell).toBeVisible()
    await bell.click()
    const inbox = host.getByRole('dialog', { name: 'Inbox' })
    await expect(inbox.locator('.inbox-row.unread', { hasText: 'Friend posted in a channel you follow' })).toContainText('hello from a followed friend')
    await expect(inbox.locator('.inbox-row', { hasText: 'Other' })).toHaveCount(0)
    await host.screenshot({ path: join(SHOTS, 'follow-inbox.png') })
    await host.keyboard.press('Escape')

    // The settings list it and can remove it.
    await openSettings(host, 'Notifications')
    const settings = host.getByRole('dialog', { name: 'Settings' })
    const chips = settings.getByRole('list', { name: 'Follows' }).locator('.alert-chip')
    await expect(chips).toHaveText([/Friend in #general/])
    await settings.getByRole('group', { name: 'Follows' }).scrollIntoViewIfNeeded()
    await host.screenshot({ path: join(SHOTS, 'follow-settings.png') })
    await chips.first().getByRole('button', { name: 'Stop following Friend' }).click()
    await expect(settings.getByText('Not following anyone yet.')).toBeVisible()
    await host.keyboard.press('Escape')
  } finally {
    await server.stop()
  }
})

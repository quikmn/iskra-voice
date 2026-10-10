import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Forums and Events')
})
test.afterAll(async () => server?.stop())

test('a forum with tags, posts, replies, unread markers and moderation', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // The owner makes a forum channel and gives it two tags.
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: 'Forum' }).click()
  await create.getByPlaceholder('game-night').fill('help')
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(host.getByRole('heading', { name: 'help' })).toBeVisible()
  await expect(host.getByText('No posts yet')).toBeVisible()
  await host.getByRole('button', { name: 'Edit tags' }).click()
  const tagsDialog = host.getByRole('dialog', { name: 'Forum tags' })
  await tagsDialog.getByRole('button', { name: 'Add a tag' }).click()
  await tagsDialog.getByLabel('Tag name').last().fill('Bug')
  await tagsDialog.getByLabel('Emoji (optional)').last().fill('🐛')
  await tagsDialog.getByRole('button', { name: 'Add a tag' }).click()
  await tagsDialog.getByLabel('Tag name').last().fill('Idea')
  await tagsDialog.getByRole('button', { name: 'Save' }).click()
  await expect(host.getByRole('group', { name: 'Filter by tag' }).getByRole('button', { name: 'Idea' })).toBeVisible()

  // The friend posts a question with a tag; it opens beside the list.
  await friend.locator('.channel-list .channel', { hasText: 'help' }).click()
  await friend.locator('.forum-toolbar').getByRole('button', { name: 'New post' }).click()
  const newPost = friend.getByRole('dialog', { name: 'New post' })
  await newPost.getByPlaceholder("What's it about?").fill('Crash on start')
  await newPost.getByPlaceholder('Add details, links, or a picture').fill('The app closes right after the splash screen.')
  await newPost.getByRole('button', { name: 'Bug' }).click()
  await friend.screenshot({ path: join(SHOTS, 'forum-new-post.png') })
  await newPost.getByRole('button', { name: 'Post' }).click()
  const friendPanel = friend.locator('.thread-panel')
  await expect(friendPanel.getByRole('heading', { name: 'Crash on start' })).toBeVisible()
  await expect(friendPanel.locator('.thread-root')).toContainText('splash screen')
  await friendPanel.getByRole('button', { name: 'Close thread' }).click()

  // The host sees it as new, with its tag; tag filters and search narrow the list.
  const hostCard = host.locator('.post-card', { hasText: 'Crash on start' })
  await expect(hostCard.locator('.post-unread')).toHaveText('New')
  await expect(hostCard.locator('.tag-chip')).toContainText('Bug')
  const filters = host.getByRole('group', { name: 'Filter by tag' })
  await filters.getByRole('button', { name: 'Idea' }).click()
  await expect(host.getByText('No posts match')).toBeVisible()
  await filters.getByRole('button', { name: 'All' }).click()
  await host.getByRole('searchbox', { name: 'Search posts' }).fill('splash')
  await expect(hostCard).toBeVisible()
  await host.getByRole('searchbox', { name: 'Search posts' }).fill('nothing like this')
  await expect(host.getByText('No posts match')).toBeVisible()
  await host.getByRole('searchbox', { name: 'Search posts' }).fill('')
  await host.screenshot({ path: join(SHOTS, 'forum.png') })

  // Opening it clears "New"; the host replies, and the friend sees one new reply.
  await hostCard.click()
  const hostPanel = host.locator('.thread-panel')
  await expect(hostCard.locator('.post-unread')).toHaveCount(0)
  const reply = hostPanel.getByPlaceholder('Reply in Crash on start')
  await reply.fill('Does it happen after a restart too?')
  await reply.press('Enter')
  await expect(hostPanel.locator('.message', { hasText: 'after a restart' })).toBeVisible()
  const friendCard = friend.locator('.post-card', { hasText: 'Crash on start' })
  await expect(friendCard.locator('.post-unread')).toHaveText('1 new')
  await expect(friendCard.locator('.post-replies')).toContainText('1')

  // The owner pins and locks it; the friend can't reply any more.
  await hostPanel.getByRole('button', { name: 'Pin', exact: true }).click()
  await hostPanel.getByRole('button', { name: 'Lock', exact: true }).click()
  await expect(friendCard.locator('.post-state')).toContainText('Locked')
  await friendCard.click()
  await expect(friend.locator('.thread-panel .composer.read-only')).toHaveText('This post is locked.')
  await expect(friendCard.locator('.post-unread')).toHaveCount(0)
  await friend.screenshot({ path: join(SHOTS, 'forum-post.png') })

  // Phones: the list fits the screen and a post opens full screen.
  await friend.setViewportSize({ width: 390, height: 844 })
  await friend.locator('.thread-panel').getByRole('button', { name: 'Back to channel' }).click()
  await expect(friendCard).toBeVisible()
  const width = await friend.evaluate(() => document.documentElement.scrollWidth)
  expect(width).toBeLessThanOrEqual(390)
  await friend.screenshot({ path: join(SHOTS, 'forum-mobile.png') })
  await friendCard.click()
  await expect(friend.locator('.thread-panel')).toBeVisible()
  await friend.waitForTimeout(400) // the panel slides in
  await friend.screenshot({ path: join(SHOTS, 'forum-post-mobile.png') })
})

test('schedule an event, mark interest, add it to a calendar, edit and cancel it', async ({ browser }) => {
  const events = await startServer('Events')
  try {
    const host = await (await browser.newContext()).newPage()
    await joinVia(host, events.ownerLink(), 'Host')
    const friend = await (await browser.newContext()).newPage()
    await joinVia(friend, await createInviteLink(host), 'Friend')

    // Nothing planned yet; the host schedules one somewhere else (this server has no voice channels).
    await host.locator('.events-button').click()
    const dialog = host.getByRole('dialog', { name: 'Events' })
    await expect(dialog.getByText('Nothing planned yet')).toBeVisible()
    await dialog.getByRole('button', { name: 'Schedule an event' }).click()
    const form = host.getByRole('dialog', { name: 'Schedule an event' })
    await form.getByPlaceholder('Game night').fill('Board game night')
    await form.getByPlaceholder("What's the plan? (optional)").fill('Bring snacks, we have Catan.')
    await form.getByRole('radio', { name: 'Somewhere else' }).click()
    await form.getByLabel('Place').fill("Viktor's place")
    await host.screenshot({ path: join(SHOTS, 'event-form.png') })
    await form.getByRole('button', { name: 'Schedule' }).click()
    const hostCard = host.locator('.event-card', { hasText: 'Board game night' })
    await expect(hostCard).toBeVisible()
    await expect(hostCard).toContainText("Viktor's place")
    await expect(hostCard).toContainText('1 interested')
    await expect(hostCard.getByRole('button', { name: 'Interested' })).toHaveAttribute('aria-pressed', 'true')

    // The friend sees a badge, opens the list and says they're interested.
    const button = friend.locator('.events-button')
    await expect(button.locator('.event-badge')).toHaveText('1')
    await button.click()
    const friendCard = friend.locator('.event-card', { hasText: 'Board game night' })
    await friendCard.getByRole('button', { name: "I'm interested" }).click()
    await expect(friendCard.getByRole('button', { name: 'Interested' })).toHaveAttribute('aria-pressed', 'true')
    await expect(hostCard).toContainText('2 interested')
    await expect(friendCard.getByRole('button', { name: 'Edit' })).toHaveCount(0)

    // Add to calendar downloads an .ics file with the event in UTC.
    const download = friend.waitForEvent('download')
    await friendCard.getByRole('button', { name: 'Add to calendar' }).click()
    const file = await download
    expect(file.suggestedFilename()).toBe('board-game-night.ics')
    const ics = readFileSync(await file.path(), 'utf8')
    expect(ics).toContain('BEGIN:VEVENT')
    expect(ics).toContain('SUMMARY:Board game night')
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/)
    await friend.screenshot({ path: join(SHOTS, 'events.png') })

    // Phones: the dialog fits.
    await friend.setViewportSize({ width: 390, height: 844 })
    await expect(friendCard).toBeVisible()
    await friend.waitForTimeout(400) // drawers settle after the resize
    await friend.screenshot({ path: join(SHOTS, 'events-mobile.png') })

    // The host renames it, then cancels it; it disappears for the friend.
    await hostCard.getByRole('button', { name: 'Edit' }).click()
    const edit = host.getByRole('dialog', { name: 'Edit event' })
    await edit.getByPlaceholder('Game night').fill('Catan night')
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(friend.locator('.event-card', { hasText: 'Catan night' })).toBeVisible()
    const renamed = host.locator('.event-card', { hasText: 'Catan night' })
    await renamed.getByRole('button', { name: 'Cancel event' }).click()
    await renamed.getByRole('button', { name: 'Cancel event' }).click()
    await expect(friend.locator('.event-card')).toHaveCount(0)
    await expect(friend.getByText('Nothing planned yet')).toBeVisible()
  } finally {
    await events.stop()
  }
})

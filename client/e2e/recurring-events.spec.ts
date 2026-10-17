// Repeating events: a weekly event shows how it repeats and exports an RRULE; editing one occurrence takes it out of the
// series (the next one appears right away); cancelling asks "this one or the series".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer } from './helpers'

test('a weekly event repeats, exports an RRULE, and one occurrence can be changed or cancelled on its own', async ({ browser }) => {
  const server = await startServer('Recurring events')
  try {
    const host = await (await browser.newContext()).newPage()
    await joinVia(host, server.ownerLink(), 'Host')
    const friend = await (await browser.newContext()).newPage()
    await joinVia(friend, await createInviteLink(host), 'Friend')

    // The host plans a weekly quiz.
    await host.locator('.events-button').click()
    const dialog = host.getByRole('dialog', { name: 'Events' })
    await dialog.getByRole('button', { name: 'Schedule an event' }).click()
    const form = host.getByRole('dialog', { name: 'Schedule an event' })
    await form.getByPlaceholder('Game night').fill('Weekly quiz')
    await form.getByLabel('Repeats').selectOption('weekly')
    await expect(form.getByLabel('Until (optional)')).toBeVisible()
    await form.getByRole('radio', { name: 'Somewhere else' }).click()
    await form.getByLabel('Place').fill('The pub')
    await host.screenshot({ path: join(SHOTS, 'event-form-repeat.png') })
    await form.getByRole('button', { name: 'Schedule' }).click()
    const hostCard = host.locator('.event-card', { hasText: 'Weekly quiz' })
    await expect(hostCard).toBeVisible()
    await expect(hostCard).toContainText('Repeats: Every week')

    // The friend sees the same, and the calendar file carries the rule.
    await friend.locator('.events-button').click()
    const friendCard = friend.locator('.event-card', { hasText: 'Weekly quiz' })
    await expect(friendCard).toContainText('Repeats: Every week')
    const download = friend.waitForEvent('download')
    await friendCard.getByRole('button', { name: 'Add to calendar' }).click()
    const ics = readFileSync(await (await download).path(), 'utf8')
    expect(ics).toContain('RRULE:FREQ=WEEKLY')
    expect(ics).toMatch(/UID:event-series-\d+-/)

    // Editing "this one only" renames this week's quiz; next week's appears unchanged, still weekly.
    await hostCard.getByRole('button', { name: 'Edit' }).click()
    const edit = host.getByRole('dialog', { name: 'Edit event' })
    await expect(edit.getByRole('radio', { name: 'The whole series' })).toHaveAttribute('aria-checked', 'true')
    await edit.getByRole('radio', { name: 'This one only' }).click()
    await expect(edit.getByLabel('Repeats')).toHaveCount(0)
    await edit.getByPlaceholder('Game night').fill('Quiz special')
    await edit.getByRole('button', { name: 'Save' }).click()
    const special = friend.locator('.event-card', { hasText: 'Quiz special' })
    await expect(special).toBeVisible()
    await expect(special).not.toContainText('Repeats:')
    await expect(friend.locator('.event-card', { hasText: 'Weekly quiz' })).toContainText('Repeats: Every week')
    await expect(friend.locator('.event-card')).toHaveCount(2)

    // Phones: the cards fit.
    await friend.setViewportSize({ width: 390, height: 844 })
    await friend.waitForTimeout(400)
    await friend.screenshot({ path: join(SHOTS, 'events-repeat-mobile.png') })

    // Cancelling a repeating event asks which; the series goes, then the one-off.
    const weekly = host.locator('.event-card', { hasText: 'Weekly quiz' })
    await weekly.getByRole('button', { name: 'Cancel event' }).click()
    await expect(weekly.getByText('Cancel this one, or the whole series?')).toBeVisible()
    await weekly.getByRole('button', { name: 'The series' }).click()
    await expect(friend.locator('.event-card', { hasText: 'Weekly quiz' })).toHaveCount(0)
    const hostSpecial = host.locator('.event-card', { hasText: 'Quiz special' })
    await hostSpecial.getByRole('button', { name: 'Cancel event' }).click()
    await hostSpecial.getByRole('button', { name: 'Cancel event' }).click()
    await expect(friend.locator('.event-card')).toHaveCount(0)
  } finally {
    await server.stop()
  }
})

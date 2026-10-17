// Tags, Suggestions, Giveaways and Counting: an admin turns them on and sets them up in Server settings → Bots; a friend
// posts a tag (it can't ping), suggests something and votes, staff accept it, a giveaway is entered and drawn, and a
// counting channel starts over when someone counts twice. The settings fit a phone.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Pizza Club')
})
test.afterAll(async () => {
  await server?.stop()
})

async function openBots(page: Page) {
  await page.getByRole('button', { name: /server options/ }).click()
  await page.getByRole('menuitem', { name: 'More settings' }).click()
  await page.getByRole('menuitem', { name: 'Bots & webhooks' }).click()
  await page.getByRole('tab', { name: 'Bots' }).click()
}

async function openChannel(page: Page, name: string) {
  await page.locator('.channel', { hasText: name }).first().click()
  await expect(page.getByRole('region', { name: `Messages in #${name}` })).toBeVisible()
}

async function sendIn(page: Page, channel: string, text: string) {
  const box = page.getByPlaceholder(`Message #${channel}`)
  await box.fill(text)
  await box.press('Enter')
}

test('Tags, Suggestions, Giveaways and Counting: set up by an admin, used by friends', async ({ browser }) => {
  test.setTimeout(180_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // Four more switches; Suggestions and Counting make their own channels.
  await openBots(host)
  for (const name of ['Tags', 'Suggestions', 'Giveaways', 'Counting']) {
    const toggle = host.getByRole('switch', { name: `Turn ${name} on` })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  }

  // Tags: one saved snippet (its mention won't ping anyone).
  await host.getByRole('button', { name: 'Tags settings' }).click()
  const tags = host.getByTestId('builtin-tags-settings')
  await expect(tags.getByText('No tags yet.')).toBeVisible()
  await tags.getByLabel('Name').fill('Rules')
  await tags.getByLabel('Text', { exact: true }).fill('**Be kind**, no spam. Hi @everyone!')
  await expect(tags.getByText('Post one with /tag rules')).toBeVisible()
  await tags.getByRole('button', { name: 'Add tag' }).click()
  await expect(tags.getByRole('status')).toHaveText('Saved.')
  await expect(tags.locator('.bots3-tag-list li', { hasText: 'rules' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'bots3-tags-settings.png') })

  // Suggestions: #suggestions, and a Suggest button there.
  await host.getByRole('button', { name: 'Suggestions settings' }).click()
  const suggestions = host.getByTestId('builtin-suggestions-settings')
  await expect(suggestions.getByLabel('Channel').locator('option:checked')).toHaveText('#suggestions')
  await suggestions.getByRole('button', { name: 'Post a Suggest button there' }).click()
  await expect(suggestions.getByText('Posted.')).toBeVisible()

  // Counting: sums allowed.
  await host.getByRole('button', { name: 'Counting settings' }).click()
  const counting = host.getByTestId('builtin-counting-settings')
  await expect(counting.getByLabel('Channel').locator('option:checked')).toHaveText('#counting')
  await counting.getByLabel('Allow simple sums').check()
  await counting.getByRole('button', { name: 'Save' }).click()
  await expect(counting.getByRole('status')).toHaveText('Saved.')
  await host.keyboard.press('Escape')

  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // Tags: anyone can post one; the snippet shows as written, with no live @everyone.
  await send(friend, '/tag rules')
  const tagPost = host.getByTestId('tag-post').last()
  await expect(tagPost).toContainText('Be kind, no spam.')
  await expect(tagPost.locator('strong', { hasText: 'Be kind' })).toBeVisible()
  await expect(tagPost.locator('.mention')).toHaveCount(0)
  await send(friend, '/tag list')
  await expect(friend.locator('.private-answer', { hasText: 'Tags:' })).toContainText('rules')

  // Suggestions: /suggest from #general lands in #suggestions; the command itself goes.
  await send(friend, '/suggest Pizza on Fridays')
  await expect(friend.locator('.private-answer', { hasText: 'Your suggestion is in #suggestions' })).toBeVisible()
  await expect(friend.locator('.message', { hasText: '/suggest Pizza on Fridays' })).toHaveCount(0)
  await openChannel(friend, 'suggestions')
  const card = friend.getByTestId('suggestion-card').filter({ hasText: 'Pizza on Fridays' })
  await expect(card).toContainText('Suggestion from Friend')
  await card.getByRole('button', { name: /Vote for it/ }).click()
  await expect(card.getByRole('button', { name: 'Vote for it (1)' })).toHaveAttribute('aria-pressed', 'true')
  await card.getByRole('button', { name: /Vote against it/ }).click() // changed, not added
  await expect(card.getByRole('button', { name: 'Vote for it (0)' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Vote against it (1)' })).toHaveAttribute('aria-pressed', 'true')
  await card.getByRole('button', { name: /Vote for it/ }).click()
  await expect(card.getByRole('button', { name: 'Vote for it (1)' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Decide…' })).toHaveCount(0) // not staff

  // The Suggest button on the prompt card.
  await friend.getByTestId('suggest-prompt').getByRole('button', { name: 'Suggest' }).click()
  await friend.getByLabel('Your idea').fill('A movie night')
  await friend.getByTestId('suggest-prompt').getByRole('button', { name: 'Send' }).click()
  await expect(friend.getByTestId('suggest-prompt').getByRole('status')).toHaveText('Thanks! Your suggestion is posted.')
  await expect(friend.getByTestId('suggestion-card').filter({ hasText: 'A movie night' })).toBeVisible()

  // Staff (the admin) accept it with a reason; the author hears privately.
  await openChannel(host, 'suggestions')
  const hostCard = host.getByTestId('suggestion-card').filter({ hasText: 'Pizza on Fridays' })
  await hostCard.getByRole('button', { name: 'Decide…' }).click()
  await hostCard.getByText('Accepted', { exact: true }).click()
  await hostCard.getByLabel('Reason (optional)').fill('Starting next week')
  await hostCard.getByRole('button', { name: 'Save' }).click()
  await expect(hostCard.getByTestId('suggestion-status')).toHaveText('Accepted by Host: Starting next week')
  await expect(card.getByRole('button', { name: /Vote for it/ })).toBeDisabled()
  await expect(friend.locator('.private-answer', { hasText: 'Your suggestion was marked accepted: Starting next week' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'bots3-suggestions.png') })

  // Giveaways: staff start one, a friend enters, staff end it early, the friend wins.
  await openChannel(host, 'general')
  await send(host, '/giveaway 1h Pizza voucher')
  await openChannel(friend, 'general')
  const giveaway = friend.getByTestId('giveaway-card').filter({ hasText: 'Pizza voucher' })
  await expect(giveaway).toContainText('1 winner')
  await giveaway.getByRole('button', { name: 'Enter 🎉' }).click()
  await expect(giveaway.getByText("You're in!")).toBeVisible()
  await expect(giveaway.getByTestId('giveaway-entrants')).toHaveText('1 entered')
  await expect(giveaway.getByRole('button', { name: 'End now' })).toHaveCount(0)
  const hostGiveaway = host.getByTestId('giveaway-card').filter({ hasText: 'Pizza voucher' })
  await expect(hostGiveaway.getByTestId('giveaway-entrants')).toHaveText('1 entered')
  await host.screenshot({ path: join(SHOTS, 'bots3-giveaway-open.png') })
  await hostGiveaway.getByRole('button', { name: 'End now' }).click()
  await expect(giveaway.getByTestId('giveaway-winners')).toHaveText('Won by Friend')
  await expect(friend.locator('.giveaway-won', { hasText: 'Congratulations Friend! You won Pizza voucher.' })).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'bots3-giveaway-won.png') })

  // Counting: next number only, nobody twice in a row; the best streak stays on the card.
  await openChannel(host, 'counting')
  await openChannel(friend, 'counting')
  await sendIn(host, 'counting', '1')
  await sendIn(friend, 'counting', '1+1')
  await expect(host.locator('.message', { hasText: '1+1' }).locator('.reaction', { hasText: '✅' })).toBeVisible()
  await sendIn(friend, 'counting', '3')
  await expect(host.locator('.counting-line', { hasText: 'Friend counted twice in a row, so the count of 2 starts over. Next is 1.' })).toBeVisible()
  await expect(host.getByTestId('counting-card').last()).toContainText('Best streak: 2')
  await host.screenshot({ path: join(SHOTS, 'bots3-counting.png') })

  // At phone width the settings fit the screen.
  await openBots(host)
  await host.getByRole('button', { name: 'Tags settings' }).click()
  await host.setViewportSize({ width: 390, height: 844 })
  const narrow = host.getByTestId('builtin-tags-settings')
  await expect(narrow).toBeVisible()
  const box = await narrow.boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect(await host.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await host.screenshot({ path: join(SHOTS, 'bots3-mobile.png') })
})

// Task boards: two members share a board. Tasks are created, assigned, moved (by drag, keyboard, the panel and the
// menu), commented on, filtered and archived; the other member sees every change live and is told about the task
// assigned to them. A copied task link opens the task in the web app. Phone layout and an accessibility check.
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Task Boards')
})
test.afterAll(async () => server?.stop())

const column = (page: Page, status: 'todo' | 'doing' | 'done') => page.getByTestId(`tasks-column-${status}`)
const card = (page: Page, title: string) => page.locator('.task-card', { hasText: title })

test('a board shared by two members: create, assign, move, comment, archive and link', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  const invite = await createInviteLink(host)
  await joinVia(friend, invite, 'Friend')

  // The owner makes a board; the friend opens it while it is still empty.
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: 'Tasks' }).click()
  await create.getByPlaceholder('game-night').fill('raid prep')
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(host.getByRole('heading', { name: 'raid-prep' })).toBeVisible()
  await expect(host.getByText('No tasks yet')).toBeVisible()
  await friend.locator('.channel-list .channel', { hasText: 'raid-prep' }).click()
  await expect(friend.getByText('No tasks yet')).toBeVisible()

  // Two tasks typed straight into the column; the friend sees them appear.
  await host.getByTestId('tasks-new').click()
  const quick = host.getByTestId('tasks-quick-input')
  await quick.fill('Book the venue')
  await quick.press('Enter')
  await expect(card(host, 'Book the venue')).toBeVisible()
  await quick.fill('Bring snacks')
  await quick.press('Enter')
  await expect(card(host, 'Bring snacks')).toBeVisible()
  await quick.press('Escape')
  await expect(column(friend, 'todo').locator('.task-card')).toHaveText([/Book the venue/, /Bring snacks/])

  // The host opens a task, writes a description and assigns the friend.
  await card(host, 'Bring snacks').locator('.task-open').click()
  const hostPanel = host.getByTestId('task-panel')
  await expect(hostPanel.getByTestId('task-panel-title')).toHaveText('Bring snacks')
  await hostPanel.getByTestId('task-edit-description').click()
  await hostPanel.getByTestId('task-description-input').fill('Crisps and **something sweet**.')
  await hostPanel.getByRole('button', { name: 'Save' }).click()
  await expect(hostPanel.locator('.task-description-text strong')).toHaveText('something sweet')
  await hostPanel.getByTestId('task-panel-assign').click()
  await host.getByRole('dialog', { name: 'Assign people' }).getByRole('menuitemcheckbox', { name: 'Friend' }).click()
  await host.keyboard.press('Escape')
  await expect(hostPanel.getByTestId('task-assignees')).toContainText('Friend')
  await host.screenshot({ path: join(SHOTS, 'tasks-detail.png') })

  // The friend is told: the bell counts it and the inbox lists it; opening it shows the task.
  await expect(card(friend, 'Bring snacks').getByRole('img', { name: 'Assigned to Friend' })).toBeVisible()
  await friend.getByRole('button', { name: /^Inbox, 1 new/ }).click()
  const inbox = friend.getByRole('dialog', { name: 'Inbox' })
  const row = inbox.locator('.inbox-row', { hasText: 'Host assigned you a task' })
  await expect(row).toContainText('Bring snacks')
  await row.locator('.inbox-row-main').click()
  const friendPanel = friend.getByTestId('task-panel')
  await expect(friendPanel.getByTestId('task-panel-title')).toHaveText('Bring snacks')
  await expect(friendPanel.locator('.task-description-text')).toContainText('Crisps and something sweet')
  await expect(friend.getByRole('button', { name: 'Inbox', exact: true })).toBeVisible()

  // The friend starts on it and comments; the host's board follows.
  await friendPanel.getByTestId('task-status-doing').click()
  await expect(column(host, 'doing').locator('.task-card')).toHaveText([/Bring snacks/])
  const comment = friendPanel.getByPlaceholder('Write a comment')
  await comment.fill('On it, back by six.')
  await comment.press('Enter')
  await expect(hostPanel.locator('.message', { hasText: 'back by six' })).toBeVisible()
  await hostPanel.getByRole('button', { name: 'Close task' }).click()
  await expect(card(host, 'Bring snacks').getByLabel('1 comment')).toBeVisible()

  // Moving: a drag to another column, then the keyboard, then the card's menu.
  await card(host, 'Book the venue').dragTo(column(host, 'doing').locator('.tasks-list'))
  await expect(column(friend, 'doing').locator('.task-card')).toHaveCount(2)
  await card(host, 'Book the venue').locator('.task-open').focus()
  await host.keyboard.press('Alt+ArrowRight')
  await expect(column(friend, 'done').locator('.task-card')).toHaveText([/Book the venue/])
  await expect(host.getByTestId('announcer')).toHaveText('Book the venue moved to Done')
  await card(host, 'Book the venue').getByRole('button', { name: 'More for Book the venue' }).click()
  await host.getByTestId('task-move-todo').click()
  await expect(column(friend, 'todo').locator('.task-card')).toHaveText([/Book the venue/])
  await host.getByTestId('tasks-add-done').click()
  await host.getByTestId('tasks-quick-input').fill('Pick a date')
  await host.getByTestId('tasks-quick-input').press('Enter')
  await host.getByTestId('tasks-quick-input').press('Escape')
  await expect(column(friend, 'done').locator('.task-card')).toHaveText([/Pick a date/])
  await host.screenshot({ path: join(SHOTS, 'tasks-board.png') })

  // "My tasks" keeps only what is assigned to me.
  await friendPanel.getByRole('button', { name: 'Close task' }).click()
  await friend.getByTestId('tasks-mine').click()
  await expect(friend.locator('.task-card')).toHaveText([/Bring snacks/])
  await friend.getByTestId('tasks-mine').click()
  await expect(friend.locator('.task-card')).toHaveCount(3)

  // The board has no serious accessibility problems, with and without a task open.
  for (const open of [false, true]) {
    if (open) await card(host, 'Bring snacks').locator('.task-open').click()
    await host.waitForTimeout(400)
    const result = await new AxeBuilder({ page: host }).include(open ? '[data-testid="task-panel"]' : '[data-testid="task-board"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()
    const blocking = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
  }
  await hostPanel.getByRole('button', { name: 'Close task' }).click()

  // Done tasks are archived off the board, and can be put back.
  await host.getByTestId('tasks-archive-done').click()
  await expect(card(friend, 'Pick a date')).toHaveCount(0)
  await friend.getByTestId('tasks-archived').click()
  const archived = friend.getByRole('dialog', { name: 'Archived tasks' })
  await expect(archived.locator('li')).toHaveText([/Pick a date/])
  await archived.getByRole('button', { name: 'Put back' }).click()
  await expect(column(host, 'done').locator('.task-card')).toHaveText([/Pick a date/])
  await archived.getByRole('button', { name: 'Close' }).click()

  // A copied link opens the task in the web app, for the member whose browser it is.
  await card(host, 'Bring snacks').getByRole('button', { name: 'More for Bring snacks' }).click()
  await host.getByTestId('task-copy-link').click()
  await expect(host.getByTestId('task-copy-link')).toHaveCount(0)
  const link = await host.evaluate(() => navigator.clipboard.readText())
  expect(link).toMatch(/#\/open\/[A-Za-z0-9_-]{43}\/c\/\d+\/t\/\d+$/)
  await friend.locator('.channel-list .channel', { hasText: 'general' }).click()
  await expect(friend.getByRole('heading', { name: 'general', exact: true })).toBeVisible()
  await friend.goto(link)
  await expect(friend.getByRole('heading', { name: 'raid-prep' })).toBeVisible({ timeout: 15_000 })
  await expect(friend.getByTestId('task-panel').getByTestId('task-panel-title')).toHaveText('Bring snacks')
  await expect(friend.getByTestId('task-panel').locator('.message', { hasText: 'back by six' })).toBeVisible()
  expect(new URL(friend.url()).hash).toBe('')
  await friend.screenshot({ path: join(SHOTS, 'tasks-deep-link.png') })

  // A task is deleted by whoever made it; it goes from the other board too.
  await card(host, 'Book the venue').getByRole('button', { name: 'More for Book the venue' }).click()
  await host.getByTestId('task-delete').click()
  await host.getByTestId('task-delete-confirm').click()
  await friend.getByTestId('task-panel').getByRole('button', { name: 'Close task' }).click()
  await expect(card(friend, 'Book the venue')).toHaveCount(0)

  // On a phone the board shows one column at a time, and a task moves from its menu.
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const phone = await phoneContext.newPage()
  await joinVia(phone, invite, 'Pocket')
  await phone.getByRole('button', { name: 'Open channels' }).first().click()
  await phone.locator('.channel-list .channel', { hasText: 'raid-prep' }).click()
  await expect(phone.getByTestId('tasks-switch-doing')).toBeVisible()
  await expect(column(phone, 'doing')).toBeHidden()
  await phone.getByTestId('tasks-switch-doing').click()
  await expect(column(phone, 'doing').locator('.task-card')).toHaveText([/Bring snacks/])
  await phone.waitForTimeout(350)
  await phone.screenshot({ path: join(SHOTS, 'tasks-phone.png') })
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await card(phone, 'Bring snacks').getByRole('button', { name: 'More for Bring snacks' }).click()
  await phone.getByTestId('task-move-done').click()
  await expect(column(host, 'done').locator('.task-card')).toHaveText([/Pick a date/, /Bring snacks/])
  await phone.getByTestId('tasks-switch-done').click()
  await card(phone, 'Bring snacks').locator('.task-open').click()
  await expect(phone.getByTestId('task-panel').getByTestId('task-panel-title')).toHaveText('Bring snacks')
  await phone.waitForTimeout(350)
  await phone.screenshot({ path: join(SHOTS, 'tasks-phone-task.png') })
})

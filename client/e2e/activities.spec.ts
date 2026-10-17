// Activities: two people in a call start Four in a row and play a few moves, a third joins late and sees the board as
// it is, and the owner adds an activity of their own (which browsers list but don't run: it runs in the desktop app).
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, hasLiveKit, joinVia, openServerSettings, SHOTS, startServer, type TestServer } from './helpers'
import { zip } from './zipFiles'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Game Night', true)
})
test.afterAll(async () => server?.stop())

const room = (page: Page) => page.locator('.voice-channel', { hasText: 'games' })
const frame = (page: Page) => page.frameLocator('[data-testid="activity-frame"]')

async function joinRoom(page: Page) {
  await room(page).getByRole('button').first().click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
}

test('two play Four in a row, a late joiner sees the board, and added activities run only in the desktop app', async ({ browser }) => {
  test.setTimeout(240_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('games')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(room(host)).toBeVisible()
  const invite = await createInviteLink(host)
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, invite, 'Friend')
  await joinRoom(host)
  await joinRoom(friend)

  // The host starts Four in a row from the call controls.
  await host.getByTestId('activity-button').click()
  const launcher = host.getByRole('dialog', { name: 'Start an activity' })
  await expect(launcher.getByTestId('activity-choice')).toHaveCount(3)
  await host.waitForTimeout(400) // the dialog's fade-in, for the picture
  await host.screenshot({ path: join(SHOTS, 'activities-launcher.png') })
  await launcher.getByRole('button', { name: 'Start Four in a row' }).click()
  await expect(host.getByTestId('activity-panel')).toBeVisible()
  await expect(frame(host).getByRole('heading', { name: 'Four in a row' })).toBeVisible()

  // The friend is asked to join, and does.
  await expect(friend.getByTestId('activity-invite')).toContainText('Host started Four in a row')
  await friend.getByTestId('activity-invite').getByRole('button', { name: 'Join' }).click()
  await expect(frame(friend).getByRole('heading', { name: 'Four in a row' })).toBeVisible()

  // Seats, then a few moves; both see the same board.
  await frame(host).getByRole('button', { name: 'Play Red' }).click()
  await frame(friend).getByRole('button', { name: 'Play Yellow' }).click()
  await expect(frame(host).getByRole('status')).toHaveText('Your turn (Red)')
  await expect(frame(friend).getByRole('status')).toHaveText(/Host.s turn \(Red\)/)
  for (const [page, column] of [[host, 4], [friend, 4], [host, 3], [friend, 5]] as const) {
    await frame(page).getByRole('button', { name: `Drop in column ${column}` }).click()
    await expect(frame(page).locator('.cell.p1, .cell.p2')).not.toHaveCount(0)
  }
  for (const page of [host, friend]) {
    await expect(frame(page).locator('.cell.p1')).toHaveCount(2)
    await expect(frame(page).locator('.cell.p2')).toHaveCount(2)
  }
  await expect(frame(host).getByRole('status')).toHaveText('Your turn (Red)')
  await host.screenshot({ path: join(SHOTS, 'activities-four.png') })

  // Someone joins the call late: they get the board as it is now (the snapshot and the moves after it).
  const late = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(late, invite, 'Late')
  await late.getByRole('button', { name: 'Open channels' }).click()
  await room(late).getByRole('button').first().click()
  await expect(late.locator('.stage')).toBeVisible()
  await expect(late.getByTestId('activity-invite')).toContainText('Four in a row')
  await late.getByTestId('activity-invite').getByRole('button', { name: 'Join' }).click()
  await expect(frame(late).locator('.cell.p1')).toHaveCount(2)
  await expect(frame(late).locator('.cell.p2')).toHaveCount(2)
  await expect(frame(late).getByTestId('four-seat-0')).toContainText('Host')
  await expect(frame(late).getByTestId('four-seat-1')).toContainText('Friend')
  await late.screenshot({ path: join(SHOTS, 'activities-late-phone.png') })

  // The host plays on; the late joiner sees it too.
  await frame(host).getByRole('button', { name: 'Drop in column 1' }).click()
  await expect(frame(late).locator('.cell.p1')).toHaveCount(3)

  // The owner adds an activity of their own.
  const settings = await openServerSettings(host, 'Activities')
  await settings.getByTestId('activity-upload').setInputFiles({
    name: 'tiny.zip', mimeType: 'application/zip',
    buffer: zip({
      'manifest.json': JSON.stringify({ name: 'Tiny test', description: 'A button.', minPlayers: 1, maxPlayers: 8 }),
      'index.html': '<!doctype html><button id="b">Press</button><script src="game.js"></script>',
      'game.js': 'iskra.ready().then(() => iskra.send({ t: "hi" }))',
    }),
  })
  await expect(settings.getByTestId('activity-settings-list')).toContainText('Tiny test')
  await host.screenshot({ path: join(SHOTS, 'activities-settings.png') })

  await host.keyboard.press('Escape')

  // In a browser it's listed but doesn't run: it says it runs in the desktop app.
  await host.getByTestId('activity-panel').getByRole('button', { name: 'End for everyone' }).click()
  await expect(friend.getByTestId('activity-panel')).toHaveCount(0)
  await host.getByTestId('activity-button').click()
  const again = host.getByRole('dialog', { name: 'Start an activity' })
  const tiny = again.getByTestId('activity-choice').filter({ hasText: 'Tiny test' })
  await expect(tiny).toContainText('Runs in the desktop app')
  await expect(tiny.getByRole('button', { name: 'Start Tiny test' })).toBeDisabled()
  await expect(again.getByTestId('activity-desktop-only')).toBeVisible()
  await host.waitForTimeout(400)
  await host.screenshot({ path: join(SHOTS, 'activities-desktop-only.png') })

  // A quick quiz: the host asks, the friend answers, the answer shows once everyone answered.
  await again.getByRole('button', { name: 'Start Quiz' }).click()
  await friend.getByTestId('activity-invite').getByRole('button', { name: 'Join' }).click()
  await frame(host).getByRole('button', { name: 'Be the quizmaster' }).click()
  await frame(host).getByRole('button', { name: 'Start a quick quiz' }).click()
  await expect(frame(friend).locator('.question')).not.toBeEmpty()
  await expect(frame(friend).getByText('Question 1 of 5')).toBeVisible()
  await frame(friend).locator('.option').first().click()
  await expect(frame(friend).getByRole('status')).toContainText('The answer:')
  await expect(frame(friend).locator('.option.right')).toHaveCount(1)
  await expect(frame(host).getByRole('button', { name: 'Next question' })).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'activities-quiz.png') })
  await host.getByTestId('activity-panel').getByRole('button', { name: 'End for everyone' }).click()

  // Draw & guess: the host draws, the friend guesses wrong, then right.
  await host.getByTestId('activity-button').click()
  await host.getByRole('dialog', { name: 'Start an activity' }).getByRole('button', { name: 'Start Draw & guess' }).click()
  await friend.getByTestId('activity-invite').getByRole('button', { name: 'Join' }).click()
  await frame(host).getByRole('button', { name: 'Join the game' }).click()
  await frame(friend).getByRole('button', { name: 'Join the game' }).click()
  await frame(host).getByRole('button', { name: 'Start', exact: true }).click()
  const choice = frame(host).locator('.words button').first()
  const word = (await choice.textContent())!
  await choice.click()
  await expect(frame(host).getByRole('status')).toHaveText(`Draw: ${word}`)
  const canvas = (await frame(host).locator('canvas').boundingBox())!
  await host.mouse.move(canvas.x + 40, canvas.y + 40)
  await host.mouse.down()
  for (let i = 1; i <= 10; i++) await host.mouse.move(canvas.x + 40 + i * 20, canvas.y + 40 + i * 10)
  await host.mouse.up()
  await expect.poll(() => frame(friend).locator('canvas').evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let ink = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++
    return ink
  })).toBeGreaterThan(100)
  await frame(friend).getByLabel('Your guess').fill('definitely not it')
  await frame(friend).getByLabel('Your guess').press('Enter')
  await expect(frame(host).locator('.guesses')).toContainText('definitely not it')
  await frame(friend).getByLabel('Your guess').fill(word.toUpperCase())
  await frame(friend).getByLabel('Your guess').press('Enter')
  await expect(frame(friend).getByRole('status')).toHaveText(`The word was: ${word}`)
  await expect(frame(friend).locator('.guesses')).not.toContainText(word)
  await friend.screenshot({ path: join(SHOTS, 'activities-draw.png') })
})


// The calendar per server: the month view and the agenda in Events, an event made from a day, the private calendar
// link (subscribe, fetch and read the feed, a new link, turning it off, the owner's switch, a server calendar apps
// can't reach), and the phone app writing events into the phone's own calendar (with a stand-in for the native side).
import { join } from 'node:path'
import { devices, expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, SHOTS, startServer, type TestServer } from './helpers'

const { defaultBrowserType: _b, ...pixel } = devices['Pixel 7']

/** The feed as content lines: unfolded, with the checks RFC 5545 asks of the raw text. */
function icsLines(ics: string): string[] {
  expect(ics.endsWith('\r\n')).toBe(true)
  expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  const lines: string[] = []
  for (const raw of ics.slice(0, -2).split('\r\n')) {
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(75)
    if (raw.startsWith(' ')) lines[lines.length - 1] += raw.slice(1)
    else lines.push(raw)
  }
  return lines
}

/** The VEVENTs of a feed, each as property name → value. */
function icsEvents(ics: string): Record<string, string>[] {
  const events: Record<string, string>[] = []
  let current: Record<string, string> | null = null
  for (const line of icsLines(ics)) {
    if (line === 'BEGIN:VEVENT') current = {}
    else if (line === 'END:VEVENT') {
      events.push(current!)
      current = null
    } else if (current) {
      const colon = line.indexOf(':')
      current[line.slice(0, colon).split(';')[0]] = line.slice(colon + 1)
    }
  }
  return events
}

async function openEvents(page: Page) {
  await page.locator('.events-button').click()
  const dialog = page.getByRole('dialog', { name: 'Events' })
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe('calendar', () => {
  let server: TestServer
  test.beforeAll(async () => {
    // A stand-in public address: the app shows links on it, and the test fetches the same path from the real server.
    server = await startServer('Raiders', false, { Calendar__AddressForTests: 'https://chat.example.org' })
  })
  test.afterAll(async () => server?.stop())

  test('plan from a day in the month view, see it as another member, subscribe, replace and turn off the link', async ({ browser }) => {
    const host = await (await browser.newContext()).newPage()
    await joinVia(host, server.ownerLink(), 'Host')
    const friend = await (await browser.newContext()).newPage()
    await joinVia(friend, await createInviteLink(host), 'Friend')

    // A computer opens on the month, with today marked.
    const dialog = await openEvents(host)
    const month = dialog.getByTestId('calendar-month')
    await expect(month).toBeVisible()
    await expect(month.locator('.cal-day.today .cal-date')).toHaveAttribute('aria-current', 'date')
    await expect(dialog.getByRole('radio', { name: 'Month' })).toHaveAttribute('aria-checked', 'true')

    // Clicking an empty day (the last one on screen) starts a new event on that day.
    const cell = month.locator('.cal-day.can-create').last()
    const day = (await cell.getAttribute('data-day'))!
    await cell.click({ position: { x: 60, y: 60 } })
    const form = host.getByRole('dialog', { name: 'Schedule an event' })
    await expect(form.getByLabel('Start date')).toHaveValue(day)
    await expect(form.getByLabel('Start time')).toHaveValue('19:00')
    await form.getByPlaceholder('Game night').fill('Raid night')
    await form.getByPlaceholder("What's the plan? (optional)").fill('Bring potions, flasks; and food.')
    await form.getByRole('radio', { name: 'Somewhere else' }).click()
    await form.getByLabel('Place').fill('The old keep')
    await host.screenshot({ path: join(SHOTS, 'calendar-event-from-day.png') })
    await form.getByRole('button', { name: 'Schedule' }).click()

    // Back on the month, the event is on that day.
    const chip = month.locator(`.cal-day[data-day="${day}"] .cal-chip`, { hasText: 'Raid night' })
    await expect(chip).toBeVisible()
    await chip.scrollIntoViewIfNeeded()
    await host.screenshot({ path: join(SHOTS, 'calendar-month.png') })

    // The friend sees it on the same day, and opens it for the details and to say they're coming.
    const theirs = await openEvents(friend)
    const theirChip = theirs.locator(`.cal-day[data-day="${day}"] .cal-chip`, { hasText: 'Raid night' })
    await expect(theirChip).toBeVisible()
    // A member can make events too (the day is theirs to click); a day picked shows what's on it underneath.
    await theirs.locator(`.cal-day[data-day="${day}"] .cal-date`).click()
    await expect(theirs.getByTestId('calendar-day')).toContainText('Raid night')
    await theirChip.click()
    await expect(theirs.getByRole('radio', { name: 'Agenda' })).toHaveAttribute('aria-checked', 'true')
    const card = friend.locator('.event-card.focused', { hasText: 'Raid night' })
    await expect(card).toContainText('The old keep')
    await card.getByRole('button', { name: "I'm interested" }).click()
    await expect(card.getByRole('button', { name: 'Interested' })).toHaveAttribute('aria-pressed', 'true')

    // Add to my calendar: off until the friend makes a link.
    await theirs.getByTestId('calendar-subscribe-open').click()
    const panel = friend.getByRole('dialog', { name: 'Add to my calendar' })
    await expect(panel.getByRole('heading', { name: 'Subscribe in your calendar app' })).toBeVisible()
    await expect(panel.getByTestId('calendar-link')).toHaveCount(0)
    expect((await fetch(`${server.url}/calendar/nothing-here.ics`)).status).toBe(404)
    await panel.getByRole('button', { name: 'Make my link' }).click()
    const link = panel.getByTestId('calendar-link')
    await expect(link).toHaveValue(/^https:\/\/chat\.example\.org\/calendar\/[A-Za-z0-9_-]{43}\.ics$/)
    await expect(panel.getByTestId('calendar-webcal')).toHaveAttribute('href', /^webcals:\/\/chat\.example\.org\/calendar\//)
    await expect(panel.getByText('Google can take up to a day')).toBeVisible()
    await expect(panel.getByRole('link', { name: 'Add to Google Calendar' })).toHaveAttribute('href', /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal%3A%2F%2Fchat\.example\.org/)
    await friend.screenshot({ path: join(SHOTS, 'calendar-subscribe.png') })

    // What a calendar service gets: a plain GET, no headers, answers with the event.
    const path = new URL(await link.inputValue()).pathname
    const response = await fetch(server.url + path)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    const ics = await response.text()
    const lines = icsLines(ics)
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines[lines.length - 1]).toBe('END:VCALENDAR')
    expect(lines).toContain('VERSION:2.0')
    expect(lines).toContain('X-WR-CALNAME:Raiders')
    const [event] = icsEvents(ics)
    expect(icsEvents(ics)).toHaveLength(1)
    expect(event.SUMMARY).toBe('Raid night')
    expect(event.DESCRIPTION).toBe('Bring potions\\, flasks\\; and food.')
    expect(event.LOCATION).toBe('The old keep')
    expect(event.STATUS).toBe('CONFIRMED')
    expect(event.UID).toMatch(/^event-\d+-[A-Za-z0-9_-]+@iskra$/)
    expect(event.DTSTART).toMatch(/^\d{8}T\d{6}Z$/)
    // 19:00 on that day for the person who made it, as a UTC instant.
    const [y, m, d] = day.split('-').map(Number)
    const stamp = new Date(y, m - 1, d, 19).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    expect(event.DTSTART).toBe(stamp)
    // Nobody's name is in it.
    expect(ics).not.toContain('Host')
    expect(ics).not.toContain('Friend')

    // The host cancels the event: the same UID comes back cancelled, with a higher sequence.
    await host.getByRole('dialog', { name: 'Events' }).getByRole('radio', { name: 'Agenda' }).click()
    const hostCard = host.locator('.event-card', { hasText: 'Raid night' })
    await hostCard.getByRole('button', { name: 'Cancel event' }).click()
    await hostCard.getByRole('button', { name: 'Cancel event' }).click()
    await expect(hostCard).toHaveCount(0)
    const [cancelled] = icsEvents(await (await fetch(server.url + path)).text())
    expect(cancelled.UID).toBe(event.UID)
    expect(cancelled.STATUS).toBe('CANCELLED')
    expect(Number(cancelled.SEQUENCE)).toBeGreaterThan(Number(event.SEQUENCE))

    // A new link ends the old one.
    await panel.getByRole('button', { name: 'Make a new link' }).click()
    await panel.getByRole('alertdialog').getByRole('button', { name: 'Make a new link' }).click()
    await expect(link).not.toHaveValue(new RegExp(path.replace(/[.]/g, '\\.')))
    const newPath = new URL(await link.inputValue()).pathname
    expect((await fetch(server.url + path)).status).toBe(404)
    expect((await fetch(server.url + newPath)).status).toBe(200)

    // Turning it off ends that one too.
    await panel.getByRole('button', { name: 'Turn off' }).click()
    await panel.getByRole('alertdialog').getByRole('button', { name: 'Turn off' }).click()
    await expect(panel.getByRole('button', { name: 'Make my link' })).toBeVisible()
    expect((await fetch(server.url + newPath)).status).toBe(404)

    // The owner turns calendar links off for everyone: the friend's panel says so, and has no way to make one.
    await host.getByRole('dialog', { name: 'Events' }).getByRole('button', { name: 'Close' }).click()
    const room = await openServerSettings(host, 'Overview')
    const allow = room.getByTestId('calendar-feeds-allowed').getByRole('switch')
    await expect(allow).toBeChecked()
    await allow.click()
    await expect(allow).not.toBeChecked()
    await expect(panel.getByTestId('calendar-feeds-off')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Make my link' })).toHaveCount(0)
  })

  test('the phone app: the agenda first, the month with a day to tap, and events written into the phone\'s calendar', async ({ browser }) => {
    type Saved = { calendarId: string; eventId?: string; ref: string; title: string; startMs: number; endMs: number; timeZone: string; location: string; rrule?: string }
    type Shell = { granted: boolean; asked: number; events: Record<string, Saved>; saves: Saved[]; deletes: string[][] }
    const own = await startServer('Phone raiders')
    const host = await (await browser.newContext()).newPage()
    await joinVia(host, own.ownerLink(), 'Host')

    const context = await browser.newContext({ ...pixel })
    await context.addInitScript(() => {
      // A stand-in for Capacitor's bridge and the app's plugin (mobile/android/.../PhoneCalendar.java).
      const shell: Shell = { granted: false, asked: 0, events: {}, saves: [], deletes: [] }
      let next = 100
      const plugin: Record<string, (options: Record<string, unknown>) => unknown> = {
        voiceStart: () => undefined, voiceUpdate: () => undefined, voiceStop: () => undefined, keepAwake: () => undefined,
        takeShare: () => ({}), shareDone: () => undefined, voiceSpeaker: () => ({ headset: false }), voiceRoutes: () => ({ routes: [], current: 0 }),
        calendarAccess: ({ ask }) => {
          if (ask && !shell.granted) {
            shell.asked++
            shell.granted = true // the person taps Allow
          }
          return { granted: shell.granted }
        },
        calendarList: () => ({
          calendars: [
            { id: '3', name: 'viktor@example.org', account: 'viktor@example.org', primary: true },
            { id: '5', name: 'Family', account: 'viktor@example.org', primary: false },
          ],
        }),
        calendarSave: (options) => {
          const event = options as unknown as Saved
          shell.saves.push(event)
          const id = event.eventId && shell.events[event.eventId] ? event.eventId : String(next++)
          shell.events[id] = event
          return { eventId: id }
        },
        calendarDelete: ({ eventIds }) => {
          const ids = eventIds as string[]
          shell.deletes.push(ids)
          for (const id of ids) delete shell.events[id]
          return { deleted: ids.length }
        },
      }
      const w = window as unknown as Record<string, unknown>
      w.phoneShell = shell
      w.androidBridge = {}
      w.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        PluginHeaders: [{ name: 'IskraNative', methods: [...Object.keys(plugin).map((name) => ({ name, rtype: 'promise' })), { name: 'addListener' }, { name: 'removeListener' }] }],
        nativePromise: async (_plugin: string, method: string, options: Record<string, unknown>) => plugin[method](options ?? {}),
        nativeCallback: (_plugin: string, _method: string, options: { eventName: string }) => options.eventName,
      }
    })
    const phone = await context.newPage()
    const shell = () => phone.evaluate(() => (window as unknown as { phoneShell: Shell }).phoneShell)
    await joinVia(phone, await createInviteLink(host), 'Phone')

    // The host plans a weekly raid and a one-off.
    const hostDialog = await openEvents(host)
    for (const [title, repeat] of [['Weekly raid', 'Every week'], ['Movie night', null]] as const) {
      await hostDialog.getByRole('button', { name: 'Schedule an event' }).click()
      const form = host.getByRole('dialog', { name: 'Schedule an event' })
      await form.getByPlaceholder('Game night').fill(title)
      await form.getByRole('radio', { name: 'Somewhere else' }).click()
      await form.getByLabel('Place').fill('The old keep')
      if (repeat) await form.getByLabel('Repeat').selectOption({ label: repeat })
      await form.getByRole('button', { name: 'Schedule' }).click()
      await expect(form).toHaveCount(0)
    }

    // On a phone Events opens as the agenda: the cards under their days, and the series' next weeks as rows.
    await phone.locator('.chat-header').getByRole('button', { name: 'Open channels' }).click()
    const dialog = await openEvents(phone)
    await expect(dialog.getByRole('radio', { name: 'Agenda' })).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.locator('.event-card', { hasText: 'Weekly raid' })).toBeVisible()
    await expect(dialog.locator('.event-card', { hasText: 'Movie night' })).toBeVisible()
    await expect(dialog.locator('button.agenda-row', { hasText: 'Weekly raid' }).first()).toBeVisible()
    await phone.screenshot({ path: join(SHOTS, 'calendar-phone-agenda.png') })

    // The month fits a phone: dots on the days, and the tapped day's events underneath.
    await dialog.getByRole('radio', { name: 'Month' }).click()
    const month = dialog.getByTestId('calendar-month')
    const dotted = month.locator('.cal-day:has(.cal-dots)').first()
    await expect(dotted).toBeVisible()
    await dotted.click()
    await expect(dialog.getByTestId('calendar-day')).toContainText('Weekly raid')
    await expect(dialog.getByTestId('calendar-day').getByRole('button', { name: 'New event on this day' })).toBeVisible()
    const box = await month.locator('.cal-grid').boundingBox()
    expect(box!.width).toBeLessThanOrEqual(pixel.viewport.width)
    await phone.screenshot({ path: join(SHOTS, 'calendar-phone-month.png') })

    // Put this server's events in my phone's calendar: asks the phone, lists its calendars, writes both events.
    await dialog.getByTestId('calendar-subscribe-open').click()
    const panel = phone.getByRole('dialog', { name: 'Add to my calendar' })
    const section = panel.getByTestId('calendar-phone')
    expect((await shell()).asked).toBe(0)
    await section.getByTestId('calendar-phone-switch').click()
    await expect(section.getByRole('radio')).toHaveText([/viktor@example\.org/, /Family/])
    expect((await shell()).asked).toBe(1)
    await section.getByRole('radio', { name: /Family/ }).click()
    await expect(section.getByText('In the calendar "Family"')).toBeVisible()
    await expect.poll(async () => Object.values((await shell()).events).map((e) => e.title).sort()).toEqual(['Movie night', 'Weekly raid'])
    const written = Object.values((await shell()).events)
    const raid = written.find((e) => e.title === 'Weekly raid')!
    expect(raid.calendarId).toBe('5')
    expect(raid.rrule).toBe('FREQ=WEEKLY')
    expect(raid.ref).toMatch(/^iskra:\/\/event\/[A-Za-z0-9_-]+\/s\d+$/)
    expect(raid.location).toBe('The old keep')
    expect(raid.endMs - raid.startMs).toBe(2 * 3_600_000)
    expect(written.find((e) => e.title === 'Movie night')!.rrule).toBeUndefined()
    await phone.screenshot({ path: join(SHOTS, 'calendar-phone-sync.png') })

    // The host renames one: the phone's event is changed in place, not added again.
    await hostDialog.getByRole('radio', { name: 'Agenda' }).click()
    const movie = host.locator('.event-card', { hasText: 'Movie night' })
    await movie.getByRole('button', { name: 'Edit' }).click()
    const edit = host.getByRole('dialog', { name: 'Edit event' })
    await edit.getByPlaceholder('Game night').fill('Film night')
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect.poll(async () => Object.values((await shell()).events).map((e) => e.title).sort()).toEqual(['Film night', 'Weekly raid'])
    expect(Object.keys((await shell()).events)).toHaveLength(2)
    expect((await shell()).saves.at(-1)!.eventId).toBeDefined()

    // The host cancels it: it's deleted from the phone's calendar.
    const film = host.locator('.event-card', { hasText: 'Film night' })
    await film.getByRole('button', { name: 'Cancel event' }).click()
    await film.getByRole('button', { name: 'Cancel event' }).click()
    await expect.poll(async () => Object.values((await shell()).events).map((e) => e.title)).toEqual(['Weekly raid'])

    // Turning it off removes what the app added.
    await section.getByTestId('calendar-phone-switch').click()
    await expect.poll(async () => Object.keys((await shell()).events)).toEqual([])
    await expect(section.getByText('In the calendar "Family"')).toHaveCount(0)
    // Nothing more is written while it's off.
    const saves = (await shell()).saves.length
    await hostDialog.getByRole('button', { name: 'Schedule an event' }).click()
    const again = host.getByRole('dialog', { name: 'Schedule an event' })
    await again.getByPlaceholder('Game night').fill('Later')
    await again.getByRole('radio', { name: 'Somewhere else' }).click()
    await again.getByLabel('Place').fill('Anywhere')
    await again.getByRole('button', { name: 'Schedule' }).click()
    await expect(phone.locator('.events-button')).toBeAttached()
    await phone.waitForTimeout(2500)
    expect((await shell()).saves.length).toBe(saves)
    await context.close()
    await own.stop()
  })
})

test('a server calendar apps can\'t reach explains that instead of giving a link', async ({ browser }) => {
  const local = await startServer('At home')
  try {
    const host = await (await browser.newContext()).newPage()
    await joinVia(host, local.ownerLink(), 'Host')
    const dialog = await openEvents(host)
    await dialog.getByTestId('calendar-subscribe-open').click()
    const panel = host.getByRole('dialog', { name: 'Add to my calendar' })
    const note = panel.getByTestId('calendar-not-reachable')
    await expect(note).toContainText("Calendar apps can't reach this server")
    await expect(note).toContainText('Internet access')
    await expect(panel.getByRole('button', { name: 'Make my link' })).toHaveCount(0)
    await expect(panel.getByTestId('calendar-link')).toHaveCount(0)
    // On a computer there's no phone calendar; the panel says where that exists.
    await expect(panel.getByTestId('calendar-phone')).toHaveCount(0)
    await expect(panel.getByText('In the Iskra app for Android')).toBeVisible()
    await host.screenshot({ path: join(SHOTS, 'calendar-not-reachable.png') })
  } finally {
    await local.stop()
  }
})

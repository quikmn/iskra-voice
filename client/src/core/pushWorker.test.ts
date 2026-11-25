// Runs the real public/push-sw.js against a fake service worker scope.
import { describe, expect, it, vi } from 'vitest'
import SOURCE from '../../public/push-sw.js?raw'
import { LANGUAGES, PLURAL_FORMS, pluralForms, requiredPluralForms } from '../i18n/languages'

// The per-language tables the worker imports (public/push-text/<code>.js), by code.
const TABLE_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('../../public/push-text/*.js', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    .map(([file, source]) => [file.replace(/^.*\/([^/]+)\.js$/, '$1'), source]),
)

type Table = Record<string, unknown>
function table(source: string): Table {
  const scope: { ISKRA_PUSH_TEXT?: Table } = {}
  new Function('self', source)(scope)
  return scope.ISKRA_PUSH_TEXT ?? {}
}

const SERVER = 'S'.repeat(43)
const PEER = 'p'.repeat(43)
const ORIGIN = 'https://app.iskra.foo'

interface FakeClient {
  url: string
  frameType?: string
  postMessage: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}

function worker(windows: FakeClient[] = [], script = 'push-sw.js', scope = `${ORIGIN}/push/${SERVER}/`, tables: Record<string, string> = TABLE_SOURCES, languages = ['en-US']) {
  const listeners: Record<string, (event: unknown) => void> = {}
  const shown: { title: string; options: Record<string, unknown> }[] = []
  const self = {
    location: new URL(`${ORIGIN}/${script}`),
    registration: {
      scope,
      showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => void shown.push({ title, options })),
      pushManager: { subscribe: vi.fn(async () => ({})) },
    },
    clients: { matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null) },
    addEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
    skipWaiting: vi.fn(),
    navigator: { languages },
    imported: [] as string[],
    // Like the browser: a script that isn't there throws.
    importScripts(url: string) {
      self.imported.push(url)
      const code = /^https:\/\/app\.iskra\.foo\/push-text\/([a-z]+)\.js$/.exec(url)?.[1]
      if (!code || !Object.hasOwn(tables, code)) throw new Error(`NetworkError: ${url}`)
      new Function('self', tables[code])(self)
    },
  }
  new Function('self', SOURCE)(self)

  async function dispatch(type: string, event: Record<string, unknown>) {
    let pending: Promise<unknown> = Promise.resolve()
    listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) })
    await pending
  }
  const push = (data: unknown) => dispatch('push', { data: { json: () => data } })
  const click = (route: string) => dispatch('notificationclick', { notification: { data: { route }, close: vi.fn() } })
  return { self, shown, push, click }
}

const mention = { v: 1, kind: 'mention', server: SERVER, title: 'Alice in #general', body: 'hey @Bob', tag: 'c:7', channelId: 7, count: 1, at: 1 }

describe('push service worker', () => {
  it('shows a mention with a tag per server and conversation, opening that channel', async () => {
    const w = worker()
    await w.push(mention)
    expect(w.shown).toHaveLength(1)
    const [{ title, options }] = w.shown
    expect(title).toBe('Alice in #general')
    expect(options.body).toBe('hey @Bob')
    expect(options.tag).toBe(`${SERVER}:c:7`)
    expect(options.data).toEqual({ route: `/open/${SERVER}/c/7` })
    expect(options.icon).toBe(`${ORIGIN}/icons/icon-192.png`)
  })

  it('routes DMs to the conversation and keeps calls on screen', async () => {
    const w = worker()
    await w.push({ ...mention, kind: 'dm', title: 'New message from Alice', body: 'Open Iskra to read it.', tag: `dm:${PEER}`, channelId: null, peer: PEER })
    await w.push({ ...mention, kind: 'call', title: 'Alice is calling', channelId: null, peer: PEER })
    expect(w.shown[0].options.data).toEqual({ route: `/open/${SERVER}/dm/${PEER}` })
    expect(w.shown[1].options.requireInteraction).toBe(true)
  })

  it('routes group messages and group calls to the group', async () => {
    const w = worker()
    const group = 'g'.repeat(21) + '_'
    await w.push({ ...mention, kind: 'group', title: 'New message from Alice', tag: `g:${group}`, channelId: null, group })
    await w.push({ ...mention, kind: 'call', title: 'Alice started a group call', channelId: null, group })
    await w.push({ ...mention, kind: 'group', channelId: null, group: '../../evil' })
    expect(w.shown[0].options.data).toEqual({ route: `/open/${SERVER}/g/${group}` })
    expect(w.shown[1].options.requireInteraction).toBe(true)
    expect(w.shown[2].options.data).toEqual({ route: `/open/${SERVER}` })
  })

  it('routes reminders to the reminder (its content is sealed, so the app opens it)', async () => {
    const w = worker()
    await w.push({ ...mention, kind: 'reminder', title: 'Reminder', tag: 'reminder:5', channelId: 7, reminder: 5 })
    await w.push({ ...mention, kind: 'reminder', title: 'Reminder', tag: 'reminder:6', channelId: null, reminder: 'x' })
    expect(w.shown[0].options.data).toEqual({ route: `/open/${SERVER}/r/5` })
    expect(w.shown[1].options.data).toEqual({ route: `/open/${SERVER}` })
  })

  it('routes a task you were assigned to the task on its board', async () => {
    const w = worker()
    await w.push({ ...mention, kind: 'task', title: 'Rob assigned you a task', body: 'Bring snacks', tag: 'task:31', channelId: 7, task: 31 })
    await w.push({ ...mention, kind: 'task', title: 'Rob assigned you a task', body: 'Bring snacks', tag: 'task:32', channelId: 7, task: 'x' })
    expect(w.shown[0].title).toBe('Rob assigned you a task')
    expect(w.shown[0].options.body).toBe('Bring snacks')
    expect(w.shown[0].options.data).toEqual({ route: `/open/${SERVER}/c/7/t/31` })
    expect(w.shown[1].options.data).toEqual({ route: `/open/${SERVER}/c/7` })
  })

  it('falls back to a generic notification for anything unexpected', async () => {
    const w = worker()
    await w.push({ ...mention, server: 'X'.repeat(43) }) // another server's payload in this registration
    await w.push({ v: 2 })
    await w.push(null)
    expect(w.shown).toHaveLength(3)
    for (const n of w.shown) {
      expect(n.title).toBe('Iskra')
      expect(n.options.data).toEqual({ route: '/' })
    }
  })

  it('clips long text and ignores routes it cannot vouch for', async () => {
    const w = worker()
    await w.push({ ...mention, title: 'x'.repeat(500), body: 'y'.repeat(5000), channelId: '7; evil', peer: '../../x' })
    expect(w.shown[0].title.length).toBe(120)
    expect((w.shown[0].options.body as string).length).toBe(300)
    expect(w.shown[0].options.data).toEqual({ route: `/open/${SERVER}` })
  })

  it('focuses an open app window and tells it where to go', async () => {
    const app = { url: `${ORIGIN}/`, postMessage: vi.fn(), focus: vi.fn(async () => undefined) }
    const w = worker([app])
    await w.click(`/open/${SERVER}/c/7`)
    expect(app.postMessage).toHaveBeenCalledWith({ type: 'iskra.open', route: `/open/${SERVER}/c/7`, account: 1 })
    expect(app.focus).toHaveBeenCalled()
    expect(w.self.clients.openWindow).not.toHaveBeenCalled()
  })

  it('opens a new window at the route when Iskra is closed', async () => {
    const w = worker()
    await w.click(`/open/${SERVER}/dm/${PEER}`)
    expect(w.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/#/open/${SERVER}/dm/${PEER}`)
  })

  it("names the account a push is for (several accounts on one device), and tells the top page, not an account's frame", async () => {
    const frame = { url: `${ORIGIN}/?account=2`, frameType: 'nested', postMessage: vi.fn(), focus: vi.fn(async () => undefined) }
    const top = { url: `${ORIGIN}/`, frameType: 'top-level', postMessage: vi.fn(), focus: vi.fn(async () => undefined) }
    const w = worker([frame, top], 'push-sw.js', `${ORIGIN}/push/a2/${SERVER}/`)
    await w.push(mention)
    expect(w.shown[0].options.tag).toBe(`${SERVER}:c:7`)
    await w.click(`/open/${SERVER}/c/7`)
    expect(top.postMessage).toHaveBeenCalledWith({ type: 'iskra.open', route: `/open/${SERVER}/c/7`, account: 2 })
    expect(frame.postMessage).not.toHaveBeenCalled()

    // Security review M2: a push naming another server than the scope's is never shown as that server's (account 2+ too).
    const other = worker([], 'push-sw.js', `${ORIGIN}/push/a2/${SERVER}/`)
    await other.push({ ...mention, server: 'X'.repeat(43), title: 'Spoofed', body: 'from elsewhere' })
    expect(other.shown[0].title).toBe('Iskra')
    expect(other.shown[0].options.data).toEqual({ route: '/' })

    const closed = worker([], 'push-sw.js', `${ORIGIN}/push/a2/${SERVER}/`)
    await closed.click(`/open/${SERVER}/c/7`)
    expect(closed.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/?account=2#/open/${SERVER}/c/7`)
  })

  it('shows pushes in Swedish when the app is in Swedish, from the names the server gives its texts', async () => {
    const w = worker([], 'push-sw.js?lang=sv')
    const text = (title: string, body: string | null, args: object = {}) => ({ title, body, args })
    await w.push({ ...mention, text: text('mention', null, { name: 'Alice', channel: 'general' }) })
    await w.push({ ...mention, kind: 'dm', title: 'New message from Alice', body: 'Open Iskra to read it.', text: text('dm', 'openToRead', { name: 'Alice' }) })
    await w.push({ ...mention, kind: 'dm', title: '3 new messages from Alice', from: 'Alice', count: 3, text: text('dm', 'openToRead', { name: 'Alice' }) })
    await w.push({ ...mention, body: 'hey (+2 more)', count: 3, text: text('mention', null, { name: 'Alice', channel: 'general' }) })
    await w.push({ ...mention, kind: 'event', text: text('eventSoon', 'inMinutesChannel', { title: 'Raid', minutes: 15, channel: 'Lounge' }) })
    // Something this worker doesn't know: the server's English.
    await w.push({ ...mention, text: text('somethingNew', null) })
    expect(w.shown.map((n) => [n.title, n.options.body])).toEqual([
      ['Alice i #general', 'hey @Bob'],
      ['Nytt meddelande från Alice', 'Öppna Iskra för att läsa det.'],
      ['3 nya meddelanden från Alice', 'Öppna Iskra för att läsa det.'],
      ['Alice i #general', 'hey (+2 till)'],
      ['Snart: Raid', 'Om 15 min, i Lounge'],
      ['Alice in #general', 'hey @Bob'],
    ])
  })

  it('stays English with ?lang=en', async () => {
    const w = worker([], 'push-sw.js?lang=en')
    await w.push({ ...mention, text: { title: 'mention', body: null, args: { name: 'Alice', channel: 'general' } } })
    expect(w.shown[0].title).toBe('Alice in #general')
  })

  it('shows the quiet hours summary in Swedish from its counts, quietly, opening the server', async () => {
    const digest = {
      v: 1, kind: 'digest', server: SERVER, title: 'While it was quiet', body: '2 mentions, 1 message, 1 alert word', tag: 'digest', count: 1, at: 1, silent: true,
      text: { title: 'digest', body: 'digestBody', args: { mentions: 2, messages: 1, keywords: 1, follows: 0, events: 0, reminders: 0 } },
    }
    const sv = worker([], 'push-sw.js?lang=sv')
    await sv.push(digest)
    await sv.push({ ...digest, text: { ...digest.text, args: { follows: 3, events: 1, reminders: 2 } } })
    expect(sv.shown.map((n) => [n.title, n.options.body])).toEqual([
      ['Medan det var tyst', '2 omnämnanden, 1 meddelande, 1 bevakat ord'],
      ['Medan det var tyst', '3 inlägg av personer du följer, 1 evenemang, 2 påminnelser'],
    ])
    expect(sv.shown[0].options.silent).toBe(true)
    expect(sv.shown[0].options.data).toEqual({ route: `/open/${SERVER}` })
    const en = worker([], 'push-sw.js?lang=en')
    await en.push(digest)
    expect([en.shown[0].title, en.shown[0].options.body]).toEqual(['While it was quiet', '2 mentions, 1 message, 1 alert word'])
  })
})

describe('push texts per language (public/push-text)', () => {
  /** Every text by path; a plural text gives one entry per form ("digest.events#one"). */
  function flatten(tree: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
    for (const [key, value] of Object.entries(tree as Table)) {
      const path = prefix ? `${prefix}.${key}` : key
      const forms = value && typeof value === 'object' && Object.keys(value).every((k) => (PLURAL_FORMS as readonly string[]).includes(k))
      if (typeof value === 'string') out[path] = value
      else if (forms) for (const [form, text] of Object.entries(value as Table)) out[`${path}#${form}`] = String(text)
      else flatten(value, path, out)
    }
    return out
  }
  const variables = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
  const english = flatten(table(TABLE_SOURCES.en))
  const englishFor = (path: string) => english[path] ?? english[path.replace(/#\w+$/, '#other')] ?? english[path.replace(/#\w+$/, '')]
  const names = (texts: Record<string, string>) => [...new Set(Object.keys(texts).map((path) => path.replace(/#\w+$/, '')))].sort()

  it('has the English reference, and only tables for registered languages', () => {
    expect(Object.keys(TABLE_SOURCES)).toContain('en')
    for (const code of Object.keys(TABLE_SOURCES)) expect(LANGUAGES as readonly string[], `push-text/${code}.js`).toContain(code)
    expect(names(english).length).toBeGreaterThanOrEqual(40)
  })

  it('says in English what the server says', () => {
    const server = Object.values(import.meta.glob('../../../server/src/Iskra.Server/**/*.cs', { query: '?raw', import: 'default', eager: true }) as Record<string, string>).join('\n')
    // Texts without a value in them are in the server's code word for word (the others are built there from parts).
    const fixed = Object.entries(english).filter(([path, text]) => !text.includes('{{') && !path.startsWith('generic') && !/Voice$/.test(path))
    expect(fixed.length).toBeGreaterThan(10)
    expect(fixed.filter(([, text]) => !server.includes(`"${text}"`)).map(([path]) => path)).toEqual([])
  })

  for (const code of Object.keys(TABLE_SOURCES).filter((c) => c !== 'en')) {
    it(`${code}: the same texts as English, none empty, the same {{variables}}, the plural forms the language needs`, () => {
      const texts = flatten(table(TABLE_SOURCES[code]))
      expect(names(texts)).toEqual(names(english))
      const allowed = pluralForms(code) as string[]
      const wrong: string[] = []
      for (const [path, text] of Object.entries(texts)) {
        const form = /#(\w+)$/.exec(path)?.[1]
        if (!text.trim()) wrong.push(`${path} (empty)`)
        if (form && !allowed.includes(form)) wrong.push(`${path} (never used in this language)`)
        if (JSON.stringify(variables(text)) !== JSON.stringify(variables(englishFor(path)))) wrong.push(`${path} (variables)`)
        if (englishFor(path).includes('Iskra') && !text.includes('Iskra')) wrong.push(`${path} (lost the name Iskra)`)
        if (/^\s/.test(text) !== /^\s/.test(englishFor(path))) wrong.push(`${path} (the space in front)`)
      }
      // A text with plural forms has all the language needs.
      for (const name of new Set(Object.keys(texts).filter((path) => path.includes('#')).map((path) => path.replace(/#\w+$/, '')))) {
        for (const form of requiredPluralForms(code)) if (texts[`${name}#${form}`] === undefined) wrong.push(`${name}#${form} (missing)`)
      }
      expect(wrong).toEqual([])
    })
  }

  it('loads only the table of the language it was registered with, and none for English', async () => {
    expect(worker([], 'push-sw.js?lang=sv').self.imported).toEqual([`${ORIGIN}/push-text/sv.js`])
    expect(worker([], 'push-sw.js?lang=en').self.imported).toEqual([])
    expect(worker([], 'push-sw.js?lang=../x').self.imported).toEqual([])
    expect(worker([], 'push-sw.js', undefined, undefined, ['sv-SE', 'en']).self.imported).toEqual([`${ORIGIN}/push-text/sv.js`])
  })

  it("shows the server's English for a language without a table", async () => {
    const w = worker([], 'push-sw.js?lang=xx')
    expect(w.self.imported).toEqual([`${ORIGIN}/push-text/xx.js`])
    await w.push({ ...mention, text: { title: 'mention', body: null, args: { name: 'Alice', channel: 'general' } } })
    await w.push(null)
    expect(w.shown.map((n) => [n.title, n.options.body])).toEqual([['Alice in #general', 'hey @Bob'], ['Iskra', 'You have new activity.']])
  })

  it('picks plural forms by the language’s rules (a Russian table)', async () => {
    const ru = `self.ISKRA_PUSH_TEXT = {
      generic: 'Новая активность.',
      title: { digest: 'Пока было тихо', dm: 'Новое сообщение от {{name}}', mention: '{{name}} в #{{channel}}' },
      body: { openToRead: 'Откройте Iskra, чтобы прочитать.' },
      dmCount: { one: '{{count}} новое сообщение от {{from}}', few: '{{count}} новых сообщения от {{from}}', many: '{{count}} новых сообщений от {{from}}', other: '{{count}} нового сообщения от {{from}}' },
      more: ' (ещё {{n}})',
      digest: {
        mentions: { one: '{{n}} упоминание', few: '{{n}} упоминания', many: '{{n}} упоминаний', other: '{{n}} упоминания' },
        messages: { one: '{{n}} сообщение', other: '{{n}} сообщения' },
      },
    }`
    const w = worker([], 'push-sw.js?lang=ru', undefined, { ru })
    const digest = (args: object) => ({ v: 1, kind: 'digest', server: SERVER, title: 'While it was quiet', body: 'x', tag: 'digest', count: 1, at: 1, text: { title: 'digest', body: 'digestBody', args } })
    await w.push(digest({ mentions: 1, messages: 21 }))
    await w.push(digest({ mentions: 3, messages: 5 }))
    await w.push(digest({ mentions: 11, reminders: 2 }))
    const dm = (count: number) => ({ ...mention, kind: 'dm', title: 'x', from: 'Alice', count, text: { title: 'dm', body: 'openToRead', args: { name: 'Alice' } } })
    await w.push(dm(2))
    await w.push(dm(5))
    await w.push(dm(21))
    await w.push({ ...mention, body: 'hey (+2 more)', count: 3, text: { title: 'mention', body: null, args: { name: 'Alice', channel: 'general' } } })
    await w.push(null)
    expect(w.shown.map((n) => [n.title, n.options.body])).toEqual([
      ['Пока было тихо', '1 упоминание, 21 сообщение'],
      // A form the table leaves out falls back to its `other`.
      ['Пока было тихо', '3 упоминания, 5 сообщения'],
      // A kind the table doesn't have is left out.
      ['Пока было тихо', '11 упоминаний'],
      ['2 новых сообщения от Alice', 'Откройте Iskra, чтобы прочитать.'],
      ['5 новых сообщений от Alice', 'Откройте Iskra, чтобы прочитать.'],
      ['21 новое сообщение от Alice', 'Откройте Iskra, чтобы прочитать.'],
      ['Alice в #general', 'hey (ещё 2)'],
      ['Iskra', 'Новая активность.'],
    ])
  })
})

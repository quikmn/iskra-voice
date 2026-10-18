// Iskra push notifications. Each server gets its own registration of this worker (scope /push/<serverKey>/), because
// every server signs pushes with its own key and a registration can only hold one push subscription.
// It only shows notifications and opens the app on a click: it never caches or serves the app itself.
// (/service-worker.js is a different file: it removes a worker an earlier web client installed.)

const KEY = /^[A-Za-z0-9_-]{43}$/
const GROUP = /^[A-Za-z0-9_-]{22}$/
const APP_ROOT = new URL('./', self.location.href) // this file sits next to index.html
const ICON = new URL('icons/icon-192.png', APP_ROOT).href
const BADGE = new URL('icons/badge-96.png', APP_ROOT).href

self.addEventListener('install', () => self.skipWaiting())

/** The server this registration belongs to, from its scope. */
function scopeServer() {
  // /push/<key>/ for account 1, /push/a<n>/<key>/ for the other accounts on the device.
  const match = /\/push\/(?:a[1-9][0-9]?\/)?([A-Za-z0-9_-]{43})\/$/.exec(new URL(self.registration.scope).pathname)
  return match ? match[1] : null
}

/** Which account on this device it's for: /push/a<n>/<key>/, or /push/<key>/ for account 1. */
function scopeAccount() {
  const match = /\/push\/a([1-9][0-9]?)\/[A-Za-z0-9_-]{43}\/$/.exec(new URL(self.registration.scope).pathname)
  return match ? Number(match[1]) : 1
}

/** Where a click on this push should take you, as an app route ("/open/..."). */
function routeFor(data) {
  const base = `/open/${data.server}`
  if (data.kind === 'reminder' && Number.isSafeInteger(data.reminder) && data.reminder > 0) return `${base}/r/${data.reminder}`
  if (typeof data.group === 'string' && GROUP.test(data.group)) return `${base}/g/${data.group}`
  if (data.kind === 'dm' && typeof data.peer === 'string' && KEY.test(data.peer)) return `${base}/dm/${data.peer}`
  if (Number.isSafeInteger(data.channelId) && data.channelId > 0) return `${base}/c/${data.channelId}`
  if (typeof data.peer === 'string' && KEY.test(data.peer)) return `${base}/dm/${data.peer}`
  return base
}

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

// Pushes are written in English and name their texts (`text: { title, body, args }`); the app registers this worker
// with `?lang=` so they show in its language. Only Swedish needs a table: anything unknown shows the server's English.
const SV = {
  title: {
    mention: '{{name}} i #{{channel}}',
    reply: '{{name}} svarade i #{{channel}}',
    encrypted: 'Nytt meddelande i #{{channel}}',
    dm: 'Nytt meddelande från {{name}}',
    calling: '{{name}} ringer',
    groupCall: '{{name}} startade ett gruppsamtal',
    reminder: 'Påminnelse',
    scheduledFailed: 'Ditt schemalagda meddelande skickades inte',
    eventLive: '{{title}} börjar nu',
    eventSoon: 'Snart: {{title}}',
    lfgJoined: '{{name}} gick med i din grupp för {{game}}',
    lfgFull: 'Din grupp för {{game}} är full',
    lfgPosted: '{{name}} söker {{slots}} till {{game}}',
    digest: 'Medan det var tyst',
  },
  body: {
    openToRead: 'Öppna Iskra för att läsa det.',
    groupOpenToRead: 'I en gruppchatt. Öppna Iskra för att läsa det.',
    attachment: 'Skickade en bilaga',
    tapToAnswer: 'Tryck för att svara.',
    tapToJoin: 'Tryck för att gå med.',
    reminderGeneric: 'Du bad om en påminnelse om ett meddelande.',
    happeningChannel: 'Pågår i {{channel}}',
    happeningVoice: 'Pågår i en röstkanal',
    happeningAt: 'Pågår: {{place}}',
    happening: 'Pågår nu',
    inMinutesChannel: 'Om {{minutes}} min, i {{channel}}',
    inMinutesVoice: 'Om {{minutes}} min, i en röstkanal',
    inMinutesAt: 'Om {{minutes}} min, {{place}}',
    inMinutes: 'Om {{minutes}} min',
    lfgIn: 'I #{{channel}}',
    lfgTime: 'Dags att spela!',
  },
  dmCount: '{{count}} nya meddelanden från {{from}}',
  groupCount: '{{count}} nya meddelanden i en gruppchatt',
  more: ' (+{{n}} till)',
  // The quiet hours summary's body ("digestBody"), built from its counts: [one, many] per kind, in the server's order.
  digest: [
    ['mentions', '1 omnämnande', '{{n}} omnämnanden'],
    ['messages', '1 meddelande', '{{n}} meddelanden'],
    ['keywords', '1 bevakat ord', '{{n}} bevakade ord'],
    ['follows', '1 inlägg av någon du följer', '{{n}} inlägg av personer du följer'],
    ['events', '1 evenemang', '{{n}} evenemang'],
    ['reminders', '1 påminnelse', '{{n}} påminnelser'],
  ],
}

/** "2 omnämnanden, 1 meddelande" from the summary's counts; empty if there are none. */
function digestBody(args) {
  const parts = []
  for (const [name, one, many] of SV.digest) {
    const n = Number.isSafeInteger(args[name]) && args[name] > 0 ? args[name] : 0
    if (n > 0) parts.push(n === 1 ? one : fill(many, { n }))
  }
  return parts.join(', ')
}

function language() {
  const chosen = new URL(self.location.href).searchParams.get('lang')
  if (chosen === 'sv' || chosen === 'en') return chosen
  const preferred = (self.navigator && self.navigator.languages) || []
  for (const tag of preferred) {
    const base = String(tag).toLowerCase().split('-')[0]
    if (base === 'sv' || base === 'en') return base
  }
  return 'en'
}

const fill = (text, args) => text.replace(/\{\{(\w+)\}\}/g, (_, name) => (args && args[name] != null ? String(args[name]) : ''))

/** The push's title and body in Swedish, or null to show the server's English. */
function swedish(data) {
  const text = data.text
  if (!text || typeof text !== 'object' || typeof text.title !== 'string' || !Object.hasOwn(SV.title, text.title)) return null
  const args = text.args && typeof text.args === 'object' ? text.args : {}
  const count = Number.isSafeInteger(data.count) ? data.count : 1
  const digest = text.body === 'digestBody' ? digestBody(args) : ''
  const own = typeof text.body === 'string' && (Object.hasOwn(SV.body, text.body) || digest !== '')
  if (text.body != null && !own) return null
  let title = fill(SV.title[text.title], args)
  let body = digest || (own ? fill(SV.body[text.body], args) : String(data.body || '').replace(/ \(\+\d+ more\)$/, ''))
  if (count > 1 && data.kind === 'dm') title = fill(SV.dmCount, { count, from: data.from })
  else if (count > 1 && data.kind === 'group') title = fill(SV.groupCount, { count })
  else if (count > 1) body += fill(SV.more, { n: count - 1 })
  return { title, body }
}

/** The notification for a push payload, or a generic one if the payload isn't something we understand. */
function notificationFor(data, server) {
  const valid = data && data.v === 1 && typeof data.server === 'string' && KEY.test(data.server) && (!server || data.server === server)
    && typeof data.title === 'string' && data.title.length > 0
  if (!valid) {
    return { title: 'Iskra', options: { body: language() === 'sv' ? 'Du har ny aktivitet.' : 'You have new activity.', tag: 'iskra', icon: ICON, data: { route: '/' } } }
  }
  const call = data.kind === 'call'
  const shown = (language() === 'sv' && swedish(data)) || data
  return {
    title: clip(shown.title, 120),
    options: {
      body: clip(shown.body, 300),
      tag: `${data.server}:${clip(data.tag, 80)}`,
      renotify: true,
      icon: ICON,
      badge: BADGE,
      timestamp: Number.isSafeInteger(data.at) ? data.at : Date.now(),
      requireInteraction: call,
      silent: data.silent === true, // quiet hours: shown without a sound
      data: { route: routeFor(data) },
    },
  }
}

self.addEventListener('push', (event) => {
  let data = null
  try {
    data = event.data ? event.data.json() : null
  } catch {
    /* not JSON: show the generic notification */
  }
  const { title, options } = notificationFor(data, scopeServer())
  // Browsers require a visible notification for every push.
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const route = (event.notification.data && event.notification.data.route) || '/'
  event.waitUntil(openApp(route))
})

/**
 * Focuses an open Iskra window and tells it where to go (and for which account), or opens a new one there. With
 * several accounts signed in, the window's top page holds one frame per account and passes it on.
 */
async function openApp(route) {
  const account = scopeAccount()
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const open = windows.filter((c) => c.url.startsWith(APP_ROOT.href) && !c.url.startsWith(new URL('push/', APP_ROOT).href))
  const app = open.find((c) => c.frameType === 'top-level') || open[0]
  if (app) {
    app.postMessage({ type: 'iskra.open', route, account })
    return app.focus()
  }
  return self.clients.openWindow(new URL(account === 1 ? `#${route}` : `?account=${account}#${route}`, APP_ROOT).href)
}

// The browser replaced the subscription: subscribe again with the same server key. The app sends the new
// endpoint to the server the next time it connects.
self.addEventListener('pushsubscriptionchange', (event) => {
  const options = event.oldSubscription && event.oldSubscription.options
  if (options && options.applicationServerKey) {
    event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey }))
  }
})

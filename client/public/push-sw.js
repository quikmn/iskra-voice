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
  const match = /\/push\/([A-Za-z0-9_-]{43})\/$/.exec(new URL(self.registration.scope).pathname)
  return match ? match[1] : null
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

/** The notification for a push payload, or a generic one if the payload isn't something we understand. */
function notificationFor(data, server) {
  const valid = data && data.v === 1 && typeof data.server === 'string' && KEY.test(data.server) && (!server || data.server === server)
    && typeof data.title === 'string' && data.title.length > 0
  if (!valid) {
    return { title: 'Iskra', options: { body: 'You have new activity.', tag: 'iskra', icon: ICON, data: { route: '/' } } }
  }
  const call = data.kind === 'call'
  return {
    title: clip(data.title, 120),
    options: {
      body: clip(data.body, 300),
      tag: `${data.server}:${clip(data.tag, 80)}`,
      renotify: true,
      icon: ICON,
      badge: BADGE,
      timestamp: Number.isSafeInteger(data.at) ? data.at : Date.now(),
      requireInteraction: call,
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

/** Focuses an open Iskra window and tells it where to go, or opens a new one there. */
async function openApp(route) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const app = windows.find((c) => c.url.startsWith(APP_ROOT.href) && !c.url.startsWith(new URL('push/', APP_ROOT).href))
  if (app) {
    app.postMessage({ type: 'iskra.open', route })
    return app.focus()
  }
  return self.clients.openWindow(new URL(`#${route}`, APP_ROOT).href)
}

// The browser replaced the subscription: subscribe again with the same server key. The app sends the new
// endpoint to the server the next time it connects.
self.addEventListener('pushsubscriptionchange', (event) => {
  const options = event.oldSubscription && event.oldSubscription.options
  if (options && options.applicationServerKey) {
    event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey }))
  }
})

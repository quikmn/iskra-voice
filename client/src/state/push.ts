// Web Push: notifications while Iskra is closed, in browsers. Each server has its own push key, and a service worker
// registration holds one subscription, so every server gets its own registration of /push-sw.js (scope /push/<key>/).
// The server skips devices that are looking at Iskra, so this reports focus to every server we're subscribed on.
// The desktop app has native notifications and doesn't use any of this; the phone apps notify while they're open.
import { create } from 'zustand'
import { currentLanguage, onLanguage, t } from '../i18n'
import { errorMessage } from '../i18n/errors'
import { b64u, fromB64u } from '../core/crypto'
import { parseOpenRoute, pushScope, pushSupport, serverOfScope, type OpenTarget, type PushSupport } from '../core/pushRoute'
import { accountSlot } from '../core/accountSlot'
import { desktop } from '../platform/desktop'
import { native } from '../platform/native'
import { pushActive, updateNotify, useNotify } from './notify'
import { connectionFor, onWelcomeHook, selectChannel, selectServer, useApp } from './store'

type Permission = 'granted' | 'denied' | 'default'

interface PushState {
  /** Servers this device gets pushes from ('error': registering failed). */
  servers: Record<string, 'on' | 'error'>
  error: string | null
}

export const usePush = create<PushState>(() => ({ servers: {}, error: null }))

/** May this browser show notifications. */
export function pushPermission(): Permission {
  return typeof Notification === 'undefined' ? 'default' : Notification.permission
}

/** 'phone-app': the phone apps notify while they're open, and have no push while closed. */
export function currentPushSupport(): PushSupport | 'desktop-app' | 'phone-app' {
  if (desktop) return 'desktop-app'
  if (native) return 'phone-app'
  return pushSupport({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone: matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
  })
}

const canPush = () => currentPushSupport() === 'supported' && useNotify.getState().push && pushPermission() === 'granted'

function setServer(key: string, state: 'on' | 'error' | null, error: string | null = null): void {
  if (state === 'on') pushActive.add(key)
  else pushActive.delete(key)
  usePush.setState((s) => {
    const servers = { ...s.servers }
    if (state) servers[key] = state
    else delete servers[key]
    return { servers, error: error ?? (state === 'error' ? s.error : null) }
  })
}

/** Turns push on for this device (asks for permission; call it from a click) and registers with every server. */
export async function enablePush(): Promise<boolean> {
  if (currentPushSupport() !== 'supported') return false
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') {
    updateNotify({ push: false })
    return false
  }
  updateNotify({ push: true })
  usePush.setState({ error: null })
  await Promise.all(useApp.getState().order.map((key) => syncServer(key)))
  return true
}

export async function disablePush(): Promise<void> {
  updateNotify({ push: false })
  const keys = useApp.getState().order
  await Promise.all(keys.map((key) => connectionFor(key)?.request('push.unsubscribe', {}).catch(() => undefined)))
  for (const reg of await pushRegistrations()) await reg.unregister().catch(() => undefined)
  for (const key of Object.keys(usePush.getState().servers)) setServer(key, null)
}

/** The worker shows pushes in the app's language, so it's registered with it. */
const workerUrl = () => `/push-sw.js?lang=${currentLanguage()}`

async function pushRegistrations(): Promise<ServiceWorkerRegistration[]> {
  if (!('serviceWorker' in navigator)) return []
  // The desktop app's app:// page has no service workers: getRegistrations() rejects (InvalidStateError).
  const regs = await navigator.serviceWorker.getRegistrations().catch(() => [] as readonly ServiceWorkerRegistration[])
  return regs.filter((r) => serverOfScope(r.scope) !== null)
}

/** Resolves once the registration has an active worker (subscribing needs one). */
function activated(reg: ServiceWorkerRegistration): Promise<void> {
  const worker = reg.installing ?? reg.waiting
  if (reg.active || !worker) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('app.push.workerFailed'))), 15_000)
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

const syncing = new Map<string, Promise<void>>()

/** Makes sure this server has this device's current subscription. Runs after every welcome while push is on. */
function syncServer(key: string): Promise<void> {
  const running = syncing.get(key)
  if (running) return running
  const job = doSync(key).finally(() => syncing.delete(key))
  syncing.set(key, job)
  return job
}

async function doSync(key: string): Promise<void> {
  if (!canPush()) return
  const connection = connectionFor(key)
  if (!connection?.isOnline) return
  try {
    const { publicKey, endpoint } = await connection.request('push.status', {})
    const reg = await navigator.serviceWorker.register(workerUrl(), { scope: pushScope(key) })
    await activated(reg)
    let sub = await reg.pushManager.getSubscription()
    const subKey = sub?.options.applicationServerKey
    if (sub && (!subKey || b64u(new Uint8Array(subKey)) !== publicKey)) {
      // The server's key changed (a new server at the same address): start over.
      await sub.unsubscribe()
      sub = null
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(publicKey) as BufferSource })
    const keys = sub.toJSON().keys
    if (!keys?.p256dh || !keys.auth) throw new Error(t('app.push.noKeys'))
    if (sub.endpoint !== endpoint) await connection.request('push.subscribe', { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } })
    setServer(key, 'on')
    lastFocus.delete(key)
    reportFocus(key)
  } catch (e) {
    setServer(key, 'error', errorMessage(e))
  }
}

// ── Installing the web app (Chrome, Edge, Android) ─────────────────────────

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** The browser's install offer, kept for the "Install Iskra" button (the browser's own prompt still shows as usual). */
export const useInstall = create<{ prompt: InstallPromptEvent | null }>(() => ({ prompt: null }))

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => useInstall.setState({ prompt: e as InstallPromptEvent }))
  window.addEventListener('appinstalled', () => useInstall.setState({ prompt: null }))
}

export async function installApp(): Promise<void> {
  const prompt = useInstall.getState().prompt
  if (!prompt) return
  useInstall.setState({ prompt: null }) // each offer can only be used once
  await prompt.prompt()
}

// ── Focus: pushes go only to devices nobody is looking at ───────────────────

const lastFocus = new Map<string, boolean>()
const focusedNow = () => document.visibilityState === 'visible' && document.hasFocus()

function reportFocus(key: string): void {
  if (usePush.getState().servers[key] !== 'on') return
  const focused = focusedNow()
  if (lastFocus.get(key) === focused) return
  lastFocus.set(key, focused)
  connectionFor(key)?.request('push.focus', { focused }).catch(() => lastFocus.delete(key))
}

onWelcomeHook((key) => {
  lastFocus.delete(key) // a new session starts out unfocused on the server
  void syncServer(key)
})

// ── Opening what a notification was about ──────────────────────────────────

export function openTarget(target: OpenTarget): void {
  if (!useApp.getState().servers[target.server]) return
  if (target.kind === 'group') {
    void import('./groups').then(({ groupKey, openGroup }) => openGroup(groupKey(target.server, target.group)))
    return
  }
  if (target.kind === 'dm') {
    void import('./dms').then(({ openConversation }) => openConversation(target.peer))
    return
  }
  if (target.kind === 'reminder') {
    // Its content is sealed: open it once the server is connected and its reminders are loaded.
    const open = () => void import('./reminders').then(({ openReminder }) => openReminder(target.server, target.id))
    if (useApp.getState().servers[target.server]?.status.state === 'online') return open()
    const stop = useApp.subscribe((state) => {
      if (state.servers[target.server]?.status.state !== 'online') return
      stop()
      open()
    })
    return
  }
  selectServer(target.server)
  if (target.kind !== 'channel') return
  if (target.pageId !== undefined) {
    const { server, channelId, pageId } = target
    void import('./docs').then(({ goToPage }) => goToPage(server, channelId, pageId))
    return
  }
  if (target.messageId === undefined) return selectChannel(target.server, target.channelId)
  // A message link: jump once this server is connected.
  const { server, channelId, messageId } = target
  const jump = () => void import('./jump').then(({ jumpToMessage }) => jumpToMessage(server, channelId, messageId))
  if (useApp.getState().servers[server]?.status.state === 'online') return jump()
  selectChannel(server, channelId)
  const stop = useApp.subscribe((state) => {
    if (state.servers[server]?.status.state !== 'online') return
    stop()
    jump()
  })
}

/** A fresh window opened from a notification: wait until the saved servers are loaded. */
function openWhenReady(target: OpenTarget): void {
  if (useApp.getState().phase === 'ready') {
    openTarget(target)
    return
  }
  const stop = useApp.subscribe((state) => {
    if (state.phase !== 'ready') return
    stop()
    setTimeout(() => openTarget(target), 0) // after boot has picked its default server
  })
}

function readOpenHash(): void {
  if (!window.location.hash.startsWith('#/open/')) return
  const target = parseOpenRoute(window.location.hash)
  history.replaceState(null, '', window.location.pathname + window.location.search)
  if (target) openWhenReady(target)
}

/** Wires up notification clicks, focus reporting and cleanup. Returns a function that undoes it. */
export function startPush(): () => void {
  readOpenHash()
  let timer: ReturnType<typeof setTimeout> | undefined
  const onFocusChange = () => {
    clearTimeout(timer)
    timer = setTimeout(() => Object.keys(usePush.getState().servers).forEach(reportFocus), 250)
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; route?: unknown; account?: unknown } | null
    if (data?.type !== 'iskra.open' || typeof data.route !== 'string') return
    // Another account's push (one that was signed out here): not this account's to open.
    if (data.account !== undefined && data.account !== accountSlot()) return
    const target = parseOpenRoute(data.route)
    if (target) openWhenReady(target)
  }
  // Removing a server from the list also removes its push registration (the server then sees the subscription is gone).
  let order = useApp.getState().order
  const stopOrder = useApp.subscribe((state) => {
    const removed = order.filter((key) => !state.order.includes(key))
    order = state.order
    if (!removed.length) return
    void pushRegistrations().then((regs) => {
      for (const reg of regs) if (removed.includes(serverOfScope(reg.scope)!)) void reg.unregister().catch(() => undefined)
    })
    for (const key of removed) setServer(key, null)
  })

  // A new language: update the workers (their subscriptions stay).
  let language = currentLanguage()
  const stopLanguage = onLanguage((next) => {
    if (next === language) return
    language = next
    void pushRegistrations().then((regs) => {
      for (const reg of regs) void navigator.serviceWorker.register(workerUrl(), { scope: reg.scope }).catch(() => undefined)
    })
  })

  window.addEventListener('hashchange', readOpenHash)
  window.addEventListener('focus', onFocusChange)
  window.addEventListener('blur', onFocusChange)
  document.addEventListener('visibilitychange', onFocusChange)
  navigator.serviceWorker?.addEventListener('message', onMessage)
  return () => {
    clearTimeout(timer)
    stopOrder()
    stopLanguage()
    window.removeEventListener('hashchange', readOpenHash)
    window.removeEventListener('focus', onFocusChange)
    window.removeEventListener('blur', onFocusChange)
    document.removeEventListener('visibilitychange', onFocusChange)
    navigator.serviceWorker?.removeEventListener('message', onMessage)
  }
}

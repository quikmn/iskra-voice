// What the phone app (mobile/, a Capacitor shell around this client) adds. Undefined in a browser and in the desktop app.
// The Capacitor packages are only imported inside the app, so the web build doesn't load them.

export type NativePlatform = 'ios' | 'android'

/** What the app needs to get native push from a server through the Iskra push relay. */
export interface NativePushRegistration {
  platform: NativePlatform
  /** APNs device token (hex) or FCM registration token. */
  token: string
  /** iOS: the PushKit token, so calls ring through CallKit. */
  voip?: string
  /** iOS development builds use APNs's sandbox. */
  sandbox?: boolean
  /** The app's own Web Push keys (P-256 public key, 16-byte auth secret; b64u). The private key stays in native code. */
  p256dh: string
  auth: string
}

export type NativePermission = 'granted' | 'denied' | 'prompt'

/** Answer or decline pressed on the phone's own call screen (CallKit, Android's call notification). */
export interface NativeCallAction {
  action: 'answer' | 'decline'
  server: string
  peer?: string
  group?: string
}

export interface NativePush {
  permission(): Promise<NativePermission>
  /** Asks for permission when needed (call it from a tap) and returns this device's tokens and keys. */
  register(): Promise<NativePushRegistration>
  /** The push token changed (the OS rotates them): register again. */
  onTokenChange(callback: () => void): () => void
  /** A notification was tapped (including the one that opened the app): an "#/open/…" route. */
  onOpen(callback: (route: string) => void): () => void
  onCallAction(callback: (action: NativeCallAction) => void): () => void
}

/** Keeps voice going with the screen off: iOS audio session + CallKit for calls, Android's foreground service. */
export interface NativeVoice {
  start(options: { title: string; call: boolean; video: boolean }): Promise<void>
  update(options: { title: string }): Promise<void>
  stop(): Promise<void>
  /** Hung up from the system (CallKit, the notification's Leave button). */
  onEnd(callback: () => void): () => void
  /** Muted or unmuted from CallKit. */
  onMute(callback: (muted: boolean) => void): () => void
}

export interface NativeBridge {
  platform: NativePlatform
  /** Links that open the app (Universal Links on app.iskra.foo, iskra://), including the one that started it. */
  onOpenUrl(callback: (url: string) => void): () => void
  /** Hands a file to the share sheet (Save to Files, AirDrop, ...). False when the person cancels. */
  saveFile(blob: Blob, name: string): Promise<boolean>
  /** Status bar text that reads on the theme's background. */
  setStatusBar(scheme: 'dark' | 'light'): Promise<void>
  push: NativePush
  voice: NativeVoice
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

/** The native bridge puts window.Capacitor in place before the page's scripts run. */
export function nativePlatform(scope: { Capacitor?: CapacitorGlobal } = globalThis as { Capacitor?: CapacitorGlobal }): NativePlatform | null {
  const cap = scope.Capacitor
  try {
    if (!cap?.isNativePlatform?.()) return null
    const platform = cap.getPlatform?.()
    return platform === 'ios' || platform === 'android' ? platform : null
  } catch {
    return null
  }
}

export type NativeLink = { kind: 'invite'; token: string } | { kind: 'link'; code: string }

/** What an opened URL asks for: an invite ("#/join/…", iskra://join/…) or a device link ("#/link/…"). */
export function nativeLinkTarget(url: string): NativeLink | null {
  const link = url.indexOf('#/link/')
  if (link >= 0) return { kind: 'link', code: url.slice(link) }
  const join = url.indexOf('/join/')
  if (join >= 0 && (url.startsWith('iskra://join/') || url.includes('#/join/'))) return { kind: 'invite', token: url.slice(join + 6) }
  return null
}

/** A plain file name for the app's cache folder: no folders, no control characters, not too long. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\:]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(-120)
  return cleaned || 'file'
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

interface Listener {
  remove(): Promise<void>
}

/** The app's own plugin (mobile/ios/App/App/IskraNative.swift, mobile/android/…/IskraNativePlugin.java). */
interface IskraNativePlugin {
  pushPermission(): Promise<{ permission: NativePermission }>
  pushRegister(): Promise<NativePushRegistration>
  voiceStart(options: { title: string; call: boolean; video: boolean }): Promise<void>
  voiceUpdate(options: { title: string }): Promise<void>
  voiceStop(): Promise<void>
  addListener(event: 'pushToken', callback: () => void): Promise<Listener>
  addListener(event: 'pushOpened', callback: (data: { route?: unknown }) => void): Promise<Listener>
  addListener(event: 'callAction', callback: (data: Record<string, unknown>) => void): Promise<Listener>
  addListener(event: 'voiceEnded', callback: () => void): Promise<Listener>
  addListener(event: 'voiceMuted', callback: (data: { muted?: unknown }) => void): Promise<Listener>
}

let pluginPromise: Promise<IskraNativePlugin> | null = null
const plugin = () => (pluginPromise ??= import('@capacitor/core').then(({ registerPlugin }) => registerPlugin<IskraNativePlugin>('IskraNative')))

/** Adds a plugin listener; the returned function removes it (also if it's called before the listener is in place). */
function listen<T>(event: string, callback: (data: T) => void): () => void {
  let stopped = false
  let handle: Listener | null = null
  void plugin()
    .then((p) => (p.addListener as (e: string, cb: (data: T) => void) => Promise<Listener>)(event, callback))
    .then((h) => {
      if (stopped) void h.remove()
      else handle = h
    })
    .catch(() => undefined)
  return () => {
    stopped = true
    void handle?.remove()
  }
}

const KEY_RE = /^[A-Za-z0-9_-]{43}$/
const GROUP_RE = /^[A-Za-z0-9_-]{22}$/

/** Checks what the native side passes up from a call notification. */
export function parseCallAction(data: Record<string, unknown>): NativeCallAction | null {
  const { action, server, peer, group } = data
  if ((action !== 'answer' && action !== 'decline') || typeof server !== 'string' || !KEY_RE.test(server)) return null
  if (typeof peer === 'string' && KEY_RE.test(peer)) return { action, server, peer }
  if (typeof group === 'string' && GROUP_RE.test(group)) return { action, server, group }
  return null
}

function bridge(platform: NativePlatform): NativeBridge {
  return {
    platform,
    onOpenUrl(callback) {
      let stopped = false
      let remove: (() => void) | null = null
      void import('@capacitor/app').then(async ({ App }) => {
        const launch = await App.getLaunchUrl().catch(() => undefined)
        if (stopped) return
        if (launch?.url) callback(launch.url)
        const handle = await App.addListener('appUrlOpen', (event) => callback(event.url))
        if (stopped) void handle.remove()
        else remove = () => void handle.remove()
      }).catch(() => undefined)
      return () => {
        stopped = true
        remove?.()
      }
    },
    async saveFile(blob, name) {
      const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')])
      const { uri } = await Filesystem.writeFile({
        path: `downloads/${safeFileName(name)}`,
        data: await blobToBase64(blob),
        directory: Directory.Cache,
        recursive: true,
      })
      try {
        await Share.share({ files: [uri] })
        return true
      } catch {
        return false // cancelled
      }
    },
    async setStatusBar(scheme) {
      const { StatusBar, Style } = await import('@capacitor/status-bar')
      // Style.Dark is light text, for dark backgrounds.
      await StatusBar.setStyle({ style: scheme === 'light' ? Style.Light : Style.Dark })
    },
    push: {
      permission: async () => (await (await plugin()).pushPermission()).permission,
      register: async () => (await plugin()).pushRegister(),
      onTokenChange: (callback) => listen('pushToken', () => callback()),
      onOpen: (callback) =>
        listen<{ route?: unknown }>('pushOpened', (data) => {
          if (typeof data.route === 'string') callback(data.route)
        }),
      onCallAction: (callback) =>
        listen<Record<string, unknown>>('callAction', (data) => {
          const action = parseCallAction(data)
          if (action) callback(action)
        }),
    },
    voice: {
      start: async (options) => (await plugin()).voiceStart(options),
      update: async (options) => (await plugin()).voiceUpdate(options),
      stop: async () => (await plugin()).voiceStop(),
      onEnd: (callback) => listen('voiceEnded', () => callback()),
      onMute: (callback) =>
        listen<{ muted?: unknown }>('voiceMuted', (data) => {
          if (typeof data.muted === 'boolean') callback(data.muted)
        }),
    },
  }
}

const platform = nativePlatform()
export const native: NativeBridge | undefined = platform ? bridge(platform) : undefined
/** The iPhone/iPad app: no screen sharing, no "Add to Home Screen" hints, native push instead of web push. */
export const iosApp = platform === 'ios'

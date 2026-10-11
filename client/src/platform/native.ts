// What the phone app (mobile/, a Capacitor shell around this client) adds. Undefined in a browser and in the desktop app.
// The Capacitor packages are only imported inside the app, so the web build doesn't load them.

export type NativePlatform = 'ios' | 'android'

export interface NativeBridge {
  platform: NativePlatform
  /** Links that open the app (Universal Links on app.iskra.foo, iskra://), including the one that started it. */
  onOpenUrl(callback: (url: string) => void): () => void
  /** Hands a file to the share sheet (Save to Files, AirDrop, ...). False when the person cancels. */
  saveFile(blob: Blob, name: string): Promise<boolean>
  /** Status bar text that reads on the theme's background. */
  setStatusBar(scheme: 'dark' | 'light'): Promise<void>
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
  }
}

const platform = nativePlatform()
export const native: NativeBridge | undefined = platform ? bridge(platform) : undefined
/** The iPhone/iPad app: no screen sharing, no "Add to Home Screen" hints, no web push (yet). */
export const iosApp = platform === 'ios'

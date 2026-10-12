// Profile pages get their own wall here, so their scripts can run for everyone: each page is a <webview> in a
// session nothing else uses. In it, no request reaches the network except the page's own document (fetched for it
// by the app), WebRTC has no socket to use, and there's no Node, preload, permission, pop-up or navigation.
// The rules are in pageRules.ts; the probes that check them are in client/e2e/page-sandbox.spec.ts.
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import { PAGES_PARTITION, pageRequestAllowed, pageViewSource } from './pageRules'

/**
 * The page session's proxy, for everything Chromium would otherwise send straight to the network (preconnects,
 * WebSockets, WebRTC's TCP): a closed port on this device, loopback included, with no fallback to a direct connection.
 */
const NOWHERE = { mode: 'fixed_servers' as const, proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>' }

/** What each page view may load: its page URL, or its preview data: URL. */
const allowedBy = new Map<number, string>()
/** Handed from will-attach-webview to web-contents-created, which follow each other synchronously. */
let pending: string | null = null

let pages: Session | null = null

function pagesSession(): Session {
  if (pages) return pages
  const ses = session.fromPartition(PAGES_PARTITION) // in memory: nothing a page does is kept
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  ses.setSpellCheckerEnabled(false)
  ses.on('will-download', (event) => event.preventDefault())
  void ses.setProxy(NOWHERE)

  const allowed = (url: string, resourceType: string, method: string, contentsId?: number) => {
    const page = contentsId === undefined ? null : allowedBy.get(contentsId)
    return !!page && pageRequestAllowed(page, url, resourceType, method)
  }
  ses.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allowed(details.url, details.resourceType, details.method, details.webContentsId) }))

  // The page document (and its server's images) come through the app's own session; everything else gets a 404.
  const serve = async (request: Request): Promise<Response> => {
    const ok = request.method === 'GET' && [...allowedBy.values()].some((page) =>
      pageRequestAllowed(page, request.url, request.url === page ? 'mainFrame' : 'image', 'GET'))
    if (!ok) return new Response('', { status: 404 })
    const response = await session.defaultSession.fetch(request.url, { redirect: 'error', credentials: 'omit' })
    const headers = new Headers(response.headers)
    headers.delete('set-cookie')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  ses.protocol.handle('http', serve)
  ses.protocol.handle('https', serve)
  pages = ses
  return ses
}

/** Every guest the app page attaches gets the page session's rules before it loads anything. */
function lockGuest(contents: WebContents): void {
  const src = pending
  pending = null
  if (contents.session !== pagesSession() || !src) {
    contents.close() // never attached through the checks below: not a page view
    return
  }
  const id = contents.id
  allowedBy.set(id, src)
  contents.once('destroyed', () => allowedBy.delete(id))
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-redirect', (event) => event.preventDefault())
  contents.on('will-frame-navigate', (event) => {
    if (!/^about:(blank|srcdoc)$/.test(event.url)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

/** Lets the app window show page views, on the app page only and only with the settings here. */
export function allowPageViews(window: BrowserWindow, isAppUrl: (url: string) => boolean): void {
  pagesSession()
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const source = isAppUrl(window.webContents.getURL()) ? pageViewSource(params.src) : null
    if (!source) return event.preventDefault()
    delete webPreferences.preload
    delete webPreferences.enableBlinkFeatures
    Object.assign(webPreferences, {
      partition: PAGES_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, plugins: false,
      experimentalFeatures: false, spellcheck: false, navigateOnDragDrop: false, disableDialogs: true, devTools: !app.isPackaged,
    } satisfies Electron.WebPreferences)
    for (const key of ['allowpopups', 'nodeintegration', 'nodeintegrationinsubframes', 'plugins', 'preload', 'disablewebsecurity', 'webpreferences', 'blinkfeatures', 'disableblinkfeatures', 'useragent', 'httpreferrer']) delete params[key]
    params.partition = PAGES_PARTITION
    params.src = source.url
    pending = source.url
  })
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') lockGuest(contents)
})

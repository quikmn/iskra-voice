// The app's origin and how its session loads things: the built web app on app://iskra/, and the fixes that let
// YouTube and Twitch embeds play inside it. Shared by main.ts and the Electron check (embeds.check.ts).
import { net, protocol, type Session } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { appResponseHeaders, embedderHeaders, pageOrigin, TWITCH_EMBED_URLS, youTubeReferrer } from './platform'

export const APP_ORIGIN = 'app://iskra'

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

export function configureAppSession(appSession: Session, clientDir: string, isAppUrl: (url: string) => boolean): void {
  // Serve the built web app from app://iskra/ (a secure, stable origin for IndexedDB and getUserMedia).
  appSession.protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url)
    const relative = decodeURIComponent(pathname) === '/' ? '/index.html' : decodeURIComponent(pathname)
    const file = path.normalize(path.join(clientDir, relative))
    if (!file.startsWith(clientDir + path.sep)) return new Response('Not found', { status: 404 })
    const response = await net.fetch(pathToFileURL(file).toString())
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: appResponseHeaders(response.headers) })
  })

  // YouTube's embeds (watch parties) refuse to play without an http(s) referrer ("Error 153"), and app:// isn't one.
  // Requests to youtube-nocookie.com from the app's own window say they come from the web app instead.
  appSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/*'] }, (details, callback) => {
    const referrer = youTubeReferrer(details.url, !!details.webContents && isAppUrl(details.webContents.getURL()))
    callback({ requestHeaders: referrer ? { ...details.requestHeaders, Referer: referrer } : details.requestHeaders })
  })

  // Twitch's player only lets https://<parent> frame it (CSP frame-ancestors), which app://iskra can never be.
  // For a player framed directly by the app's own page, the app's origin is allowed instead.
  appSession.webRequest.onHeadersReceived({ urls: TWITCH_EMBED_URLS }, (details, callback) => {
    const page = details.frame?.parent?.url ?? details.webContents?.getURL() ?? ''
    const embedder = details.resourceType === 'subFrame' && isAppUrl(page) ? pageOrigin(page) : null
    callback({ responseHeaders: embedder ? embedderHeaders(details.responseHeaders ?? {}, embedder) : details.responseHeaders })
  })
}

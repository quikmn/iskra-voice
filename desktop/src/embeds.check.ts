// Electron check for embeds (npm run test:electron; CI runs it on Windows, macOS and Linux).
// Loads the client's own embed code on app://iskra under the app's CSP, with the app's session setup, and never
// touches the internet (every host name fails to resolve; the second part answers as a stand-in YouTube player):
//  1. The watch party's YouTube frame and a chat Twitch embed are allowed by the CSP and requested, YouTube's with the
//     web app as referrer (Error 153 otherwise).
//  2. The sandboxed YouTube frame and the app talk over postMessage (YouTubeBridge), and the frame may autoplay.
import { app, BrowserWindow, session, type Session } from 'electron'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from '@typescript/typescript6'
import { APP_ORIGIN, configureAppSession, registerAppScheme } from './appSession'
import { isAppPage, YOUTUBE_REFERRER } from './platform'

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src')
const VIDEO = 'aqz-KE-bpKQ'
const TWITCH = 'https://www.twitch.tv/iskracheck'
const TIMEOUT = 30_000

registerAppScheme()
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND')

/** The client's TypeScript modules as browser JavaScript (they have no imports of their own). */
function clientModule(file: string): string {
  const source = readFileSync(path.join(CLIENT_SRC, file), 'utf8')
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
}

/** The CSP string from client/src/csp.ts, evaluated. */
function appCsp(): string {
  const js = ts.transpileModule(readFileSync(path.join(CLIENT_SRC, 'csp.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { CSP?: string } }
  new Function('module', 'exports', js)(module, module.exports)
  if (typeof module.exports.CSP !== 'string') throw new Error('client/src/csp.ts has no CSP')
  return module.exports.CSP
}

// The page: makes frames the way WatchParty.tsx and MessageExtras.tsx do, and reports CSP violations.
const PAGE_SCRIPT = `
import { YOUTUBE_FRAME, YouTubeBridge, youTubeEmbedUrl } from './players.js'
import { EMBED_FRAME, embedFor } from './embeds.js'
const violations = []
addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective + ' ' + e.blockedURI))
function frame(src, attrs) {
  const f = document.createElement('iframe')
  f.src = src
  f.allow = attrs.allow
  f.referrerPolicy = attrs.referrerPolicy
  f.setAttribute('sandbox', attrs.sandbox)
  document.body.append(f)
  return f
}
window.check = {
  violations: () => violations,
  page: () => ({ origin: location.origin, secure: isSecureContext }),
  youTube: () => frame(youTubeEmbedUrl(${JSON.stringify(VIDEO)}, location.origin), YOUTUBE_FRAME).src,
  twitch: () => {
    const embed = embedFor(${JSON.stringify(TWITCH)}, location.hostname)
    return frame(embed.src, EMBED_FRAME).src
  },
  // Drives a YouTube frame like the watch party: listen until ready, then play. The stand-in also reports whether
  // it may play sound without a click (it never waits for sound to come out: CI machines have no audio output).
  bridge: () => new Promise((resolve) => {
    const f = frame(youTubeEmbedUrl(${JSON.stringify(VIDEO)}, location.origin), YOUTUBE_FRAME)
    const bridge = new YouTubeBridge(f)
    const seen = []
    let loads = 0
    let autoplay = null
    let played = false
    let playing = false
    let done = false
    f.addEventListener('load', () => loads++)
    const report = (ok, why) => {
      if (done) return
      done = true
      clearInterval(timer)
      resolve({ ok, why, ready: bridge.info.ready, state: bridge.info.state, time: bridge.info.time, duration: bridge.info.duration, autoplay,
        frame: { src: f.src, loads, hasWindow: !!f.contentWindow }, messages: seen.slice(-12) })
    }
    addEventListener('message', (e) => {
      seen.push({ origin: e.origin, fromFrame: e.source === f.contentWindow, data: typeof e.data === 'string' ? e.data.slice(0, 160) : e.data })
      if (e.origin === 'https://www.youtube-nocookie.com' && e.source === f.contentWindow && typeof e.data === 'object' && e.data?.check) autoplay = e.data.autoplay
      else if (!bridge.receive(e)) return
      if (bridge.info.ready && !played) {
        played = true
        bridge.adapter().play()
      }
      // The player said it's playing from 1 s on: remembered, as the autoplay report may come later.
      if (bridge.info.state === 1 && bridge.info.time >= 1) playing = true
      if (playing && autoplay) report(true, 'played')
    })
    const timer = setInterval(() => bridge.listen(), 200)
    setTimeout(() => report(false, !bridge.info.ready ? 'the player never got ready' : !playing ? 'the player never reported playing' : 'no autoplay report'), ${TIMEOUT - 5000})
  }),
}
`

// A stand-in for YouTube's embed: answers the IFrame API's postMessage protocol like the real player does.
const FAKE_PLAYER = `<!doctype html><title>player</title><script>
const send = (data) => parent.postMessage(JSON.stringify(data), '*')
let playing = false
let probed = false
// May this frame start unmuted sound without a click? Chromium decides inside play() itself: when the autoplay policy
// says no, play() rejects at once with NotAllowedError and the element stays paused; when it says yes, the element
// stops being paused right away. Whether sound then actually starts needs an audio output (Linux CI runners have
// none, and play() may then never settle), so that part is reported but not waited for.
function autoplay() {
  const rate = 8000
  const wav = new DataView(new ArrayBuffer(44 + rate))
  const text = (at, s) => [...s].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)))
  text(0, 'RIFF'); wav.setUint32(4, 36 + rate, true); text(8, 'WAVEfmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true)
  wav.setUint16(22, 1, true); wav.setUint32(24, rate, true); wav.setUint32(28, rate, true); wav.setUint16(32, 1, true); wav.setUint16(34, 8, true)
  text(36, 'data'); wav.setUint32(40, rate, true)
  for (let i = 44; i < 44 + rate; i++) wav.setUint8(i, 128)
  const audio = new Audio(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })))
  const started = audio.play().then(() => ({ policy: 'allowed', playback: 'started' }), (e) => ({ policy: e.name === 'NotAllowedError' ? 'blocked' : 'allowed', playback: e.name }))
  const pausedAfterPlay = audio.paused
  const pending = new Promise((r) => setTimeout(() => r({ policy: pausedAfterPlay ? 'unknown' : 'allowed', playback: 'pending' }), 2000))
  return Promise.race([started, pending]).then((result) => ({ ...result, pausedAfterPlay }))
}
addEventListener('message', (e) => {
  let data
  try { data = JSON.parse(e.data) } catch { return }
  if (data.event === 'listening') {
    send({ event: 'onReady', id: data.id, channel: data.channel })
    send({ event: 'infoDelivery', info: { currentTime: playing ? 1 : 0, duration: 596, playerState: playing ? 1 : 5, playbackRate: 1 } })
    if (!probed) {
      probed = true
      autoplay().then((result) => parent.postMessage({ check: true, autoplay: result }, '*'))
    }
  }
  if (data.event === 'command' && data.func === 'playVideo') {
    playing = true
    send({ event: 'infoDelivery', info: { currentTime: 1, playerState: 1 } })
  }
})
</script>`

const failures: string[] = []
function expect(ok: boolean, what: string, detail?: unknown): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}${ok || detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
  if (!ok) failures.push(what)
}

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), TIMEOUT))])
}

/** The first request headers sent to each host (after the app's own rewriting). One listener per session, as Electron allows. */
function sentHeaders(ses: Session, hosts: string[]): Record<string, Promise<Record<string, string>>> {
  const waiting = new Map<string, (headers: Record<string, string>) => void>()
  const sent = Object.fromEntries(hosts.map((host) => [host, new Promise<Record<string, string>>((resolve) => waiting.set(host, resolve))]))
  ses.webRequest.onSendHeaders({ urls: hosts.map((host) => `https://${host}/*`) }, (d) => {
    const host = new URL(d.url).hostname
    waiting.get(host)?.(d.requestHeaders)
    waiting.delete(host)
  })
  return sent
}

function appWindow(ses: Session): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  })
}

async function openApp(win: BrowserWindow): Promise<void> {
  await within(win.loadURL(`${APP_ORIGIN}/index.html`), 'loading the app page')
  await within(win.webContents.executeJavaScript('new Promise((r) => (function wait() { window.check ? r() : setTimeout(wait, 50) })())'), 'the page script')
}

async function run(clientDir: string): Promise<void> {
  const isAppUrl = (url: string) => isAppPage(url, APP_ORIGIN)

  // 1. The real network stack (no host resolves): what the app requests, and with which headers.
  const ses = session.defaultSession
  configureAppSession(ses, clientDir, isAppUrl)
  const sent = sentHeaders(ses, ['www.youtube-nocookie.com', 'player.twitch.tv'])
  const win = appWindow(ses)
  await openApp(win)
  const page = await win.webContents.executeJavaScript('check.page()')
  expect(page.origin === APP_ORIGIN && page.secure === true, 'the app page is app://iskra and a secure context', page)

  const youTubeSrc: string = await win.webContents.executeJavaScript('check.youTube()')
  expect(youTubeSrc.startsWith(`https://www.youtube-nocookie.com/embed/${VIDEO}?`) && youTubeSrc.includes('enablejsapi=1') && !youTubeSrc.includes('origin='),
    'the watch party frame points at youtube-nocookie.com with the IFrame API on', youTubeSrc)
  const youTubeHeaders = await within(sent['www.youtube-nocookie.com'], 'the YouTube frame request')
  expect(youTubeHeaders.Referer === YOUTUBE_REFERRER, 'YouTube is asked with the web app as referrer', youTubeHeaders.Referer)

  const twitchSrc: string = await win.webContents.executeJavaScript('check.twitch()')
  expect(/^https:\/\/player\.twitch\.tv\/\?channel=iskracheck&parent=iskra&autoplay=true$/.test(twitchSrc), 'the Twitch embed names the app as parent', twitchSrc)
  await within(sent['player.twitch.tv'], 'the Twitch frame request')
  expect(true, 'the Twitch frame is requested')

  const violations: string[] = await win.webContents.executeJavaScript('check.violations()')
  expect(violations.length === 0, "the app's CSP allows both frames", violations)

  // 2. A stand-in YouTube player on https://www.youtube-nocookie.com: the postMessage bridge and autoplay.
  const fake = session.fromPartition('embeds-check-player')
  configureAppSession(fake, clientDir, isAppUrl)
  const win2 = appWindow(fake)
  await openApp(win2)
  const served: string[] = []
  fake.protocol.handle('https', (request) => {
    const url = new URL(request.url)
    served.push(request.url)
    if (url.hostname === 'www.youtube-nocookie.com' && url.pathname === `/embed/${VIDEO}`) {
      return new Response(FAKE_PLAYER, { headers: { 'content-type': 'text/html' } })
    }
    return new Response('Not found', { status: 404 })
  })
  try {
    const bridge = await within(win2.webContents.executeJavaScript('check.bridge()'), 'the YouTube bridge')
    // On failure, everything needed to tell why: what the stand-in served, the frame's URL and loads, the last messages.
    const diagnostics = { ...bridge, served, frameUrl: win2.webContents.mainFrame.frames[0]?.url ?? null }
    expect(bridge.ok && bridge.ready && bridge.state === 1 && bridge.duration === 596, 'the watch party drives the sandboxed YouTube frame over postMessage', diagnostics)
    expect(bridge.autoplay?.policy === 'allowed', 'the YouTube frame may start playing without a click', diagnostics)
    if (bridge.autoplay?.playback === 'pending') console.log('   (no sound started within 2 s: this machine likely has no audio output)')
  } catch (error) {
    expect(false, 'the watch party drives the sandboxed YouTube frame over postMessage', String(error))
  }
  win.destroy()
  win2.destroy()
}

app.whenReady().then(async () => {
  const clientDir = mkdtempSync(path.join(os.tmpdir(), 'iskra-embeds-'))
  try {
    writeFileSync(path.join(clientDir, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${appCsp()}"><meta name="referrer" content="no-referrer"></head>` +
      '<body><script type="module" src="/check.js"></script></body></html>')
    writeFileSync(path.join(clientDir, 'players.js'), clientModule('ui/watch/players.ts'))
    writeFileSync(path.join(clientDir, 'embeds.js'), clientModule('ui/chat/embeds.ts'))
    writeFileSync(path.join(clientDir, 'check.js'), PAGE_SCRIPT)
    await run(clientDir)
  } catch (error) {
    expect(false, 'the check ran', String((error as Error).stack ?? error))
  } finally {
    rmSync(clientDir, { recursive: true, force: true })
  }
  console.log(failures.length ? `${failures.length} failed (${process.platform})` : `all embed checks passed (${process.platform})`)
  app.exit(failures.length ? 1 : 0)
})

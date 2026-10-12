// A fake "attacker" on 127.0.0.1 and a profile page that tries every way we know to make the viewer's device
// contact it. Each vector gets its own port, so a hit says exactly which one leaked. Localhost only.
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { createServer, type Server } from 'node:net'

export interface Attacker {
  /** The vectors that reached the attacker, sorted, each once. */
  hits: () => string[]
  close: () => Promise<void>
  tcp: Record<string, number>
  udp: Record<string, number>
}

/** Vectors in plain HTML and CSS: they work without scripts. */
export const STATIC_VECTORS = [
  'img', 'srcset', 'picture', 'input-image', 'poster', 'video', 'audio', 'video-source', 'track', 'object', 'embed', 'iframe',
  'srcdoc-refresh', 'srcdoc-img', 'srcdoc-report', 'stylesheet', 'preconnect', 'dns-prefetch', 'prefetch', 'preload', 'modulepreload',
  'prerender', 'icon', 'manifest', 'dictionary', 'css-import', 'css-background', 'css-font', 'css-cursor', 'css-image-set', 'css-mask',
  'css-filter', 'svg-image', 'svg-use', 'svg-feimage', 'meta-refresh', 'attributionsrc', 'script-src', 'speculation', 'webview', 'portal',
] as const

/** Vectors that need the page's scripts. The rtc-* ones are WebRTC: a STUN (UDP) and a TURN over TCP server each. */
export const SCRIPT_VECTORS = [
  'fetch', 'xhr', 'beacon', 'websocket', 'eventsource', 'image-js', 'import', 'worker', 'blob-worker', 'shared-worker', 'service-worker',
  'paint-worklet', 'audio-worklet', 'window-open', 'top-location', 'form-submit', 'anchor-click', 'ping', 'link-js', 'fedcm', 'payment',
  'style-js', 'rtc', 'rtc-frame0', 'rtc-srcdoc', 'rtc-innerhtml', 'rtc-clone', 'webtransport', 'location',
] as const

const RTC = ['rtc', 'rtc-frame0', 'rtc-srcdoc', 'rtc-innerhtml', 'rtc-clone'] as const

export async function startAttacker(): Promise<Attacker> {
  const hits = new Set<string>()
  const servers: Server[] = []
  const sockets: UdpSocket[] = []
  const tcp: Record<string, number> = {}
  const udp: Record<string, number> = {}
  const listen = (name: string) =>
    new Promise<void>((done) => {
      const server = createServer((socket) => {
        hits.add(name)
        socket.on('error', () => undefined)
        socket.destroy()
      })
      servers.push(server)
      server.listen(0, '127.0.0.1', () => {
        tcp[name] = (server.address() as { port: number }).port
        done()
      })
    })
  const bind = (name: string) =>
    new Promise<void>((done) => {
      const socket = createSocket('udp4')
      socket.on('message', () => hits.add(name))
      sockets.push(socket)
      socket.bind(0, '127.0.0.1', () => {
        udp[name] = socket.address().port
        done()
      })
    })
  for (const name of [...STATIC_VECTORS, ...SCRIPT_VECTORS, 'ping-target', 'control']) await listen(name)
  for (const name of [...RTC.map((r) => `${r}-stun`), 'webtransport-udp', 'control-stun']) await bind(name)
  return {
    hits: () => [...hits].sort(),
    tcp,
    udp,
    close: async () => {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
      for (const s of sockets) s.close()
    },
  }
}

const attr = (html: string) => html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/** A WebRTC attempt in window `W`: STUN over UDP and TURN over TCP, both at the attacker. */
const rtcCall = (target: string, stun: number, turn: number) =>
  `try{const pc=new ${target}.RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${stun}'},{urls:'turn:127.0.0.1:${turn}?transport=tcp',username:'u',credential:'p'}]});` +
  `pc.createDataChannel('x');pc.createOffer().then(o=>pc.setLocalDescription(o)).catch(()=>{});note('${target}: rtc made')}catch(e){note('${target}: '+e)}`

/** The probe page. With `scripts`, it also runs every script vector (the static ones are there either way). */
export function probePage(a: Attacker, scripts = true): string {
  const h = (name: string) => `http://127.0.0.1:${a.tcp[name]}`
  const statics = `
<img src="${h('img')}/x.png" alt="">
<img srcset="${h('srcset')}/x.png 1x" alt="">
<picture><source srcset="${h('picture')}/x.png"><img alt=""></picture>
<input type="image" src="${h('input-image')}/x.png" alt="">
<video poster="${h('poster')}/x.png" width="10" height="10"></video>
<video src="${h('video')}/v.mp4" autoplay muted width="10" height="10"></video>
<audio src="${h('audio')}/a.mp3" autoplay></audio>
<video autoplay muted width="10" height="10"><source src="${h('video-source')}/v.mp4"></video>
<video width="10" height="10"><track default kind="captions" src="${h('track')}/t.vtt"></video>
<object data="${h('object')}/o" width="10" height="10"></object>
<embed src="${h('embed')}/e" width="10" height="10">
<iframe src="${h('iframe')}/f" width="10" height="10"></iframe>
<iframe srcdoc="${attr(`<meta http-equiv="refresh" content="0;url=${h('srcdoc-refresh')}/">`)}" width="10" height="10"></iframe>
<iframe srcdoc="${attr(`<img src="${h('srcdoc-img')}/x.png">`)}" width="10" height="10"></iframe>
<iframe srcdoc="${attr(`<meta http-equiv="Content-Security-Policy" content="img-src 'none'; report-uri ${h('srcdoc-report')}/r"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`)}" width="10" height="10"></iframe>
<link rel="stylesheet" href="${h('stylesheet')}/s.css">
<link rel="preconnect" href="${h('preconnect')}">
<link rel="dns-prefetch" href="${h('dns-prefetch')}">
<link rel="prefetch" href="${h('prefetch')}/p">
<link rel="preload" as="image" href="${h('preload')}/p.png">
<link rel="modulepreload" href="${h('modulepreload')}/m.js">
<link rel="prerender" href="${h('prerender')}/">
<link rel="icon" href="${h('icon')}/i.ico">
<link rel="manifest" href="${h('manifest')}/m.json">
<link rel="compression-dictionary" href="${h('dictionary')}/d">
<style>
  @import url("${h('css-import')}/i.css");
  @font-face { font-family: Probe; src: url("${h('css-font')}/f.woff"); }
  .font { font-family: Probe; }
</style>
<div style="width:10px;height:10px;background:url('${h('css-background')}/b.png')"></div>
<span class="font">font</span>
<div style="width:10px;height:10px;cursor:url('${h('css-cursor')}/c.png'),auto"></div>
<div style="width:10px;height:10px;background-image:image-set(url('${h('css-image-set')}/x.png') 1x)"></div>
<div style="width:10px;height:10px;mask-image:url('${h('css-mask')}/m.png');-webkit-mask-image:url('${h('css-mask')}/m.png')"></div>
<div style="width:10px;height:10px;filter:url('${h('css-filter')}/f.svg#x')"></div>
<svg width="10" height="10"><image href="${h('svg-image')}/x.png" width="10" height="10"></image></svg>
<svg width="10" height="10"><use href="${h('svg-use')}/u.svg#a"></use></svg>
<svg width="10" height="10"><filter id="fi"><feImage href="${h('svg-feimage')}/x.png"/></filter><rect filter="url(#fi)" width="10" height="10"/></svg>
<meta http-equiv="refresh" content="3;url=${h('meta-refresh')}/">
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" attributionsrc="${h('attributionsrc')}/a" alt="">
<script src="${h('script-src')}/s.js"></script>
<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${h('speculation')}/sp"]}],"prerender":[{"source":"list","urls":["${h('speculation')}/pr"]}]}</script>
<webview src="${h('webview')}/w"></webview>
<portal src="${h('portal')}/p"></portal>
<iframe id="blank" width="10" height="10"></iframe>
<iframe id="rtcsrcdoc" width="10" height="10" srcdoc="${attr(`<script>const note=()=>{};${rtcCall('window', a.udp['rtc-srcdoc-stun'], a.tcp['rtc-srcdoc'])}</script>`)}"></iframe>
<a id="anchor" href="${h('anchor-click')}/a">a</a>
<a id="ping" href="${h('ping-target')}/a" ping="${h('ping')}/p">p</a>
`
  const script = `
<script>
  const log = document.getElementById('log'), note = (t) => { log.textContent += t + '\\n' }
  const tryIt = (name, f) => { try { const r = f(); if (r && r.catch) r.catch((e) => note(name + ': ' + e)) } catch (e) { note(name + ': ' + e) } }
  tryIt('fetch', () => fetch('${h('fetch')}/f', { mode: 'no-cors' }))
  tryIt('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', '${h('xhr')}/x'); x.send() })
  tryIt('beacon', () => navigator.sendBeacon('${h('beacon')}/b', 'x'))
  tryIt('websocket', () => new WebSocket('ws://127.0.0.1:${a.tcp.websocket}/'))
  tryIt('eventsource', () => new EventSource('${h('eventsource')}/e'))
  tryIt('webtransport', () => new WebTransport('https://127.0.0.1:${a.udp['webtransport-udp']}/'))
  tryIt('image-js', () => { new Image().src = '${h('image-js')}/x.png' })
  tryIt('import', () => import('${h('import')}/m.js'))
  tryIt('worker', () => new Worker('${h('worker')}/w.js'))
  tryIt('blob-worker', () => new Worker(URL.createObjectURL(new Blob(["fetch('${h('blob-worker')}/x')"], { type: 'text/javascript' }))))
  tryIt('shared-worker', () => new SharedWorker('${h('shared-worker')}/w.js'))
  tryIt('service-worker', () => navigator.serviceWorker.register('${h('service-worker')}/sw.js'))
  tryIt('paint-worklet', () => CSS.paintWorklet.addModule('${h('paint-worklet')}/p.js'))
  tryIt('audio-worklet', () => new AudioContext().audioWorklet.addModule('${h('audio-worklet')}/a.js'))
  tryIt('window-open', () => window.open('${h('window-open')}/o'))
  tryIt('top-location', () => { top.location = '${h('top-location')}/t' })
  tryIt('form-submit', () => { const f = document.createElement('form'); f.action = '${h('form-submit')}/f'; f.method = 'post'; document.body.append(f); f.submit() })
  tryIt('link-js', () => { const l = document.createElement('link'); l.rel = 'preconnect'; l.href = '${h('link-js')}'; document.head.append(l) })
  tryIt('style-js', () => { document.body.style.background = "url('${h('style-js')}/x.png')" })
  tryIt('fedcm', () => navigator.credentials.get({ identity: { providers: [{ configURL: '${h('fedcm')}/c.json', clientId: 'x' }] } }))
  tryIt('payment', () => new PaymentRequest([{ supportedMethods: '${h('payment').replace('http:', 'https:')}/pay' }], { total: { label: 'x', amount: { currency: 'USD', value: '1' } } }).canMakePayment())
  ${rtcCall('window', a.udp['rtc-stun'], a.tcp.rtc)}
  // window[i] can't be patched away: find a child frame whose realm we can reach.
  const reachable = () => { const out = []; for (let i = 0; i < 60; i++) { try { const w = window[i]; if (w && w.RTCPeerConnection) out.push(w) } catch {} } return out }
  tryIt('rtc-frame0', () => { const w = reachable()[0]; ${rtcCall('w', a.udp['rtc-frame0-stun'], a.tcp['rtc-frame0'])} })
  tryIt('rtc-innerhtml', () => { const before = reachable(); const d = document.createElement('div'); d.innerHTML = '<iframe></iframe>'; document.body.append(d); const w = reachable().find((x) => !before.includes(x)); ${rtcCall('w', a.udp['rtc-innerhtml-stun'], a.tcp['rtc-innerhtml'])} })
  tryIt('rtc-clone', () => { const before = reachable(); const f = document.getElementById('blank').cloneNode(); f.id = 'clone'; document.body.append(f); const w = reachable().find((x) => !before.includes(x)); ${rtcCall('w', a.udp['rtc-clone-stun'], a.tcp['rtc-clone'])} })
  // Navigations last: a blocked one leaves an error page behind, which ends the probe.
  setTimeout(() => tryIt('ping', () => document.getElementById('ping').click()), 4000)
  setTimeout(() => tryIt('anchor-click', () => document.getElementById('anchor').click()), 4500)
  setTimeout(() => { location.href = '${h('location')}/l' }, 5000)
</script>`
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Probe</h1><pre id="log"></pre>${statics}${scripts ? script : ''}</body></html>`
}

/** Positive control from a page with no wall: proves the listeners and the WebRTC probe can see a leak. */
export const controlScript = (a: Attacker) =>
  `(() => { fetch('http://127.0.0.1:${a.tcp.control}/c', { mode: 'no-cors' }).catch(() => {});` +
  ` const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${a.udp['control-stun']}' }] });` +
  ` pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o)); return 'ok' })()`

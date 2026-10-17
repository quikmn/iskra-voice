// Where an activity runs, and the bridge to it (docs/activities.md). Built-ins: the app's own page in
// <iframe sandbox="allow-scripts"> (an opaque origin with its own no-network policy). Server-added ones: only in the
// desktop app, as a <webview> in its walled page session (desktop/src/pages.ts), which has no parent to postMessage
// to, so the SDK writes console lines there and the app posts messages in with executeJavaScript.
// Everything an activity asks is checked (state/activityHost.ts) before it reaches the server.
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActivityJoin, ActivityMessage, ActivitySession, Channel } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { endActivity, leaveActivity, mayEnd, onActivityMessage, sendToActivity, snapshotActivity } from '../../state/activities'
import {
  endedMessage, frameTheme, initMessage, isBuiltin, messageMessage, nextMessages, parseFrameRequest, parseWallLine, playersMessage,
  TokenBucket, wallScript, type FramePlayer, type FrameRequest,
} from '../../state/activityHost'
import { i18next, t as i18t } from '../../i18n'

/** Snapshots go out at most this often (the latest one wins). */
const SNAPSHOT_MS = 1500

/** Where a built-in activity is: a page of the app itself (activities.vite.ts). */
const builtinUrl = (id: string) => `${import.meta.env.BASE_URL}activities/${id}.html`

interface WebviewElement extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>
}

function framePlayers(server: ServerState, session: ActivitySession): FramePlayer[] {
  return session.players.map((p) => ({ id: p.id, name: server.members[p.accountKey]?.name ?? i18t('common.someone') }))
}

export function ActivityFrame({ server, channel, session, joined, name }: {
  server: ServerState; channel: Channel; session: ActivitySession; joined: ActivityJoin; name: string
}) {
  const { t } = useTranslation()
  const walled = !isBuiltin(session.activity)
  const src = walled ? `${server.url}/activities/${session.activity}/index.html` : builtinUrl(session.activity)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const viewRef = useRef<WebviewElement>(null)
  const bridge = useRef<{ ready: boolean; post: (message: object) => void } | null>(null)
  // Latest values for the long-lived bridge below.
  const latest = useRef({ server, session })
  latest.current = { server, session }

  useEffect(() => {
    const serverKey = server.key
    const channelId = channel.id
    let ready = false
    let delivered = joined.stateSeq
    let waiting: ActivityMessage[] = [...joined.messages]
    const sends = new TokenBucket(40, 20)
    let snapshot: { seq: number; state: unknown } | null = null
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null
    let lastSnapshot = 0

    const post = (message: object) => {
      if (walled) void viewRef.current?.executeJavaScript(wallScript(message)).catch(() => undefined)
      else frameRef.current?.contentWindow?.postMessage(message, '*')
    }
    bridge.current = { get ready() { return ready }, post }

    const flush = () => {
      if (!ready) return
      for (const m of nextMessages(delivered, waiting)) {
        post(messageMessage(m))
        delivered = m.seq
      }
      waiting = []
    }

    const sendSnapshot = () => {
      snapshotTimer = null
      if (!snapshot) return
      const { seq, state } = snapshot
      snapshot = null
      lastSnapshot = Date.now()
      void snapshotActivity(serverKey, channelId, session.id, seq, state).catch(() => undefined)
    }

    const handle = (request: FrameRequest) => {
      const { server: now, session: current } = latest.current
      switch (request.type) {
        case 'ready': {
          if (ready) return
          const root = getComputedStyle(document.documentElement)
          const scheme = document.documentElement.dataset.scheme === 'light' ? 'light' : 'dark'
          const players = framePlayers(now, current)
          const me = players.find((p) => p.id === joined.me) ?? { id: joined.me, name: now.me?.name ?? i18t('common.someone') }
          post(initMessage({
            me, players, state: joined.state, stateSeq: joined.stateSeq, locale: i18next.language,
            theme: frameTheme((v) => root.getPropertyValue(v), scheme), activity: { id: current.activity, name },
          }))
          ready = true
          flush()
          return
        }
        case 'send':
          if (sends.take()) void sendToActivity(serverKey, channelId, current.id, request.data).catch(() => undefined)
          return
        case 'state':
          snapshot = { seq: request.seq, state: request.state }
          if (!snapshotTimer) snapshotTimer = setTimeout(sendSnapshot, Math.max(0, SNAPSHOT_MS - (Date.now() - lastSnapshot)))
          return
        case 'end': {
          const inCall = (now.voice[channelId] ?? []).map((p) => p.accountKey)
          if (mayEnd(now, current, inCall)) void endActivity(serverKey, channelId, current.id).catch(() => undefined)
          else void leaveActivity(serverKey, channelId, current.id)
        }
      }
    }

    const stopMessages = onActivityMessage(serverKey, channelId, (m) => {
      waiting.push(m)
      flush()
    })

    // Browsers: only messages from this frame's own window count.
    const onMessage = (event: MessageEvent) => {
      if (walled || !frameRef.current || event.source !== frameRef.current.contentWindow) return
      const request = parseFrameRequest(event.data)
      if (request) handle(request)
    }
    window.addEventListener('message', onMessage)

    // The desktop app's walled view: its console lines.
    const view = viewRef.current
    const onConsole = (event: Event) => {
      const request = parseWallLine((event as Event & { message?: unknown }).message)
      if (request) handle(request)
    }
    view?.addEventListener('console-message', onConsole)

    return () => {
      stopMessages()
      window.removeEventListener('message', onMessage)
      view?.removeEventListener('console-message', onConsole)
      if (snapshotTimer) clearTimeout(snapshotTimer)
      if (ready) post(endedMessage())
      bridge.current = null
    }
    // One bridge per session (the frame is keyed by it too).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  // Who's playing, whenever that changes.
  const playerKey = session.players.map((p) => `${p.id}:${server.members[p.accountKey]?.name ?? ''}`).join('|')
  useEffect(() => {
    if (bridge.current?.ready) bridge.current.post(playersMessage(framePlayers(server, session)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerKey])

  const title = t('activities.frameTitle', { name })
  if (walled) return (
    <div className="activity-stage">
      <webview ref={viewRef as never} className="activity-frame" src={src} partition="iskra-pages" title={title} />
      <p className="muted small-text activity-wall">{t('activities.wallNote')}</p>
    </div>
  )
  return (
    <div className="activity-stage">
      <iframe ref={frameRef} className="activity-frame" sandbox="allow-scripts" src={src} title={title} referrerPolicy="no-referrer" data-testid="activity-frame" />
    </div>
  )
}

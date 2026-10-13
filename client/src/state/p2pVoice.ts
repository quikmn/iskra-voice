// Voice through the peer-to-peer tunnel: LiveKit's media goes relay-only through LiveKit's own TURN server on the
// host, which the friend's app reaches at turn:127.0.0.1:<tunnel port>. The server's join answer carries the TURN
// credentials; only its address is rewritten, and every other ICE server is dropped (no STUN of anyone's).
import type { Room } from 'livekit-client'
import { t } from '../i18n'

/** What a tunnelled room's RTCConfiguration becomes: LiveKit's TURN credentials, our local address, relay only. */
export function tunnelRtcConfig(config: RTCConfiguration, turnPort: number): RTCConfiguration {
  const turn = (config.iceServers ?? []).filter((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith('turn:')))
  return {
    ...config,
    iceServers: turn.map((s) => ({ urls: [`turn:127.0.0.1:${turnPort}?transport=udp`], ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) })),
    iceTransportPolicy: 'relay',
  }
}

interface Engine {
  makeRTCConfiguration?: (response?: unknown) => RTCConfiguration
}

/**
 * Makes every peer connection of `room` use the tunnel: livekit-client builds the RTCConfiguration from the join
 * answer in its engine (and again on reconnects); this wraps that step. Must run before `room.connect`.
 */
export function routeVoiceThroughTunnel(room: Room, turnPort: number): void {
  const engine = (room as unknown as { engine?: Engine }).engine
  if (!engine || typeof engine.makeRTCConfiguration !== 'function') throw new Error(t('voice.errors.tunnel'))
  const original = engine.makeRTCConfiguration.bind(engine)
  engine.makeRTCConfiguration = (response?: unknown) => tunnelRtcConfig(original(response), turnPort)
}

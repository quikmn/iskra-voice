import { describe, expect, it } from 'vitest'
import livekitSource from '../../node_modules/livekit-client/dist/livekit-client.esm.mjs?raw'
import { routeVoiceThroughTunnel, tunnelRtcConfig } from './p2pVoice'

describe('voice through the tunnel', () => {
  it("keeps LiveKit's TURN credentials, points them at the tunnel and drops everything else", () => {
    const config = tunnelRtcConfig({
      iceServers: [
        { urls: ['turn:192.168.1.20:7883?transport=udp', 'turns:turn.iskra.invalid:443?transport=tcp'], username: 'u1', credential: 'p1' },
        { urls: 'stun:stun.l.google.com:19302' },
      ],
      continualGatheringPolicy: 'gather_continually',
    } as RTCConfiguration, 51235)
    expect(config.iceServers).toEqual([{ urls: ['turn:127.0.0.1:51235?transport=udp'], username: 'u1', credential: 'p1' }])
    expect(config.iceTransportPolicy).toBe('relay')
    expect((config as { continualGatheringPolicy?: string }).continualGatheringPolicy).toBe('gather_continually')
    // No TURN offered: nothing to use, but still never anything else.
    expect(tunnelRtcConfig({ iceServers: [{ urls: 'stun:x' }] }, 1).iceServers).toEqual([])
    expect(tunnelRtcConfig({}, 1)).toEqual({ iceServers: [], iceTransportPolicy: 'relay' })
  })

  it("wraps the engine's configuration step, and refuses a LiveKit without it", () => {
    const calls: unknown[] = []
    const engine = {
      makeRTCConfiguration(response?: unknown) {
        calls.push(response)
        return { iceServers: [{ urls: 'turn:1.2.3.4:5?transport=udp', username: 'a', credential: 'b' }] } as RTCConfiguration
      },
    }
    const room = { engine } as unknown as import('livekit-client').Room
    routeVoiceThroughTunnel(room, 4000)
    const config = engine.makeRTCConfiguration({ iceServers: [] })
    expect(calls).toEqual([{ iceServers: [] }])
    expect(config.iceServers).toEqual([{ urls: ['turn:127.0.0.1:4000?transport=udp'], username: 'a', credential: 'b' }])
    expect(config.iceTransportPolicy).toBe('relay')
    expect(() => routeVoiceThroughTunnel({} as import('livekit-client').Room, 1)).toThrow()
  })

  it('livekit-client still builds the configuration in the engine method we wrap', () => {
    // A LiveKit upgrade that renames it must fail here, not silently send media nowhere.
    expect(livekitSource).toMatch(/\bmakeRTCConfiguration\(serverResponse\)\s*\{/)
    expect(livekitSource).toMatch(/this\.makeRTCConfiguration\(joinResponse\)/)
  })
})

// Chromium's WebRTC IP handling policy for the app window, by what the page's voice is doing.
//
// Normally 'default': Chromium binds a socket per network adapter, so voice reaches a server on any local network
// (a LAN, Tailscale, ZeroTier, a second router) through the right adapter. While voice goes through the
// peer-to-peer tunnel that doesn't work: the tunnel's TURN server is on 127.0.0.1, and on Windows a socket bound to
// the LAN address can't reach loopback (not one TURN packet gets out). Then 'default_public_interface_only': one
// any-address socket, which the OS routes to loopback and everywhere else. A policy only affects peer connections
// made after it is set, so the page asks before its room connects and again when it leaves.

export type WebRtcPolicy = 'default' | 'default_public_interface_only'

export const webrtcPolicyFor = (tunnelledVoice: boolean): WebRtcPolicy => (tunnelledVoice ? 'default_public_interface_only' : 'default')

/** The page's "my voice goes through the tunnel" flag, and the policy that follows from it. */
export class TunnelledVoice {
  private on = false

  get policy(): WebRtcPolicy {
    return webrtcPolicyFor(this.on)
  }

  /** Takes the page's flag (anything but a boolean is ignored); returns the policy to apply when it changed, else null. */
  set(on: unknown): WebRtcPolicy | null {
    if (typeof on !== 'boolean' || on === this.on) return null
    this.on = on
    return this.policy
  }
}

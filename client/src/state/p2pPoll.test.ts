// How often the owner's panel asks a standalone server about its tunnel.
import { describe, expect, it } from 'vitest'
import { tunnelPollMs } from './p2p'

describe('tunnelPollMs', () => {
  it('asks quickly until the tunnel has settled', () => {
    expect(tunnelPollMs(true, 'starting')).toBe(1500)
    // Switched on but the server still says "off": not a state to stay in (it stayed for 15 s after "New key").
    expect(tunnelPollMs(true, 'off')).toBe(1500)
  })

  it('asks now and then once it has', () => {
    for (const state of ['ready', 'failed', 'unavailable', 'missing']) expect(tunnelPollMs(true, state)).toBe(15_000)
  })

  it('never while the switch is off or the server runs no tunnel of its own', () => {
    expect(tunnelPollMs(false, 'off')).toBeNull()
    expect(tunnelPollMs(false, 'ready')).toBeNull()
    expect(tunnelPollMs(true, undefined)).toBeNull()
  })
})

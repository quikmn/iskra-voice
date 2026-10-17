import { DisconnectReason } from 'livekit-client'
import { describe, expect, it } from 'vitest'
import { leftReasonOf } from './voiceLeft'

describe('why voice ended', () => {
  it("names LiveKit's reasons in our words", () => {
    expect(leftReasonOf(DisconnectReason.DUPLICATE_IDENTITY, DisconnectReason)).toBe('other_device') // joined on another device
    expect(leftReasonOf(DisconnectReason.CLIENT_INITIATED, DisconnectReason)).toBe('user')
    expect(leftReasonOf(DisconnectReason.PARTICIPANT_REMOVED, DisconnectReason)).toBe('removed')
    expect(leftReasonOf(DisconnectReason.ROOM_DELETED, DisconnectReason)).toBe('server')
    expect(leftReasonOf(DisconnectReason.SERVER_SHUTDOWN, DisconnectReason)).toBe('server')
    expect(leftReasonOf(DisconnectReason.SIGNAL_CLOSE, DisconnectReason)).toBe('dropped')
    expect(leftReasonOf(undefined, DisconnectReason)).toBe('dropped')
  })
})

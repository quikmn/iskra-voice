// @vitest-environment happy-dom
// The calm note when voice moved away: to the same account on another device (LiveKit's DUPLICATE_IDENTITY), or to
// another account signed in on this device (one microphone). Never an error, and "Join here" takes it back.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useVoice } from '../state/voice'
import { voiceLeftCode } from '../state/bugReport/recorders'
import { leftReasonOf } from '../state/voiceLeft'
import { VoiceBar } from './VoiceBar'

afterEach(() => useVoice.setState({ session: null, error: null, notice: null, noticeName: null, noticeWhere: null }))

/** The bar as the app shows it (a client render: it reads the live voice state). */
function render(): string {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<VoiceBar />))
  const html = host.innerHTML
  act(() => root.unmount())
  return html
}

describe('voice moved elsewhere', () => {
  it('says "Moved to your other device" with a Join here button, not a technical error', () => {
    useVoice.setState({ session: null, error: null, notice: 'other_device', noticeName: null, noticeWhere: { serverKey: 'S', channelId: 4 } })
    const html = render()
    expect(html).toContain('Moved to your other device.')
    expect(html).toContain('Join here')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toMatch(/DUPLICATE|identity/i)
  })

  it('names the account that joined voice on this device', () => {
    useVoice.setState({ session: null, error: null, notice: 'other_account', noticeName: 'Bea', noticeWhere: { serverKey: 'S', channelId: 4 } })
    const html = render()
    expect(html).toContain('You left voice because you joined as Bea.')
    expect(html).toContain('data-testid="voice-other-account"')
  })

  it('offers no "Join here" for a call (the call goes on where it moved)', () => {
    useVoice.setState({ session: null, error: null, notice: 'other_device', noticeName: null, noticeWhere: null })
    expect(render()).not.toContain('Join here')
  })

  it('logs each as a calm INFO line with its own code', () => {
    const R = { CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5, ROOM_CLOSED: 10, SERVER_SHUTDOWN: 3 } as never
    expect(leftReasonOf(2 as never, R)).toBe('other_device')
    expect(voiceLeftCode('other_device')).toEqual({ level: 'INFO', code: 'VOI-201' })
    expect(voiceLeftCode('other_account')).toEqual({ level: 'INFO', code: 'VOI-205' })
  })
})

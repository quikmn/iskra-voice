import { describe, expect, it } from 'vitest'
import { mediaErrorKind, mediaErrorReason, mediaErrorText } from './mediaErrors'

const named = (name: string, message = '') => Object.assign(new Error(message), { name })

describe('why the microphone or camera did not start', () => {
  it('only a refusal is a permission problem', () => {
    expect(mediaErrorKind(named('NotAllowedError'))).toBe('blocked')
    expect(mediaErrorKind(named('SecurityError'))).toBe('blocked')
    expect(mediaErrorKind(named('NotFoundError'))).toBe('missing')
    // The device asked for by id doesn't exist (any more): not the same as having none.
    expect(mediaErrorKind(named('OverconstrainedError'))).toBe('gone')
    // Android's web view when the source can't be opened.
    expect(mediaErrorKind(named('NotReadableError', 'Could not start audio source'))).toBe('busy')
    expect(mediaErrorKind(named('AbortError'))).toBe('busy')
  })

  it('a call whose media does not get through is a connection problem', () => {
    expect(mediaErrorKind(named('PublishTrackError', 'publishing rejected as engine not connected within timeout'))).toBe('connection')
    expect(mediaErrorKind(named('NegotiationError', 'negotiation timed out'))).toBe('connection')
    expect(mediaErrorKind(named('ConnectionError', 'could not establish pc connection'))).toBe('connection')
    expect(mediaErrorKind(new Error('publication of local track timed out, no response from server'))).toBe('connection')
  })

  it('anything else is named, not guessed', () => {
    expect(mediaErrorKind(new Error('no microphone'))).toBe('failed')
    expect(mediaErrorKind(null)).toBe('failed')
    expect(mediaErrorReason(named('InvalidStateError', 'x'))).toBe('InvalidStateError')
    expect(mediaErrorReason(new Error('no microphone'))).toBe('no microphone')
    expect(mediaErrorReason(undefined)).toBe('unknown')
    expect(mediaErrorReason(new Error('a'.repeat(200)))).toHaveLength(60)
  })

  it('the words', () => {
    expect(mediaErrorText('mic', named('NotAllowedError'), false)).toBe("Couldn't use your microphone. Check your browser's permissions.")
    expect(mediaErrorText('mic', named('NotAllowedError'), true)).toMatch(/phone's settings/)
    expect(mediaErrorText('camera', named('NotAllowedError'), true)).toMatch(/camera.*phone's settings/)
    expect(mediaErrorText('mic', named('NotFoundError'), true)).toBe('No microphone found.')
    expect(mediaErrorText('mic', named('OverconstrainedError'), true)).toBe("The microphone you picked isn't available. Pick another one.")
    expect(mediaErrorText('camera', named('OverconstrainedError'), false)).toBe("The camera you picked isn't available. Pick another one.")
    expect(mediaErrorText('camera', named('NotReadableError'), false)).toMatch(/Another app may be using it/)
    expect(mediaErrorText('mic', named('PublishTrackError', 'timeout'), true)).toMatch(/connection to the voice server/)
    expect(mediaErrorText('mic', named('PublishTrackError', 'timeout'), true)).not.toMatch(/permission/i)
    expect(mediaErrorText('camera', named('InvalidStateError'), false)).toBe("Couldn't start your camera (InvalidStateError).")
  })
})

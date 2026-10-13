import { describe, expect, it } from 'vitest'
import { saveClip, useClips } from './clips'
import { useVoice } from './voice'

describe('clip errors', () => {
  it('keep the app’s own messages as text keys, so a language switch changes them too', async () => {
    useVoice.setState({ session: { serverKey: 's', channelId: 1, state: 'connected' } as never })
    useClips.setState({ busy: false, draft: null, error: null })
    await saveClip()
    const error = useClips.getState().error
    expect(typeof error).toBe('object')
    expect((error as { key: string }).key).toMatch(/^clips\.(unsupported|turnOnFirst|notReady)$/)
    useVoice.setState({ session: null })
  })
})

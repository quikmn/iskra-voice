import { describe, expect, it } from 'vitest'
import { patchUpload } from './uploads'

describe('pending uploads', () => {
  it("a replaced attempt's result never lands on the new one (spoiler toggled as the first upload finished)", () => {
    const first = new AbortController()
    const second = new AbortController()
    // two.png was marked as a spoiler: same item, new attempt under the new name.
    const list = [{ localId: 'a', abort: second, name: 'SPOILER_two.png', result: null as string | null }]
    expect(patchUpload(list, first, { result: 'two.png' })).toEqual(list)
    expect(patchUpload(list, second, { result: 'SPOILER_two.png' })[0].result).toBe('SPOILER_two.png')
  })
})

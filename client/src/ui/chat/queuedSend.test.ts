import { describe, expect, it } from 'vitest'
import { queuedOutcome } from './QueuedSend'

describe('queued send while uploading', () => {
  it('waits while any file is still uploading', () => {
    expect(queuedOutcome([{ done: true, failed: false }, { done: false, failed: false }])).toBe('wait')
  })
  it('sends once every file is done (or none are left)', () => {
    expect(queuedOutcome([{ done: true, failed: false }])).toBe('send')
    expect(queuedOutcome([])).toBe('send')
  })
  it('drops the queued send when a file failed, so the person decides', () => {
    expect(queuedOutcome([{ done: true, failed: false }, { done: false, failed: true }])).toBe('drop')
  })
})

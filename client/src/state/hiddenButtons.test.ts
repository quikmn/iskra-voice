import { describe, expect, it } from 'vitest'
import { BUTTON_PLACE, HIDEABLE_BUTTONS, parseHiddenButtons, withButtonHidden } from './hiddenButtons'

describe('hidden buttons', () => {
  it('reads a stored list and drops what it does not know', () => {
    expect(parseHiddenButtons(['pins', 'gif', 'send', 7])).toEqual(['gif', 'pins'])
    expect(parseHiddenButtons('gif')).toEqual([])
    expect(parseHiddenButtons(null)).toEqual([])
  })

  it('hides and shows one button, keeping the order', () => {
    const one = withButtonHidden([], 'pins', true)
    expect(one).toEqual(['pins'])
    expect(withButtonHidden(one, 'gif', true)).toEqual(['gif', 'pins'])
    expect(withButtonHidden(one, 'pins', true)).toEqual(['pins'])
    expect(withButtonHidden(['gif', 'pins'], 'gif', false)).toEqual(['pins'])
  })

  it('never offers the essentials: send, attach, mute, deafen, hang up, settings', () => {
    for (const essential of ['send', 'attach', 'mic', 'mute', 'deafen', 'hangUp', 'leave', 'settings', 'more', 'members'])
      expect(HIDEABLE_BUTTONS as readonly string[]).not.toContain(essential)
    expect(Object.keys(BUTTON_PLACE).sort()).toEqual([...HIDEABLE_BUTTONS].sort())
  })
})

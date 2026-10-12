import { describe, expect, it } from 'vitest'
import { isMenuKey, pickStop, stepIndex } from './roving'

// No DOM here: just what pickStop looks at (on screen, enabled).
const button = (label: string) => ({ label, disabled: false, getClientRects: () => [{}] }) as unknown as HTMLButtonElement

describe('roving tabindex', () => {
  it('moves without wrapping', () => {
    expect(stepIndex(3, 0, 'ArrowUp')).toBe(0)
    expect(stepIndex(3, 0, 'ArrowDown')).toBe(1)
    expect(stepIndex(3, 2, 'ArrowDown')).toBe(2)
    expect(stepIndex(3, 1, 'Home')).toBe(0)
    expect(stepIndex(3, 0, 'End')).toBe(2)
    expect(stepIndex(3, 0, 'Enter')).toBe(-1)
    expect(stepIndex(0, 0, 'ArrowDown')).toBe(-1)
  })

  it('keeps the last focused item, then the current one, then the first', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(button)
    expect(pickStop([a, b, c], c, b)).toBe(c)
    expect(pickStop([a, b], c, b)).toBe(b)
    expect(pickStop([a, b], null, null)).toBe(a)
    b.disabled = true
    expect(pickStop([a, b], b, b)).toBe(a)
  })

  it('knows the menu keys', () => {
    expect(isMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true)
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true)
    expect(isMenuKey({ key: 'F10', shiftKey: false })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { isShape, ROW_TOOLS, rowFor, SHAPES, sizeDot, sizeKind } from './boardTools'

describe('whiteboard toolbar', () => {
  it('keeps the four shapes behind one button', () => {
    expect(SHAPES.every(isShape)).toBe(true)
    expect(isShape('pen')).toBe(false)
    expect(ROW_TOOLS).toContain('shapes')
    for (const shape of SHAPES) expect(ROW_TOOLS as readonly string[]).not.toContain(shape)
  })

  it('shows only select and move around to someone who may not draw', () => {
    expect(rowFor(false)).toEqual(['select', 'pan'])
    expect(rowFor(true)).toEqual(ROW_TOOLS)
  })

  it('picks sizes for the tool in hand', () => {
    expect(sizeKind('hl')).toBe('hl')
    expect(sizeKind('note')).toBe('text')
    expect(sizeKind('text')).toBe('text')
    expect(sizeKind('rect')).toBe('stroke')
  })

  it('draws size dots that grow and fit their button', () => {
    for (const kind of ['stroke', 'hl', 'text'] as const) {
      const dots = [0, 1, 2].map((i) => sizeDot(kind, i))
      expect(dots[0]).toBeLessThan(dots[1])
      expect(dots[1]).toBeLessThan(dots[2])
      expect(Math.max(...dots)).toBeLessThanOrEqual(18)
    }
  })
})

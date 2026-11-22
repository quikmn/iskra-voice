import { describe, expect, it } from 'vitest'
import { placeMenu } from './menuPlacement'

const win = { w: 1280, h: 720 }
const menu = { w: 220, h: 300 }
// The chat pane between the sidebar and the member list.
const chat = { left: 320, right: 1024, top: 0, bottom: 720 }

describe('menu placement', () => {
  it('opens at the pointer when there is room', () => {
    expect(placeMenu({ x: 100, y: 100 }, menu, win)).toEqual({ left: 100, top: 100 })
  })

  it('flips leftward and upward at the window edges', () => {
    expect(placeMenu({ x: 1200, y: 100 }, menu, win)).toEqual({ left: 980, top: 100 })
    expect(placeMenu({ x: 100, y: 600 }, menu, win)).toEqual({ left: 100, top: 300 })
  })

  it('slides to fit when neither side has room', () => {
    expect(placeMenu({ x: 150, y: 250 }, { w: 220, h: 500 }, { w: 300, h: 720 })).toEqual({ left: 72, top: 212 })
    // Bigger than the window: starts at the margin.
    expect(placeMenu({ x: 150, y: 250 }, { w: 400, h: 900 }, { w: 300, h: 720 })).toEqual({ left: 8, top: 8 })
  })

  it("a message's menu opens leftward from its button, inside the chat pane", () => {
    // The "⋯" at the right end of the hover bar, next to the member list.
    const at = placeMenu({ x: 1003, y: 390, above: 362, align: 'end', within: chat }, menu, win)
    expect(at).toEqual({ left: 783, top: 390 })
    expect(at.left + menu.w).toBeLessThanOrEqual(chat.right)
  })

  it('opens above the button near the bottom, with its bottom edge at the top of the button', () => {
    expect(placeMenu({ x: 1003, y: 650, above: 622, align: 'end', within: chat }, menu, win)).toEqual({ left: 783, top: 322 })
  })

  it('stays in the pane when the button is near its left edge', () => {
    const narrow = { left: 700, right: 1024, top: 0, bottom: 720 }
    // Leftward would leave the pane; rightward from the button's right edge would too: it slides inside.
    expect(placeMenu({ x: 850, y: 100, align: 'end', within: narrow }, menu, win)).toEqual({ left: 700, top: 100 })
    // Rightward fits: flips.
    expect(placeMenu({ x: 760, y: 100, align: 'end', within: narrow }, menu, win)).toEqual({ left: 760, top: 100 })
  })

  it('falls back to the window when the pane is narrower than the menu', () => {
    const thin = { left: 900, right: 1050, top: 0, bottom: 720 }
    expect(placeMenu({ x: 1040, y: 100, align: 'end', within: thin }, menu, win)).toEqual({ left: 820, top: 100 })
  })

  it('never leaves the window even if the pane does', () => {
    const wide = { left: -200, right: 2000, top: -50, bottom: 3000 }
    expect(placeMenu({ x: 1275, y: 700, align: 'end', within: wide }, menu, win)).toEqual({ left: 1052, top: 400 })
    expect(placeMenu({ x: 100, y: 10, align: 'end', within: wide }, menu, win)).toEqual({ left: 100, top: 10 })
  })
})

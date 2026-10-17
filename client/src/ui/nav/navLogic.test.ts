// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { backAction, dragEndsOpen, dragProgress, swipeBlocked, swipeIntent, swipeTarget } from './navLogic'

describe('back', () => {
  it('closes the top layer first, whatever else is going on', () => {
    expect(backAction({ top: 'layer', drawer: true, armed: false })).toBe('close-layer')
    expect(backAction({ top: 'layer', drawer: true, armed: true })).toBe('close-layer')
    expect(backAction({ top: 'layer', drawer: false, armed: false })).toBe('close-layer')
  })

  it('in a channel opens the channels drawer', () => {
    expect(backAction({ top: 'none', drawer: true, armed: false })).toBe('open-nav')
  })

  it('on the drawer goes back to the channel and arms the exit', () => {
    expect(backAction({ top: 'nav', drawer: true, armed: false })).toBe('close-nav')
  })

  it('leaves on a second press while armed', () => {
    expect(backAction({ top: 'none', drawer: true, armed: true })).toBe('exit')
    expect(backAction({ top: 'nav', drawer: true, armed: true })).toBe('exit')
  })

  it('without a drawer (wide screens, sign-in) arms, then leaves', () => {
    expect(backAction({ top: 'none', drawer: false, armed: false })).toBe('arm')
    expect(backAction({ top: 'none', drawer: false, armed: true })).toBe('exit')
  })
})

describe('swipe intent', () => {
  it('waits until the finger has moved a little', () => {
    expect(swipeIntent(0, 0)).toBe('pending')
    expect(swipeIntent(6, 6)).toBe('pending')
  })

  it('is sideways only when clearly more across than down', () => {
    expect(swipeIntent(30, 0)).toBe('horizontal')
    expect(swipeIntent(-30, 10)).toBe('horizontal')
    expect(swipeIntent(30, 20)).toBe('vertical') // 30 < 20 * 1.5
    expect(swipeIntent(15, 10)).toBe('vertical') // exactly 1.5: not enough
    expect(swipeIntent(2, 40)).toBe('vertical')
  })
})

describe('swipe target', () => {
  it('right opens the channels, left the members', () => {
    expect(swipeTarget('none', 40, true)).toEqual({ panel: 'nav', opening: true })
    expect(swipeTarget('none', -40, true)).toEqual({ panel: 'members', opening: true })
    expect(swipeTarget('none', -40, false)).toBeNull() // no member list (Home)
  })

  it('the opposite way closes an open drawer, the same way does nothing', () => {
    expect(swipeTarget('nav', -40, true)).toEqual({ panel: 'nav', opening: false })
    expect(swipeTarget('nav', 40, true)).toBeNull()
    expect(swipeTarget('members', 40, true)).toEqual({ panel: 'members', opening: false })
    expect(swipeTarget('members', -40, true)).toBeNull()
  })
})

describe('drag', () => {
  const openNav = { panel: 'nav', opening: true } as const
  const closeNav = { panel: 'nav', opening: false } as const
  const openMembers = { panel: 'members', opening: true } as const

  it('follows the finger, clamped to the drawer', () => {
    expect(dragProgress(openNav, 150, 300)).toBe(0.5)
    expect(dragProgress(openNav, 600, 300)).toBe(1)
    expect(dragProgress(openNav, -50, 300)).toBe(0)
    expect(dragProgress(closeNav, -75, 300)).toBe(0.75)
    expect(dragProgress(openMembers, -150, 300)).toBe(0.5)
    expect(dragProgress(openMembers, 50, 300)).toBe(0)
  })

  it('commits past about a third, or on a flick', () => {
    expect(dragEndsOpen(openNav, 0.4, 0)).toBe(true)
    expect(dragEndsOpen(openNav, 0.2, 0)).toBe(false)
    expect(dragEndsOpen(openNav, 0.1, 0.8)).toBe(true) // quick flick right
    expect(dragEndsOpen(openNav, 0.6, -0.8)).toBe(false) // flicked back
    expect(dragEndsOpen(closeNav, 0.6, 0)).toBe(false) // dragged 40% shut
    expect(dragEndsOpen(closeNav, 0.8, 0)).toBe(true) // only 20%: snaps back open
    expect(dragEndsOpen(openMembers, 0.1, -0.8)).toBe(true) // members open leftwards
  })
})

describe('where swipes start', () => {
  const build = (html: string) => {
    document.body.innerHTML = `<div id="root">${html}</div>`
    return document.getElementById('root')!
  }

  it('plain messages are fine', () => {
    const root = build('<div class="message"><p id="t">hello</p></div>')
    expect(swipeBlocked(document.getElementById('t'), root)).toBe(false)
  })

  it('code blocks, sliders, pickers, canvases, video and fields are not', () => {
    const root = build(`
      <pre><code id="code">x</code></pre>
      <input id="range" type="range">
      <div class="emoji-picker"><button id="emoji">x</button></div>
      <div class="whiteboard-channel"><canvas id="board"></canvas></div>
      <div class="stage-body"><div id="tile">x</div></div>
      <div data-no-swipe><span id="opt">x</span></div>
      <textarea id="box"></textarea>`)
    for (const id of ['code', 'range', 'emoji', 'board', 'tile', 'opt', 'box']) expect(swipeBlocked(document.getElementById(id), root), id).toBe(true)
  })

  it('something that scrolls sideways is not', () => {
    const root = build('<div id="strip" style="overflow-x: auto"><span id="item">x</span></div>')
    const strip = document.getElementById('strip')!
    let width = 900
    Object.defineProperty(strip, 'scrollWidth', { get: () => width })
    Object.defineProperty(strip, 'clientWidth', { value: 300 })
    expect(swipeBlocked(document.getElementById('item'), root)).toBe(true)
    width = 300
    expect(swipeBlocked(document.getElementById('item'), root)).toBe(false)
  })
})

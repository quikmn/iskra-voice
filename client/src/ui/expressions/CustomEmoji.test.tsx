// @vitest-environment happy-dom
// A server emoji shows its picture only once it has loaded; before that, and when it can't, a ":name:" chip.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { CustomEmojiImage } from './CustomEmoji'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
function show(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(node))
  return host
}
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
})

const chip = (host: HTMLElement) => host.querySelector('.emoji-chip')
const img = (host: HTMLElement) => host.querySelector('img')
const fire = (host: HTMLElement, type: 'load' | 'error') => act(() => { img(host)!.dispatchEvent(new Event(type)) })

describe('custom emoji fallback', () => {
  it('is a chip while the picture loads, then the picture', () => {
    const host = show(<CustomEmojiImage src="https://srv/files/1/a.png" name="blob" />)
    expect(chip(host)?.textContent).toBe(':blob:')
    expect(chip(host)?.getAttribute('aria-label')).toBe(':blob:')
    expect(chip(host)?.getAttribute('data-emoji-state')).toBe('loading')
    // The picture is there to load, but out of sight and not read out twice.
    expect(img(host)?.className).toBe('custom-emoji loading')
    expect(img(host)?.getAttribute('alt')).toBe('')
    expect(img(host)?.getAttribute('aria-hidden')).toBe('true')
    fire(host, 'load')
    expect(chip(host)).toBeNull()
    expect(img(host)?.className).toBe('custom-emoji')
    expect(img(host)?.getAttribute('alt')).toBe(':blob:')
    expect(img(host)?.hasAttribute('aria-hidden')).toBe(false)
  })

  it('stays a chip, with no image at all, when the picture fails', () => {
    const host = show(<CustomEmojiImage src="https://srv/files/2/gone.png" name="gone" className="big" />)
    fire(host, 'error')
    expect(img(host)).toBeNull()
    expect(chip(host)?.className).toBe('emoji-chip big')
    expect(chip(host)?.getAttribute('role')).toBe('img')
    expect(chip(host)?.getAttribute('aria-label')).toBe(':gone: (emoji not available)')
    expect(chip(host)?.getAttribute('data-emoji-state')).toBe('missing')
  })

  it('is a chip when the emoji is unknown (deleted, or the list is not here yet)', () => {
    const host = show(<CustomEmojiImage src={null} name="old" />)
    expect(img(host)).toBeNull()
    expect(chip(host)?.textContent).toBe(':old:')
    expect(chip(host)?.getAttribute('aria-label')).toBe(':old: (emoji not available)')
  })

  it('shows a picture that loaded before straight away, and starts over for a new one', () => {
    const first = show(<CustomEmojiImage src="https://srv/files/3/b.png" name="b" />)
    fire(first, 'load')
    act(() => root?.unmount())
    const again = show(<CustomEmojiImage src="https://srv/files/3/b.png" name="b" />)
    expect(chip(again)).toBeNull()
    expect(img(again)?.getAttribute('alt')).toBe(':b:')
    // Another picture in the same place: its own chip until it loads; the earlier failure or success doesn't carry over.
    act(() => root!.render(<CustomEmojiImage src="https://srv/files/4/c.png" name="c" />))
    expect(chip(again)?.textContent).toBe(':c:')
    fire(again, 'error')
    expect(img(again)).toBeNull()
    act(() => root!.render(<CustomEmojiImage src="https://srv/files/3/b.png" name="b" />))
    expect(chip(again)).toBeNull()
  })

  it('next to its own label it is hidden from screen readers', () => {
    const host = show(<CustomEmojiImage src="https://srv/files/5/d.png" name="d" decorative />)
    expect(chip(host)?.getAttribute('aria-hidden')).toBe('true')
    expect(chip(host)?.hasAttribute('role')).toBe(false)
    fire(host, 'load')
    expect(img(host)?.getAttribute('alt')).toBe('')
  })
})

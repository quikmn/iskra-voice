import { describe, expect, it } from 'vitest'
import { columnsFor, isMediaFile, layoutMasonry, mediaOf, moveInGrid, nearEnd, postLabel, stepPost, tileRatio, uploadName } from './gallery'

const file = (name: string, width: number | null = 100, height: number | null = 100) =>
  ({ id: name, name, size: 1, type: 'image/png', width, height, url: `/files/${name}/${name}` })

describe('media grid', () => {
  it('fits two columns on a phone and up to five on a wide window', () => {
    expect(columnsFor(0)).toBe(2)
    expect(columnsFor(360)).toBe(2)
    expect(columnsFor(720)).toBe(3)
    expect(columnsFor(2400)).toBe(5)
  })

  it('keeps tiles between wide and tall', () => {
    expect(tileRatio(file('a', 400, 100))).toBe(0.6)
    expect(tileRatio(file('b', 100, 400))).toBe(1.6)
    expect(tileRatio(file('c', 200, 300))).toBe(1.5)
    expect(tileRatio(file('d', null, null))).toBe(1)
    expect(tileRatio(undefined)).toBe(1)
  })

  it('puts each tile in the shortest column, leftmost first', () => {
    // Tall, square, square, square: the tall one leaves column 0 longest.
    const layout = layoutMasonry([1.6, 1, 1, 1], 3)
    expect(layout.columns).toEqual([[0], [1, 3], [2]])
    expect(layout.places[3].column).toBe(1)
    expect(layoutMasonry([], 3).columns).toEqual([[], [], []])
  })

  it('moves with the arrow keys: up and down in a column, left and right to the nearest tile beside', () => {
    const layout = layoutMasonry([1.6, 1, 1, 1, 0.6], 3)
    const [c0, c1, c2] = layout.columns
    expect(moveInGrid(layout, c1[0], 'ArrowDown')).toBe(c1[1])
    expect(moveInGrid(layout, c1[1], 'ArrowUp')).toBe(c1[0])
    expect(moveInGrid(layout, c1[0], 'ArrowUp')).toBe(c1[0]) // top edge stays
    expect(moveInGrid(layout, c0[0], 'ArrowLeft')).toBe(c0[0]) // left edge stays
    expect(moveInGrid(layout, c0[0], 'ArrowRight')).toBe(c1[0])
    expect(moveInGrid(layout, c1[1], 'ArrowRight')).toBe(c2.at(-1))
    expect(moveInGrid(layout, 2, 'Home')).toBe(0)
    expect(moveInGrid(layout, 0, 'End')).toBe(4)
    expect(moveInGrid(layoutMasonry([], 2), 0, 'ArrowDown')).toBe(-1)
  })

  it('shows every picture and video of a post, or its image from an older server', () => {
    const one = file('one')
    expect(mediaOf({ media: [one, file('two')], image: one })).toHaveLength(2)
    expect(mediaOf({ media: undefined, image: one })).toEqual([one])
    expect(mediaOf({ media: [], image: null })).toEqual([])
  })
})

describe('media viewer', () => {
  const posts = [{ id: 5 }, { id: 3 }, { id: 9 }, { id: 1 }]

  it('steps between posts and stops at the ends', () => {
    expect(stepPost(posts, 3, 1)).toBe(9)
    expect(stepPost(posts, 3, -1)).toBe(5)
    expect(stepPost(posts, 5, -1)).toBeNull()
    expect(stepPost(posts, 1, 1)).toBeNull()
    expect(stepPost(posts, 42, 1)).toBeNull()
  })

  it('asks for more posts near the end of the list', () => {
    expect(nearEnd(posts, 5)).toBe(false)
    expect(nearEnd(posts, 3)).toBe(true)
    expect(nearEnd(posts, 42)).toBe(false)
  })

  it('labels untitled posts by their caption', () => {
    expect(postLabel({ title: 'Dragon', untitled: false, excerpt: 'caption' })).toBe('Dragon')
    expect(postLabel({ title: 'sunset', untitled: true, excerpt: '\n  Evening walk \nmore' })).toBe('Evening walk')
    expect(postLabel({ title: 'sunset', untitled: true, excerpt: null })).toBe('')
  })

  it('uploads only pictures and videos, marking sensitive ones as spoilers once', () => {
    expect(isMediaFile({ type: 'image/webp' })).toBe(true)
    expect(isMediaFile({ type: 'video/mp4' })).toBe(true)
    expect(isMediaFile({ type: 'text/plain' })).toBe(false)
    expect(uploadName('cat.png', true)).toBe('SPOILER_cat.png')
    expect(uploadName('SPOILER_cat.png', true)).toBe('SPOILER_cat.png')
    expect(uploadName('SPOILER_cat.png', false)).toBe('cat.png')
  })
})

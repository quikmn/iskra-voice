import { describe, expect, it } from 'vitest'
import {
  MAX_FAVORITES, addFavorite, dropFavorite, emptyFavorites, moveFavorite, parseFavorites, removeFavorite, visibleFavorites, type Favorite,
} from './favoritesLogic'

const A = 'A'.repeat(43)
const B = 'B'.repeat(43)
const f = (server: string, channel: number): Favorite => ({ server, channel })

describe('favorites list', () => {
  it('adds once to the end, up to the limit', () => {
    let list = addFavorite([], f(A, 1))!
    list = addFavorite(list, f(B, 1))!
    expect(list).toEqual([f(A, 1), f(B, 1)])
    expect(addFavorite(list, f(A, 1))).toBeNull()
    for (let i = 10; list.length < MAX_FAVORITES; i++) list = addFavorite(list, f(A, i))!
    expect(addFavorite(list, f(A, 999))).toBeNull()
    expect(removeFavorite(list, f(A, 1))).toHaveLength(MAX_FAVORITES - 1)
  })

  it('moves one step and stops at the ends', () => {
    const list = [f(A, 1), f(A, 2), f(B, 3)]
    expect(moveFavorite(list, f(A, 2), -1)).toEqual([f(A, 2), f(A, 1), f(B, 3)])
    expect(moveFavorite(list, f(A, 2), 1)).toEqual([f(A, 1), f(B, 3), f(A, 2)])
    expect(moveFavorite(list, f(A, 1), -1)).toBe(list)
    expect(moveFavorite(list, f(B, 3), 1)).toBe(list)
    expect(moveFavorite(list, f(B, 9), 1)).toBe(list)
  })

  it('drops before another entry, or at the end', () => {
    const list = [f(A, 1), f(A, 2), f(B, 3)]
    expect(dropFavorite(list, f(B, 3), f(A, 1))).toEqual([f(B, 3), f(A, 1), f(A, 2)])
    expect(dropFavorite(list, f(A, 1), null)).toEqual([f(A, 2), f(B, 3), f(A, 1)])
    expect(dropFavorite(list, f(A, 1), f(A, 1))).toBe(list)
    expect(dropFavorite(list, f(B, 9), f(A, 1))).toBe(list)
  })
})

describe('parseFavorites', () => {
  it('keeps good entries and drops bad ones and repeats', () => {
    const parsed = parseFavorites({ v: 1, updatedAt: 5, items: [f(A, 1), f(A, 1), { server: 'no good!', channel: 2 }, { server: A, channel: 0 }, { server: A, channel: 1.5 }, null, f(B, 2)] })
    expect(parsed).toEqual({ v: 1, updatedAt: 5, items: [f(A, 1), f(B, 2)] })
  })
  it('refuses what is not ours', () => {
    expect(parseFavorites(null)).toBeNull()
    expect(parseFavorites({ v: 2, updatedAt: 1, items: [] })).toBeNull()
    expect(parseFavorites({ v: 1, updatedAt: -1, items: [] })).toBeNull()
    expect(parseFavorites({ v: 1, updatedAt: 1, items: 'x' })).toBeNull()
    expect(parseFavorites(emptyFavorites())).toEqual(emptyFavorites())
  })
  it('caps a long list', () => {
    const items = Array.from({ length: MAX_FAVORITES + 20 }, (_, i) => f(A, i + 1))
    expect(parseFavorites({ v: 1, updatedAt: 1, items })!.items).toHaveLength(MAX_FAVORITES)
  })
})

describe('visibleFavorites', () => {
  const servers = { [A]: { channels: [{ id: 1 }, { id: 2 }] } }
  it('hides channels you cannot see now, and servers you are not in, but does not forget them', () => {
    const items = [f(A, 2), f(A, 9), f(B, 1), f(A, 1)]
    expect(visibleFavorites(items, servers).map((r) => r.fav)).toEqual([f(A, 2), f(A, 1)])
    expect(items).toHaveLength(4)
  })
})

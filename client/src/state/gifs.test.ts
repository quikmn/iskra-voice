import { describe, expect, it } from 'vitest'
import type { GifResult } from '../core/protocol'
import { isFavourite, MAX_FAVOURITES, toggleFavourite, useGifs } from './gifs'

const gif = (id: string): GifResult => ({ id, title: id, width: 10, height: 10, url: `/gifs/media?u=${id}`, preview: `/gifs/media?u=${id}`, token: `${id}.sig` })

describe('GIF favourites', () => {
  it('are kept per server, newest first, and toggle off again', () => {
    toggleFavourite('serverA', gif('a'))
    toggleFavourite('serverA', gif('b'))
    expect(useGifs.getState().favourites.serverA.map((g) => g.id)).toEqual(['b', 'a'])
    expect(isFavourite(useGifs.getState().favourites.serverA, gif('a'))).toBe(true)
    expect(useGifs.getState().favourites.serverB).toBeUndefined() // tokens are signed per server
    toggleFavourite('serverA', gif('a'))
    expect(useGifs.getState().favourites.serverA.map((g) => g.id)).toEqual(['b'])
  })

  it('keep at most the newest hundred', () => {
    for (let i = 0; i < MAX_FAVOURITES + 5; i++) toggleFavourite('serverC', gif(`g${i}`))
    const list = useGifs.getState().favourites.serverC
    expect(list).toHaveLength(MAX_FAVOURITES)
    expect(list[0].id).toBe(`g${MAX_FAVOURITES + 4}`)
  })
})

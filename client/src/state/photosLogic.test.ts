import { describe, expect, it } from 'vitest'
import type { Photo } from '../core/protocol'
import {
  albumCover, capField, countAlbums, durationText, fits, layoutGrid, mergePhotos, monthOf, moveInGrid, parseCapMb, plainPhoto, queueSummary, rangeIds,
  rowOf, rowsInView, sealedPhoto, stepPhoto, thumbSize, tileRatio, uploaders, usedFraction, visiblePhotos, type GridRow, type ShownPhoto,
} from './photosLogic'

const DAY = 24 * 3600 * 1000
const JULY = new Date(2026, 6, 10, 12).getTime()

function photo(id: number, more: Partial<ShownPhoto> = {}): ShownPhoto {
  return {
    id, channelId: 1, albumId: null, uploader: 'alice', createdAt: JULY + id * 1000, sortAt: JULY + id * 1000, takenAt: null, kind: 'image', name: `IMG_${id}.jpg`,
    width: 400, height: 300, duration: null, caption: '', size: 1000, reactions: [], comments: 0, threadId: null, ...more,
  }
}

const wire = (id: number, more: Partial<Photo> = {}): Photo => ({
  id, channelId: 1, albumId: null, uploader: 'alice', createdAt: 5000, size: 1200, kind: 'image',
  file: { id: 'f', name: 'IMG.jpg', size: 1000, type: 'image/jpeg', width: 400, height: 300, url: '/files/f/IMG.jpg' }, thumb: null,
  width: 300, height: 400, duration: null, takenAt: null, caption: '', e2ee: null, reactions: [], threadId: null, comments: 0, ...more,
})

describe('what a photo looks like', () => {
  it('sorts by the date taken, else by when it was added', () => {
    expect(plainPhoto(wire(1)).sortAt).toBe(5000)
    expect(plainPhoto(wire(1, { takenAt: 900 })).sortAt).toBe(900)
    expect(plainPhoto(wire(1, { kind: 'video', duration: 2500 }))).toMatchObject({ kind: 'video', duration: 2500, name: 'IMG.jpg' })
  })

  it('takes an encrypted photo from its envelope, or says why it is locked', () => {
    const sealed = wire(2, { kind: null, file: null, width: 0, height: 0, e2ee: { version: 3, envelope: {} } })
    const file = { server: 's', id: 'x', key: 'k', hash: 'h', name: 'IMG_2.jpg', type: 'image/jpeg', size: 10 }
    expect(sealedPhoto(sealed, { file, kind: 'video', name: 'IMG_2.mp4', width: 1920, height: 1080, duration: 4000, takenAt: 700, caption: 'Hi' }))
      .toMatchObject({ kind: 'video', name: 'IMG_2.mp4', width: 1920, duration: 4000, takenAt: 700, sortAt: 700, caption: 'Hi' })
    expect(sealedPhoto(sealed, 'before')).toMatchObject({ locked: 'before', sortAt: 5000, name: '', caption: '' })
  })
})

describe('sorting and filtering', () => {
  const photos = [
    photo(1, { sortAt: JULY + 3 * DAY }),
    photo(2, { sortAt: JULY, albumId: 7, uploader: 'bob' }),
    photo(3, { sortAt: JULY + 3 * DAY, albumId: 7 }),
    photo(4, { sortAt: JULY - 40 * DAY, uploader: 'bob' }),
  ]

  it('shows newest or oldest first, ties in the order they were added', () => {
    expect(visiblePhotos(photos, { album: 'all', person: null, sort: 'newest' }).map((p) => p.id)).toEqual([3, 1, 2, 4])
    expect(visiblePhotos(photos, { album: 'all', person: null, sort: 'oldest' }).map((p) => p.id)).toEqual([4, 2, 1, 3])
    // The list handed in is left as it was.
    expect(photos.map((p) => p.id)).toEqual([1, 2, 3, 4])
  })

  it('filters by album, no album and person', () => {
    expect(visiblePhotos(photos, { album: 7, person: null, sort: 'oldest' }).map((p) => p.id)).toEqual([2, 3])
    expect(visiblePhotos(photos, { album: 'none', person: null, sort: 'oldest' }).map((p) => p.id)).toEqual([4, 1])
    expect(visiblePhotos(photos, { album: 'all', person: 'bob', sort: 'newest' }).map((p) => p.id)).toEqual([2, 4])
    expect(visiblePhotos(photos, { album: 7, person: 'carol', sort: 'newest' })).toEqual([])
  })

  it('lists who added photos, most first', () => {
    expect(uploaders([...photos, photo(5, { uploader: 'bob' })])).toEqual([{ key: 'bob', count: 3 }, { key: 'alice', count: 2 }])
  })

  it('picks an album cover: the chosen photo, else the newest one that can be shown', () => {
    expect(albumCover({ id: 7, coverId: 2 }, photos)?.id).toBe(2)
    expect(albumCover({ id: 7, coverId: null }, photos)?.id).toBe(3)
    expect(albumCover({ id: 7, coverId: 99 }, photos)?.id).toBe(3)
    expect(albumCover({ id: 7, coverId: null }, [photo(9, { albumId: 7, locked: 'before' })])).toBeUndefined()
    expect(albumCover({ id: 8, coverId: null }, photos)).toBeUndefined()
  })

  it('merges photos by id and recounts albums', () => {
    const merged = mergePhotos([photo(1), photo(3)], [photo(2), photo(3, { caption: 'new' })])
    expect(merged.map((p) => p.id)).toEqual([1, 2, 3])
    expect(merged[2].caption).toBe('new')
    const list = [photo(1)]
    expect(mergePhotos(list, [])).toBe(list)
    const albums = [{ id: 7, channelId: 1, name: 'A', coverId: null, createdBy: 'alice', createdAt: 1, count: 5 }]
    expect(countAlbums(albums, photos)[0].count).toBe(2)
    const same = [{ ...albums[0], count: 2 }]
    expect(countAlbums(same, photos)[0]).toBe(same[0])
  })
})

describe('the grid', () => {
  const photoRows = (rows: GridRow[]) => rows.filter((r): r is Extract<GridRow, { kind: 'photos' }> => r.kind === 'photos')

  it('fills every full row to the width and keeps each photo in its shape', () => {
    const photos = Array.from({ length: 23 }, (_, i) => photo(i + 1, { width: [400, 300, 1600, 900][i % 4], height: [300, 400, 900, 1600][i % 4] }))
    const { rows, height } = layoutGrid(photos, 1000, 200, 4, false)
    const filled = photoRows(rows)
    expect(filled.flatMap((r) => r.tiles.map((t) => t.id))).toEqual(photos.map((p) => p.id))
    for (const row of filled.slice(0, -1)) {
      const last = row.tiles[row.tiles.length - 1]
      expect(last.left + last.width).toBe(1000)
      expect(row.height).toBeLessThanOrEqual(200)
      expect(row.height).toBeGreaterThan(90)
      // Tiles don't overlap and sit a gap apart.
      row.tiles.slice(1).forEach((tile, i) => expect(tile.left).toBe(row.tiles[i].left + row.tiles[i].width + 4))
    }
    // The last, short row keeps the target height instead of stretching across.
    const tail = filled[filled.length - 1]
    expect(tail.height).toBe(200)
    expect(height).toBe(tail.top + tail.height)
    expect(layoutGrid(photos, 0, 200, 4).rows).toEqual([])
  })

  it('starts each month with a header', () => {
    const photos = [photo(1, { sortAt: JULY + DAY }), photo(2, { sortAt: JULY }), photo(3, { sortAt: JULY - 30 * DAY }), photo(4, { sortAt: JULY - 31 * DAY })]
    const { rows } = layoutGrid(photos, 1200, 200, 4)
    expect(rows.map((r) => r.kind)).toEqual(['header', 'photos', 'header', 'photos'])
    expect(rows[0]).toMatchObject({ kind: 'header', month: monthOf(JULY), top: 0 })
    expect(rows[1].top).toBe(40)
    expect(rows[2]).toMatchObject({ kind: 'header', month: monthOf(JULY - 30 * DAY) })
    expect(rowOf(rows, 3)).toBe(rows[3])
    expect(rowOf(rows, 99)).toBeUndefined()
  })

  it('lays out ten thousand photos quickly and finds the rows on screen without walking them all', () => {
    const photos = Array.from({ length: 10_000 }, (_, i) => photo(i + 1, { sortAt: JULY - i * 3600_000, width: 300 + (i % 7) * 100, height: 300 + (i % 5) * 80 }))
    const start = performance.now()
    const { rows, height } = layoutGrid(photos, 1400, 196, 4)
    expect(performance.now() - start).toBeLessThan(500)
    expect(height).toBeGreaterThan(100_000)
    const shown = rowsInView(rows, height / 2, 900, 600)
    expect(shown.length).toBeGreaterThan(3)
    expect(shown.length).toBeLessThan(30)
    expect(shown[0].top + shown[0].height).toBeGreaterThanOrEqual(height / 2 - 600)
    expect(shown[shown.length - 1].top).toBeLessThanOrEqual(height / 2 + 900 + 600)
    // Every row between the first and the last shown is there, in order.
    const from = rows.indexOf(shown[0])
    expect(shown).toEqual(rows.slice(from, from + shown.length))
    expect(rowsInView(rows, 0, 900, 0)[0]).toBe(rows[0])
    expect(rowsInView([], 0, 900)).toEqual([])
  })

  it('moves with the arrow keys: along the order, and to the tile above or below', () => {
    const photos = Array.from({ length: 12 }, (_, i) => photo(i + 1))
    const { rows } = layoutGrid(photos, 900, 200, 4, false)
    const first = photoRows(rows)[0].tiles.map((t) => t.id)
    const second = photoRows(rows)[1].tiles.map((t) => t.id)
    expect(moveInGrid(rows, photos, 1, 'ArrowRight')).toBe(2)
    expect(moveInGrid(rows, photos, 1, 'ArrowLeft')).toBeNull()
    expect(moveInGrid(rows, photos, first[1], 'ArrowDown')).toBe(second[1])
    expect(moveInGrid(rows, photos, second[0], 'ArrowUp')).toBe(first[0])
    expect(moveInGrid(rows, photos, first[0], 'ArrowUp')).toBeNull()
    expect(moveInGrid(rows, photos, 5, 'Home')).toBe(1)
    expect(moveInGrid(rows, photos, 5, 'End')).toBe(12)
    expect(moveInGrid(rows, photos, 99, 'ArrowRight')).toBe(1)
  })

  it('steps through the viewer and selects a run', () => {
    const photos = [photo(5), photo(3), photo(9)]
    expect(stepPhoto(photos, 3, 1)).toBe(9)
    expect(stepPhoto(photos, 5, -1)).toBeNull()
    expect(stepPhoto(photos, 4, 1)).toBeNull()
    expect(rangeIds(photos, 9, 5)).toEqual([5, 3, 9])
    expect(rangeIds(photos, 3, 3)).toEqual([3])
    expect(rangeIds(photos, 77, 9)).toEqual([9])
  })

  it('keeps tiles within sane shapes', () => {
    expect(tileRatio({ width: 400, height: 300 })).toBeCloseTo(4 / 3)
    expect(tileRatio({ width: 0, height: 0 })).toBe(1)
    expect(tileRatio({ width: 10_000, height: 100 })).toBe(2.4)
    expect(tileRatio({ width: 100, height: 10_000 })).toBe(0.5)
  })
})

describe('storage and sizes', () => {
  const usage = { bytes: 600, count: 3, capBytes: 1000 as number | null, maxPhotos: 5 }

  it('says how full a channel is and whether more fits', () => {
    expect(usedFraction(usage)).toBe(0.6)
    expect(usedFraction({ bytes: 5000, capBytes: 1000 })).toBe(1)
    expect(usedFraction({ bytes: 5000, capBytes: null })).toBeNull()
    expect(fits(usage, 400)).toBe(true)
    expect(fits(usage, 401)).toBe(false)
    expect(fits({ ...usage, capBytes: null }, 10 ** 12)).toBe(true)
    expect(fits(usage, 1, 3)).toBe(false)
    expect(fits(undefined, 10 ** 12)).toBe(true)
  })

  it('reads and shows the limit field', () => {
    expect(parseCapMb('', 'GB')).toBeNull()
    expect(parseCapMb(' 5 ', 'GB')).toBe(5120)
    expect(parseCapMb('1,5', 'GB')).toBe(1536)
    expect(parseCapMb('250', 'MB')).toBe(250)
    for (const bad of ['0', '-1', 'lots', '0.0001', '99999999']) expect(parseCapMb(bad, 'MB'), bad).toBeUndefined()
    expect(capField(null)).toEqual({ text: '', unit: 'GB' })
    expect(capField(5 * 1024 ** 3)).toEqual({ text: '5', unit: 'GB' })
    expect(capField(1536 * 1024 ** 2)).toEqual({ text: '1536', unit: 'MB' })
  })

  it('formats a video length and sizes a thumbnail', () => {
    expect(durationText(65_000)).toBe('1:05')
    expect(durationText(3_723_000)).toBe('1:02:03')
    expect(durationText(400)).toBe('0:00')
    expect(thumbSize(4000, 3000)).toEqual({ width: 533, height: 400 })
    expect(thumbSize(3000, 4000)).toEqual({ width: 400, height: 533 })
    expect(thumbSize(200, 100)).toEqual({ width: 200, height: 100 })
    expect(thumbSize(12_000, 1000)).toEqual({ width: 1200, height: 100 })
    expect(thumbSize(0, 0)).toEqual({ width: 400, height: 400 })
  })

  it('sums up an upload queue', () => {
    expect(queueSummary([])).toEqual({ total: 0, done: 0, failed: 0, fraction: 0, active: false })
    const queue = [
      { state: 'done', fraction: 1, size: 100 }, { state: 'failed', fraction: 0.2, size: 100 },
      { state: 'uploading', fraction: 0.5, size: 200 }, { state: 'waiting', fraction: 0, size: 100 },
    ]
    expect(queueSummary(queue)).toEqual({ total: 4, done: 1, failed: 1, fraction: 0.6, active: true })
    expect(queueSummary(queue.slice(0, 2)).active).toBe(false)
  })
})

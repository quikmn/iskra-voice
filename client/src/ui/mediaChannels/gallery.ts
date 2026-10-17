// Pure helpers for a media channel: the masonry grid (columns, where each tile goes, moving between tiles with the
// arrow keys) and stepping through posts in the viewer. No React, no store.
import type { FileInfo, ForumPost } from '../../core/protocol'

/** Tiles are about this wide; phones get two columns, wide windows up to five. */
export const TILE_WIDTH = 200
export const GAP = 8

export function columnsFor(width: number): number {
  if (width <= 0) return 2
  return Math.max(2, Math.min(5, Math.floor((width + GAP) / (TILE_WIDTH + GAP))))
}

/** The pictures and videos a post shows (older servers: the post's image, if any). */
export function mediaOf(post: Pick<ForumPost, 'media' | 'image'>): FileInfo[] {
  if (post.media && post.media.length > 0) return post.media
  return post.image ? [post.image] : []
}

/** Height over width of a post's tile, kept between a wide 0.6 and a tall 1.6 so no tile takes over the grid. */
export function tileRatio(file: Pick<FileInfo, 'width' | 'height'> | undefined): number {
  if (!file?.width || !file.height) return 1
  return Math.min(1.6, Math.max(0.6, file.height / file.width))
}

export interface Masonry {
  /** For each column, the indexes of its tiles from top to bottom. */
  columns: number[][]
  /** For each tile (by index): its column and where its middle is, in tile widths from the top. */
  places: { column: number; middle: number }[]
}

/**
 * Masonry: each tile goes into the column that is shortest so far (the leftmost of equals), so reading order runs
 * left to right, top to bottom, roughly.
 */
export function layoutMasonry(ratios: number[], columns: number): Masonry {
  const count = Math.max(1, columns)
  const heights = new Array<number>(count).fill(0)
  const cols: number[][] = Array.from({ length: count }, () => [])
  const places: Masonry['places'] = []
  ratios.forEach((ratio, i) => {
    let column = 0
    for (let c = 1; c < count; c++) if (heights[c] < heights[column] - 1e-9) column = c
    places.push({ column, middle: heights[column] + ratio / 2 })
    heights[column] += ratio + 0.04 // the gap, in tile widths
    cols[column].push(i)
  })
  return { columns: cols, places }
}

export type GridKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

/** The tile the arrow keys move to from `index` (the same index at an edge). Left and right pick the nearest tile beside it. */
export function moveInGrid(layout: Masonry, index: number, key: GridKey): number {
  const total = layout.places.length
  if (total === 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return total - 1
  const here = layout.places[index]
  if (!here) return 0
  const column = layout.columns[here.column]
  const at = column.indexOf(index)
  if (key === 'ArrowUp') return at > 0 ? column[at - 1] : index
  if (key === 'ArrowDown') return at < column.length - 1 ? column[at + 1] : index
  const step = key === 'ArrowLeft' ? -1 : 1
  for (let c = here.column + step; c >= 0 && c < layout.columns.length; c += step) {
    const beside = layout.columns[c]
    if (beside.length === 0) continue
    return beside.reduce((best, i) =>
      Math.abs(layout.places[i].middle - here.middle) < Math.abs(layout.places[best].middle - here.middle) ? i : best, beside[0])
  }
  return index
}

/** The post `delta` steps from `id` in the list (null at either end, or if it isn't in the list). */
export function stepPost(posts: Pick<ForumPost, 'id'>[], id: number, delta: number): number | null {
  const at = posts.findIndex((p) => p.id === id)
  if (at < 0) return null
  return posts[at + delta]?.id ?? null
}

/** Whether the viewer is close enough to the end of what's loaded to ask for the next page. */
export const nearEnd = (posts: Pick<ForumPost, 'id'>[], id: number, within = 3) => {
  const at = posts.findIndex((p) => p.id === id)
  return at >= 0 && posts.length - 1 - at < within
}

/** Spoiler pictures (SPOILER_ in the name) stay blurred until revealed. */
export const isSensitive = (file: Pick<FileInfo, 'name'> | undefined) => !!file?.name.startsWith('SPOILER_')

/** What a post is called on screen: its title, or for an untitled post its caption's first line (or nothing). */
export function postLabel(post: Pick<ForumPost, 'title' | 'untitled' | 'excerpt'>, caption = post.excerpt): string {
  if (!post.untitled) return post.title
  return (caption ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
}

/** Only pictures and videos go into a media post, at most ten. */
export const MAX_MEDIA = 10
export const isMediaFile = (file: { type: string }) => file.type.startsWith('image/') || file.type.startsWith('video/')

/** The name a file is uploaded under: SPOILER_ in front when it's marked sensitive (once). */
export function uploadName(name: string, sensitive: boolean): string {
  const bare = name.replace(/^SPOILER_/, '')
  return sensitive ? `SPOILER_${bare}` : bare
}

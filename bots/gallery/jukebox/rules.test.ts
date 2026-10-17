// Jukebox's rules: what's in the music folder, finding a song, and the cards. Run: npm test (in bots/, or in a copy of this folder).
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { find, library, listing, nowPlaying, stopped } from './rules.ts'

const folder = mkdtempSync(join(tmpdir(), 'jukebox-test-'))
after(() => rmSync(folder, { recursive: true, force: true }))
for (const name of ['10 Ten.mp3', '2 Two.ogg', 'cover.jpg', 'Song.FLAC', 'notes.txt']) writeFileSync(join(folder, name), 'x')
mkdirSync(join(folder, 'folder.mp3')) // a folder named like a song is not a song
writeFileSync(join(folder, 'stations.json'), JSON.stringify([
  { name: 'Lo-fi radio', url: 'https://radio.example/stream.mp3' },
  { name: 'Sneaky', url: 'file:///etc/passwd' },
  { name: 42, url: 'https://x.example' },
]))

describe('the music folder', () => {
  it('lists audio files in natural order, then the stations with http(s) addresses', () => {
    const songs = library(folder)
    assert.deepEqual(songs.map((s) => s.title), ['2 Two', '10 Ten', 'Song', 'Lo-fi radio'])
    assert.equal(songs[3].station, true)
    assert.equal(songs[3].source, 'https://radio.example/stream.mp3')
  })

  it('is empty when the folder is missing', () => {
    assert.deepEqual(library(join(folder, 'nope')), [])
    assert.match(listing([]), /empty/)
  })
})

describe('finding a song', () => {
  const songs = library(folder)
  it('prefers an exact title, else the first that contains the words, ignoring case', () => {
    assert.equal(find(songs, 'song'), 2)
    assert.equal(find(songs, 'TEN'), 1)
    assert.equal(find(songs, 'radio'), 3)
    assert.equal(find(songs, ''), 0)
    assert.equal(find(songs, 'polka'), -1)
    assert.equal(find([], ''), -1)
  })
})

describe('cards', () => {
  const songs = library(folder)
  it('shows what plays and what is next, with Pause or Resume', () => {
    const card = nowPlaying(songs[0], songs[1], false)
    assert.match(card.cards[0].description ?? '', /2 Two/)
    assert.equal(card.cards[0].fields?.[0].value, '10 Ten')
    assert.equal(card.components[0].items[0].type === 'button' && card.components[0].items[0].customId, 'jukebox:pause')
    const paused = nowPlaying(songs[3], undefined, true)
    assert.match(paused.cards[0].description ?? '', /\(radio\)/)
    const items = paused.components[0].items
    assert.equal(items[0].type === 'button' && items[0].customId, 'jukebox:resume')
    assert.equal(items[1].type === 'button' && items[1].disabled, true) // nothing to skip to
  })

  it('a stopped card has no buttons', () => {
    assert.deepEqual(stopped('bye').components, [])
  })

  it('lists at most 40 songs', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ title: `S${i}`, source: '', station: false }))
    assert.match(listing(many), /and 5 more$/)
  })
})

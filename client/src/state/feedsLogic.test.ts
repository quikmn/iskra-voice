import { describe, expect, it } from 'vitest'
import type { FeedFields, FeedSubscription } from '../core/protocol'
import {
  FEED_INTERVALS, feedStatus, fieldsOf, fieldsPatch, fieldsProblem, fillFeedTemplate, guessKind, mentionToken, mentionValue, parseMentionValue,
  safeUrl, sourceProblem,
} from './feedsLogic'

const fields = (more: Partial<FeedFields> = {}): FeedFields => ({ channelId: 1, mention: null, mentionRoleId: null, template: '', intervalMinutes: 15, ...more })

const sub = (more: Partial<FeedSubscription> = {}): FeedSubscription => ({
  id: 1, kind: 'rss', source: 'https://x.example/feed', name: 'X', url: 'https://x.example/feed', channelId: 1, mention: null, mentionRoleId: null,
  template: '', intervalMinutes: 15, paused: false, createdBy: 'k', createdAt: 0, lastCheckAt: null, lastOkAt: null, lastPostAt: null, nextCheckAt: 0,
  failures: 0, lastError: null, canPing: true, ...more,
})

describe('feeds settings', () => {
  it('guesses YouTube and Twitch from a pasted address', () => {
    expect(guessKind('https://www.youtube.com/@cooking')).toBe('youtube')
    expect(guessKind('youtube.com/channel/UCabcdefghijklmnopqrstuv')).toBe('youtube')
    expect(guessKind('UCabcdefghijklmnopqrstuv')).toBe('youtube')
    expect(guessKind('https://www.twitch.tv/streamer')).toBe('twitch')
    expect(guessKind('https://blog.example/feed.xml')).toBe('rss')
    expect(guessKind('https://notyoutube.com.evil/x')).toBe('rss')
  })

  it('checks sources before sending them', () => {
    expect(sourceProblem('rss', '  ')).toBe('empty')
    expect(sourceProblem('rss', 'https://blog.example/feed.xml')).toBeNull()
    expect(sourceProblem('rss', 'blog.example/feed')).toBeNull()
    expect(sourceProblem('rss', 'not an address')).toBe('url')
    expect(sourceProblem('rss', 'javascript:alert(1)')).toBe('url')
    expect(sourceProblem('rss', 'https://user:pw@blog.example/feed')).toBe('url')
    expect(sourceProblem('rss', 'https://' + 'a'.repeat(600))).toBe('long')
    expect(sourceProblem('youtube', '@cooking')).toBeNull()
    expect(sourceProblem('youtube', 'UCabcdefghijklmnopqrstuv')).toBeNull()
    expect(sourceProblem('youtube', 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv')).toBeNull()
    expect(sourceProblem('youtube', 'https://www.youtube.com/watch?v=abc')).toBe('youtube')
    expect(sourceProblem('twitch', 'streamer_1')).toBeNull()
    expect(sourceProblem('twitch', 'https://www.twitch.tv/streamer')).toBeNull()
    expect(sourceProblem('twitch', 'two words')).toBe('twitch')
  })

  it('checks the fields as the server does', () => {
    expect(fieldsProblem('rss', fields())).toBeNull()
    expect(fieldsProblem('rss', fields({ intervalMinutes: FEED_INTERVALS.rss.min - 1 }))).toBe('interval')
    expect(fieldsProblem('rss', fields({ intervalMinutes: 1441 }))).toBe('interval')
    expect(fieldsProblem('rss', fields({ intervalMinutes: Number.NaN }))).toBe('interval')
    expect(fieldsProblem('twitch', fields({ intervalMinutes: 2 }))).toBeNull()
    expect(fieldsProblem('twitch', fields({ intervalMinutes: 61 }))).toBe('interval')
    expect(fieldsProblem('rss', fields({ template: 'x'.repeat(501) }))).toBe('template')
    expect(fieldsProblem('rss', fields({ mention: 'role', mentionRoleId: null }))).toBe('role')
    expect(fieldsProblem('rss', fields({ channelId: 0 }))).toBe('channel')
  })

  it('sends only what changed, a role with its mention', () => {
    const saved = fieldsOf(sub())
    expect(fieldsPatch(saved, saved)).toEqual({})
    expect(fieldsPatch(saved, { ...saved, intervalMinutes: 30, template: '  {title}  ' })).toEqual({ intervalMinutes: 30, template: '{title}' })
    expect(fieldsPatch(saved, { ...saved, mention: 'role', mentionRoleId: 4 })).toEqual({ mention: 'role', mentionRoleId: 4 })
    expect(fieldsPatch({ ...saved, mention: 'role', mentionRoleId: 4 }, { ...saved, mention: 'role', mentionRoleId: 5 })).toEqual({ mention: 'role', mentionRoleId: 5 })
    expect(fieldsPatch({ ...saved, mention: 'everyone' }, saved)).toEqual({ mention: null })
  })

  it('maps mentions to the picker and to message markup', () => {
    expect(mentionValue(null, null)).toBe('')
    expect(mentionValue('role', 7)).toBe('role:7')
    expect(parseMentionValue('role:7')).toEqual({ mention: 'role', mentionRoleId: 7 })
    expect(parseMentionValue('everyone')).toEqual({ mention: 'everyone', mentionRoleId: null })
    expect(parseMentionValue('nonsense')).toEqual({ mention: null, mentionRoleId: null })
    expect(mentionToken('role', 7)).toBe('<@&7>')
    expect(mentionToken('here', null)).toBe('@here')
    expect(mentionToken('role', null)).toBeNull()
  })

  it('only links http(s) and fills templates like the server', () => {
    expect(safeUrl('https://ok.example/a')).toBe('https://ok.example/a')
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('data:text/html,hi')).toBeNull()
    expect(safeUrl(null)).toBeNull()
    expect(fillFeedTemplate('New on {name}: {title} {url} {title}', { title: 'T', url: 'https://u', name: 'N' })).toBe('New on N: T https://u T')
    expect(fillFeedTemplate('@everyone <@&3> {title}', { title: 'T', url: '', name: '' })).toBe('@‍everyone <‍@&3> T')
  })

  it('says how a feed is doing', () => {
    expect(feedStatus(sub())).toBe('new')
    expect(feedStatus(sub({ lastOkAt: 1 }))).toBe('ok')
    expect(feedStatus(sub({ lastOkAt: 1, lastError: 'unreachable' }))).toBe('error')
    expect(feedStatus(sub({ paused: true, lastError: 'http' }))).toBe('paused')
  })
})

import { describe, expect, it } from 'vitest'
import { plainText } from '../../ui/markdown'
import { speakableText, speakCustomEmoji, MAX_SPOKEN, type SpeechWords } from './speechText'
import { parseSpeechSettings, parseTtsCommand, shouldRead, withReadAloud, type HeardMessage } from './speechRules'

const words: SpeechWords = {
  codeBlock: (lines) => `code block, ${lines} ${lines === 1 ? 'line' : 'lines'}`,
  spoiler: 'spoiler',
  link: (host) => `link to ${host}`,
  more: 'and more',
}

const ANNA = 'A'.repeat(43)
const names: Record<string, string> = { [ANNA]: 'Anna' }
const say = (raw: string) => speakableText(plainText(speakCustomEmoji(raw), {
  nameOf: (k) => names[k] ?? null,
  roleOf: (id) => (id === 7 ? { name: 'Raiders', color: null, mine: false } : null),
}), words)

describe('read-aloud text', () => {
  it('says mentions and roles by name', () => {
    expect(say(`hey <@${ANNA}> and <@&7>, ready?`)).toBe('hey @Anna and @Raiders, ready?')
  })

  it('says custom emoji by name and shortens runs of the same emoji', () => {
    expect(say('nice <:party_parrot:abcdefghijkl>')).toBe('nice party parrot')
    expect(say('gg 🔥🔥🔥🔥🔥 wow 😂 😂 😂')).toBe('gg 🔥 wow 😂')
  })

  it('names code blocks instead of reading them, and keeps inline code', () => {
    expect(say('look:\n```ts\nconst a = 1\nconst b = 2\n```\nright?')).toBe('look: code block, 2 lines. right?')
    expect(say('```\nnpm test\n```')).toBe('code block, 1 line.')
    expect(say('run `npm test` first')).toBe('run npm test first')
  })

  it('reads links as their host names', () => {
    expect(say('see https://www.github.com/iskra/iskra/pull/12?x=1 now')).toBe('see link to github.com now')
    expect(say('[the docs](https://docs.example.org/a/b)')).toBe('the docs')
    expect(say('http://localhost:47070/x')).toBe('link to localhost')
  })

  it('never reads a spoiler', () => {
    expect(say('the ending: ||he was the ghost||!')).toBe('the ending: spoiler!')
  })

  it('drops markdown markers and calms stretched words and punctuation', () => {
    expect(say('**bold** and *soft* ~~gone~~')).toBe('bold and soft gone')
    expect(say('> quoted\n# Big news')).toBe('quoted. Big news')
    expect(say('nooooooooo!!!!!!')).toBe('nooo!')
  })

  it('cuts long messages at a word', () => {
    const text = say('word '.repeat(200))
    expect(text.length).toBeLessThanOrEqual(MAX_SPOKEN + ' and more'.length + 2)
    expect(text.endsWith('… and more')).toBe(true)
    expect(text).not.toMatch(/wor… /)
  })

  it('has nothing to say for an empty message', () => {
    expect(say('')).toBe('')
    expect(say('   \n  ')).toBe('')
  })
})

describe('when new messages are read', () => {
  const base: HeardMessage = { readAloudHere: false, tts: false, playTts: false, open: true, muted: false, hushed: false }

  it('reads everything with "Read new messages aloud", and /tts only for people who turned it on', () => {
    expect(shouldRead({ ...base, readAloudHere: true })).toBe(true)
    expect(shouldRead({ ...base, tts: true })).toBe(false)
    expect(shouldRead({ ...base, tts: true, playTts: true })).toBe(true)
    expect(shouldRead(base)).toBe(false)
  })

  it('stays quiet away from the channel, when muted, and in quiet hours or do not disturb', () => {
    const all = { ...base, readAloudHere: true, tts: true, playTts: true }
    expect(shouldRead({ ...all, open: false })).toBe(false)
    expect(shouldRead({ ...all, muted: true })).toBe(false)
    expect(shouldRead({ ...all, hushed: true })).toBe(false)
  })

  it('keeps settings in range and the channel list short', () => {
    expect(parseSpeechSettings('{"rate":9,"volume":-1,"voice":42,"playTts":"yes","readAloud":["c:a:1",3]}'))
      .toEqual({ rate: 2, volume: 0, voice: null, playTts: false, readAloud: ['c:a:1'] })
    expect(parseSpeechSettings('not json')).toEqual({ rate: 1, volume: 1, voice: null, playTts: false, readAloud: [] })
    expect(withReadAloud(['c:a:1'], 'c:a:2', true)).toEqual(['c:a:1', 'c:a:2'])
    expect(withReadAloud(['c:a:1', 'c:a:2'], 'c:a:1', false)).toEqual(['c:a:2'])
    expect(withReadAloud(['c:a:1'], 'c:a:1', true)).toEqual(['c:a:1'])
  })
})

describe('/tts', () => {
  it('takes the text after the command', () => {
    expect(parseTtsCommand('/tts GG everyone')).toBe('GG everyone')
    expect(parseTtsCommand('  /TTS  two\nlines ')).toBe('two\nlines')
    expect(parseTtsCommand('/tts')).toBe('')
    expect(parseTtsCommand('/ttsx hi')).toBeNull()
    expect(parseTtsCommand('say /tts hi')).toBeNull()
  })
})

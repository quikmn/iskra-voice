import { describe, expect, it } from 'vitest'
import {
  channelTargetId, cleanShareName, dmTargetId, groupTargetId, isOwnFile, MAX_SHARE_FILES, matchesQuery, orderTargets, overLimit, parseShare,
  rememberTarget, shareText, type ShareTarget,
} from './shareInLogic'

const ORIGIN = 'http://localhost'
const file = (n: number, extra: Record<string, unknown> = {}) => ({ name: `f${n}.jpg`, type: 'image/jpeg', size: 100, url: `${ORIGIN}/_capacitor_file_/cache/shared/${n}`, ...extra })

describe('parseShare', () => {
  it('takes text, files and the skipped count', () => {
    const share = parseShare({ id: '7', text: 'hello', files: [file(1), file(2)], skipped: 1 }, ORIGIN)
    expect(share).toEqual({ id: '7', text: 'hello', files: [file(1), file(2)], skipped: 1 })
  })

  it('nothing to share is no share', () => {
    expect(parseShare({ id: '1', text: '   ', files: [] }, ORIGIN)).toBeNull()
    expect(parseShare(null, ORIGIN)).toBeNull()
    expect(parseShare('text', ORIGIN)).toBeNull()
  })

  it('only fetches files from the page’s own origin', () => {
    const share = parseShare({
      text: 'x',
      files: [file(1), file(2, { url: 'https://evil.example/x' }), file(3, { url: 'file:///data/data/foo.iskra.app/keys' }), file(4, { url: 'data:text/plain,hi' })],
    }, ORIGIN)
    expect(share?.files.map((f) => f.name)).toEqual(['f1.jpg'])
    expect(share?.skipped).toBe(3)
  })

  it('takes the iPhone app’s copies only from its own file server on its own origin', () => {
    const IOS = 'capacitor://localhost'
    const copy = `${IOS}/_capacitor_file_/private/var/mobile/Containers/Shared/AppGroup/X/Shares/Y/1.jpg`
    expect(parseShare({ files: [file(1, { url: copy })] }, IOS)?.files[0].url).toBe(copy)
    expect(isOwnFile(copy, IOS)).toBe(true)
    // Elsewhere on the app's origin, another host, another scheme, credentials, a way out of the folder.
    expect(isOwnFile(`${IOS}/index.html`, IOS)).toBe(false)
    expect(isOwnFile('capacitor://evil/_capacitor_file_/x', IOS)).toBe(false)
    expect(isOwnFile('ionic://localhost/_capacitor_file_/x', IOS)).toBe(false)
    expect(isOwnFile('capacitor://a:b@localhost/_capacitor_file_/x', IOS)).toBe(false)
    expect(isOwnFile(`${IOS}/_capacitor_file_/../keys`, IOS)).toBe(false)
    expect(isOwnFile('https://evil.example/_capacitor_file_/x', IOS)).toBe(false)
    expect(isOwnFile('blob:capacitor://localhost/abc', IOS)).toBe(false)
    // Not on any other page: a web page never takes capacitor:// URLs, and an opaque origin matches nothing.
    expect(isOwnFile(copy, ORIGIN)).toBe(false)
    expect(isOwnFile(copy, 'null')).toBe(false)
    expect(isOwnFile('capacitor://localhost/_capacitor_file_/x', 'capacitor://localhost/')).toBe(false)
  })

  it('accepts blob URLs of the page (the tests’ stand-in for the app’s copies)', () => {
    expect(parseShare({ files: [file(1, { url: `blob:${ORIGIN}/abc` })] }, ORIGIN)?.files).toHaveLength(1)
    expect(parseShare({ files: [file(1, { url: 'blob:https://other.example/abc' })] }, ORIGIN)).toBeNull()
  })

  it('keeps at most 10 files and skips broken entries', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(i))
    const share = parseShare({ files: [...files, { name: 'no url', size: 1 }, file(99, { size: -1 }), file(98, { size: 'big' })] }, ORIGIN)
    expect(share?.files).toHaveLength(MAX_SHARE_FILES)
    expect(share?.skipped).toBe(5)
  })

  it('cleans names and types', () => {
    const share = parseShare({ files: [file(1, { name: '../../etc/passwd', type: 'text/html; charset=x' }), file(2, { name: '' })] }, ORIGIN)
    expect(share?.files[0].name).toBe('_.._etc_passwd')
    expect(share?.files[0].type).toBe('application/octet-stream')
    expect(share?.files[1].name).toBe('file')
  })
})

describe('shareText', () => {
  it('puts a browser’s page title above the link', () => {
    expect(shareText('https://example.com/a', 'A page')).toBe('A page\nhttps://example.com/a')
  })
  it('leaves other subjects out, and doesn’t repeat a title already in the text', () => {
    expect(shareText('See you at 8', 'Re: dinner')).toBe('See you at 8')
    expect(shareText('A page https://example.com', 'A page')).toBe('A page https://example.com')
    expect(shareText(undefined, 'Only a subject')).toBe('')
  })
  it('stays within a message', () => {
    expect(shareText('x'.repeat(5000), undefined)).toHaveLength(4000)
  })
})

describe('cleanShareName', () => {
  it('drops folders, control characters and leading dots', () => {
    expect(cleanShareName('a/b\\c:d\u0000e.txt')).toBe('a_b_c_d_e.txt')
    expect(cleanShareName('...hidden')).toBe('hidden')
    expect(cleanShareName('x'.repeat(200) + '.png')).toHaveLength(120)
  })
})

const channel = (serverKey: string, id: number, name: string, activity = 0, serverName = 'Home'): ShareTarget =>
  ({ kind: 'channel', id: channelTargetId(serverKey, id), serverKey, channelId: id, name, serverName, encrypted: false, activity })
const dm = (peer: string, name: string, activity = 0): ShareTarget => ({ kind: 'dm', id: dmTargetId(peer), peer, name, activity })
const group = (key: string, name: string, activity = 0): ShareTarget => ({ kind: 'group', id: groupTargetId(key), key, name, serverName: 'Home', activity })

describe('orderTargets', () => {
  const targets = [channel('s1', 1, 'general', 50), channel('s1', 2, 'memes', 10), dm('alex', 'Alex', 40), group('s1/g', 'Trip', 0), channel('s2', 1, 'café', 0, 'Work')]
  const people = [dm('bo', 'Bo'), dm('alex', 'Alex again')]

  it('recent places first (in the order shared), then by activity', () => {
    const { recent, rest } = orderTargets(targets, people, [dmTargetId('gone'), channelTargetId('s1', 2), groupTargetId('s1/g')], '')
    expect(recent.map((t) => t.name)).toEqual(['memes', 'Trip'])
    expect(rest.map((t) => t.name)).toEqual(['general', 'Alex', 'café'])
  })

  it('DMs and groups before channels when equally quiet', () => {
    const { rest } = orderTargets([channel('s', 1, 'a'), dm('p', 'Zed')], [], [], '')
    expect(rest.map((t) => t.kind)).toEqual(['dm', 'channel'])
  })

  it('people only show when searching, never twice', () => {
    expect(orderTargets(targets, people, [], '').rest.some((t) => t.name === 'Bo')).toBe(false)
    const { rest } = orderTargets(targets, people, [], 'b')
    expect(rest.map((t) => t.name)).toEqual(['Bo'])
    expect(orderTargets(targets, people, [], 'alex').rest.map((t) => t.name)).toEqual(['Alex'])
  })

  it('search matches names and server names, ignoring case, accents and a leading # or @', () => {
    expect(orderTargets(targets, [], [], '#CAFE').rest.map((t) => t.name)).toEqual(['café'])
    expect(orderTargets(targets, [], [], 'work').rest.map((t) => t.name)).toEqual(['café'])
    expect(matchesQuery(dm('a', 'Alex'), '@al')).toBe(true)
  })
})

describe('rememberTarget', () => {
  it('moves to the front and keeps at most eight', () => {
    expect(rememberTarget(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(rememberTarget(Array.from({ length: 8 }, (_, i) => `x${i}`), 'new')).toHaveLength(8)
  })
})

describe('overLimit', () => {
  it('flags files over the server’s limit', () => {
    const files = [file(1, { size: 5 * 1024 * 1024 }), file(2, { size: 30 * 1024 * 1024 })]
    expect(overLimit(files, 25).map((f) => f.name)).toEqual(['f2.jpg'])
    expect(overLimit(files, 0)).toEqual([])
  })
})

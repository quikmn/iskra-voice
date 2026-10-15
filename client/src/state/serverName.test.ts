import { describe, expect, it } from 'vitest'
import { fetchServerInfo, fetchServerName } from './serverName'

const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('fetchServerName', () => {
  it('reads the name from the server root', async () => {
    let asked = ''
    const impl = (async (url: string) => {
      asked = url
      return new Response(JSON.stringify({ iskra: 1, name: '  Weekend\n Crew ' }))
    }) as unknown as typeof fetch
    expect(await fetchServerName('https://chat.example.com:47070/some/path', 1000, impl)).toBe('Weekend Crew')
    expect(asked).toBe('https://chat.example.com:47070/')
  })

  it('caps a long name', async () => {
    expect((await fetchServerName('https://a.example', 1000, answer({ iskra: 1, name: 'x'.repeat(500) })))?.length).toBe(100)
  })

  it('gives null for anything that is not an Iskra server', async () => {
    expect(await fetchServerName('https://a.example', 1000, answer({ name: 'Nope' }))).toBeNull()
    expect(await fetchServerName('https://a.example', 1000, answer({ iskra: 1, name: 42 }))).toBeNull()
    expect(await fetchServerName('https://a.example', 1000, answer({ iskra: 1, name: '   ' }))).toBeNull()
    expect(await fetchServerName('https://a.example', 1000, answer({ iskra: 1, name: 'X' }, 500))).toBeNull()
    expect(await fetchServerName('https://a.example', 1000, (async () => { throw new TypeError('offline') }) as unknown as typeof fetch)).toBeNull()
    expect(await fetchServerName('javascript:alert(1)', 1000, answer({ iskra: 1, name: 'X' }))).toBeNull()
    expect(await fetchServerName('not a url', 1000, answer({ iskra: 1, name: 'X' }))).toBeNull()
  })

  it('reads the icon stamp and points at the public icon on the server root', async () => {
    const info = await fetchServerInfo('https://chat.example.com:47070/x', 1000, answer({ iskra: 1, name: 'Crew', icon: '0123456789abcdef' }))
    expect(info).toEqual({ name: 'Crew', icon: 'https://chat.example.com:47070/icon?v=0123456789abcdef' })
    expect((await fetchServerInfo('https://a.example', 1000, answer({ iskra: 1, name: 'Crew', icon: null })))?.icon).toBeNull()
    // Older servers say nothing; anything that isn't a stamp is ignored.
    expect((await fetchServerInfo('https://a.example', 1000, answer({ iskra: 1, name: 'Crew' })))?.icon).toBeNull()
    expect((await fetchServerInfo('https://a.example', 1000, answer({ iskra: 1, name: 'Crew', icon: '../../evil' })))?.icon).toBeNull()
    expect((await fetchServerInfo('https://a.example', 1000, answer({ iskra: 1, name: 'Crew', icon: 'https://evil.example/x.png' })))?.icon).toBeNull()
  })
})

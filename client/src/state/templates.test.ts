import { describe, expect, it } from 'vitest'
import { channelNotes, templateFileName } from './templates'

describe('starter templates', () => {
  it('names saved files after the server', () => {
    expect(templateFileName('Book club')).toBe('book-club.iskra-template.json')
    expect(templateFileName('Café Ünïcode!!')).toBe('cafe-unicode.iskra-template.json')
    expect(templateFileName('🎲')).toBe('server.iskra-template.json')
  })

  it('describes who can use a channel, its settings and role overrides', () => {
    expect(channelNotes({ name: 'general', kind: 'text', userLimit: 0 })).toEqual([])
    expect(channelNotes({ name: 'general', kind: 'text', userLimit: 0, readRole: 'member', writeRole: 'member' })).toEqual([])
    const notes = channelNotes({
      name: 'news', kind: 'text', userLimit: 0, readRole: 'member', writeRole: 'admin', slowmode: 30,
      overrides: [{ role: 'Moderator', allow: ['send'], deny: [] }, { role: 'Muted', allow: [], deny: ['view', 'send'] }],
    })
    expect(notes).toEqual(['Admin and up can post', 'Slowmode 30 s', 'Moderator: can post', "Muted: can't see, post"])
    expect(channelNotes({ name: 'Studio', kind: 'voice', userLimit: 4, hifi: true })).toEqual(['up to 4', 'Hi-fi'])
    expect(channelNotes({ name: 'ideas', kind: 'forum', userLimit: 0, tags: ['Bug', 'Wish'] })).toEqual(['Tags: Bug, Wish'])
    expect(channelNotes({ name: 'secret', kind: 'text', userLimit: 0, readRole: 'owner' })).toEqual(['Owner and up can see it'])
  })
})

import { describe, expect, it } from 'vitest'
import shipped from '../../docs/releases/2.0.0-alpha.16.md?raw'
import { MAX_LINES, releaseNotesFor, releaseNotesUrl, whatsNewLines } from './releaseNotes'

const NOTES = `**Iskra: alpha 16.**

### What's new
- **Report a bug from inside the app.** Press Ctrl+Shift+B, say what happened.
  A second line of the same bullet.
- **AFK channel.** People who sit idle are moved.
- **Richer GitHub cards:** the full commit subject.
- Thinner [scrollbars](https://example.com) that follow your \`theme\`. More text here.
- **The built-in roles show up in Server settings → Roles.** Owner, Admin and Member.

### Fixes
- **Not a highlight.** A fix.
`

describe("release notes for the What's new card", () => {
  it("takes the bold lead of each What's new bullet, or its first sentence, as plain text", () => {
    expect(whatsNewLines(NOTES)).toEqual([
      'Report a bug from inside the app.',
      'AFK channel.',
      'Richer GitHub cards',
      'Thinner scrollbars that follow your theme.',
      'The built-in roles show up in Server settings → Roles.',
    ])
  })

  it('keeps it short', () => {
    const many = `### What's new\n${Array.from({ length: 12 }, (_, i) => `- **Thing ${i}.** More.`).join('\n')}\n`
    expect(whatsNewLines(many)).toHaveLength(MAX_LINES)
    const long = whatsNewLines(`### What's new\n- ${'word '.repeat(80)}\n`)[0]
    expect(long.length).toBeLessThanOrEqual(160)
    expect(long.endsWith('…')).toBe(true)
  })

  it("shows the fixes when a release has nothing new, and nothing without either section", () => {
    expect(whatsNewLines('### Fixes\n- **A fix.** More.\n')).toEqual(['A fix.'])
    expect(whatsNewLines("### What's new\n- **New.**\n\n### Fixes\n- **A fix.**\n")).toEqual(['New.'])
    expect(whatsNewLines('### Good to know\n- **A note.**\n')).toEqual([])
    expect(whatsNewLines('')).toEqual([])
  })

  it('reads English, and Swedish when there is a file for it; nothing when the notes are missing', () => {
    const files: Record<string, string> = { '2.0.0-alpha.20.md': NOTES, '2.0.0-alpha.20.sv.md': '### Nytt\n- **Rapportera en bugg.** Text.\n' }
    const read = (file: string) => files[file] ?? null
    expect(releaseNotesFor('2.0.0-alpha.20', read)).toMatchObject({ version: '2.0.0-alpha.20', sv: ['Rapportera en bugg.'] })
    expect(releaseNotesFor('2.0.0-alpha.20', read)?.en).toHaveLength(5)
    delete files['2.0.0-alpha.20.sv.md']
    expect(releaseNotesFor('2.0.0-alpha.20', read)).not.toHaveProperty('sv')
    expect(releaseNotesFor('2.0.0-alpha.21', read)).toBeNull() // a development build
    expect(releaseNotesFor('../../secrets', read)).toBeNull()
  })

  it('works on the real notes of a shipped release', () => {
    const lines = whatsNewLines(shipped)
    expect(lines[0]).toBe('Report a bug from inside the app.')
    expect(lines.every((l) => !/[*`[\]]/.test(l))).toBe(true)
  })

  it('links to the release on GitHub', () => {
    expect(releaseNotesUrl('2.0.0-alpha.16')).toBe('https://github.com/quikmn/iskra-voice/releases/tag/v2.0.0-alpha.16')
  })
})

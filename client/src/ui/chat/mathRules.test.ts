import { describe, expect, it } from 'vitest'
import { inlineMathAt, splitDisplayMath } from './mathRules'

/** Every inline math span in a text, as its TeX. */
function spans(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    const m = inlineMathAt(text, i)
    if (m) {
      out.push(m.tex)
      i = m.end - 1
    }
  }
  return out
}

describe('inline math', () => {
  it.each([
    ['It costs $5 and $10.', []],
    ['$5, $10 or $15', []],
    ['$5/$10', []],
    ['it was $20 - $30 last year', []],
    ['between $3.50 and $4', []],
    ['I have $ 5 and $ 6', []],
    ['$x^2$', ['x^2']],
    ['so $a + b$ is $c$.', ['a + b', 'c']],
    ['$\\$5$ in math', ['\\$5']],
    ['\\$x$ is escaped', []],
    ['$x $', []], // a space before the closing $
    ['$x$5', []], // a digit right after it
    ['$a\nb$', []], // one line only
    ['$$x$$', []], // that's a block
    ['price $2x$ dollars', ['2x']],
    ['Tickets are $5 and $10, and Euler: $e^{i} + 1 = 0$ ok', ['e^{i} + 1 = 0']],
    ['from $5 to $x$', ['x']],
  ])('%s', (text, expected) => expect(spans(text)).toEqual(expected))
})

describe('display math', () => {
  it('splits blocks out, across lines', () => {
    expect(splitDisplayMath('before\n$$\n\\int_0^1 x\\,dx\n$$\nafter')).toEqual([
      { kind: 'text', text: 'before\n' },
      { kind: 'math', tex: '\\int_0^1 x\\,dx' },
      { kind: 'text', text: 'after' },
    ])
    expect(splitDisplayMath('$$a$$ and $$b$$')).toEqual([{ kind: 'math', tex: 'a' }, { kind: 'text', text: ' and ' }, { kind: 'math', tex: 'b' }])
  })

  it('leaves money and odd dollars alone', () => {
    expect(splitDisplayMath('I paid $$5 and $$10')).toEqual([{ kind: 'text', text: 'I paid $$5 and $$10' }])
    expect(splitDisplayMath('$$ $$')).toEqual([{ kind: 'text', text: '$$ $$' }])
    expect(splitDisplayMath('echo $$')).toEqual([{ kind: 'text', text: 'echo $$' }])
    expect(splitDisplayMath('\\$$x$$')).toEqual([{ kind: 'text', text: '\\$$x$$' }])
    expect(splitDisplayMath('')).toEqual([{ kind: 'text', text: '' }])
  })
})

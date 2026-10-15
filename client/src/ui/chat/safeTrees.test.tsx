// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { hastToReact, mathmlToReact, type HastNode } from './safeTrees'
import { highlightCode, renderMath } from './richEngines'

const html = (node: unknown) => renderToStaticMarkup(<>{node as never}</>)

describe('MathML allowlist', () => {
  it('keeps what temml makes', () => {
    const out = html(mathmlToReact('<math display="block" class="tml-display" style="display:block math;"><mfrac><mi>a</mi><mn class="tml-sml-pad">2</mn></mfrac><mo stretchy="false">+</mo></math>'))
    expect(out).toBe('<math display="block" class="tml-display" style="display:block math"><mfrac><mi>a</mi><mn class="tml-sml-pad">2</mn></mfrac><mo stretchy="false">+</mo></math>')
  })

  it.each([
    ['<math><mi onclick="alert(1)" onmouseover="x()">x</mi></math>', '<math><mi>x</mi></math>'],
    ['<math><script>alert(1)</script><mi>x</mi></math>', '<math><mi>x</mi></math>'],
    ['<math><mi href="javascript:alert(1)" xlink:href="javascript:alert(1)">x</mi></math>', '<math><mi>x</mi></math>'],
    ['<math><maction actiontype="statusline"><mi>x</mi><mtext>evil</mtext></maction></math>', '<math></math>'],
    ['<math><mi style="background:url(https://evil.example/x.png);color:red">x</mi></math>', '<math><mi style="color:red">x</mi></math>'],
    ['<math><mi style="color:expression(alert(1))">x</mi></math>', '<math><mi>x</mi></math>'],
    ['<math><mi style="position:fixed;inset:0;z-index:9999">x</mi></math>', '<math><mi>x</mi></math>'],
    ['<math><mi style="display:none">x</mi></math>', '<math><mi>x</mi></math>'],
    ['<math><mi class="modal-backdrop tml-small">x</mi></math>', '<math><mi class="tml-small">x</mi></math>'],
    ['<math><mi mathcolor="red;background:url(x)">x</mi><mi mathcolor="#f00">y</mi></math>', '<math><mi>x</mi><mi mathcolor="#f00">y</mi></math>'],
    ['<math><mtext><img src=x onerror=alert(1)>hi</mtext></math>', '<math><mtext>hi</mtext></math>'],
    ['<math><annotation-xml encoding="text/html"><a href="https://evil.example">x</a></annotation-xml></math>', '<math></math>'],
    ['<math><mi>&lt;script&gt;</mi></math>', '<math><mi>&lt;script&gt;</mi></math>'],
    ['<math><mstyle><mi id="root" name="x" data-x="1" tabindex="0" autofocus>x</mi></mstyle></math>', '<math><mstyle><mi>x</mi></mstyle></math>'],
  ])('%s', (input, expected) => expect(html(mathmlToReact(input))).toBe(expected))

  it('refuses anything but one <math>', () => {
    expect(mathmlToReact('<span class="temml-error">oops</span>')).toBeNull()
    expect(mathmlToReact('<math><mi>a</mi></math><img src=x onerror=alert(1)>')).toBeNull()
    expect(mathmlToReact('<svg><math><mi>a</mi></math></svg>')).toBeNull()
    expect(mathmlToReact('')).toBeNull()
  })
})

describe('code tree allowlist', () => {
  it('keeps spans with highlight.js classes and text, nothing else', () => {
    const tree: HastNode = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'span', properties: { className: ['hljs-keyword'] }, children: [{ type: 'text', value: 'const' }] },
        { type: 'text', value: ' x = ' },
        { type: 'element', tagName: 'span', properties: { className: ['hljs-title', 'function_', 'evil class', 'x" onclick="y'] }, children: [{ type: 'text', value: '<b>f</b>' }] },
        { type: 'element', tagName: 'a', properties: { href: 'javascript:alert(1)' }, children: [{ type: 'text', value: 'gone' }] },
        { type: 'element', tagName: 'span', properties: { className: ['hljs-x'], onClick: 'alert(1)', style: 'color:red' }, children: [] },
        { type: 'raw', value: '<script>alert(1)</script>' } as HastNode,
        { type: 'comment', value: 'x' } as HastNode,
      ],
    }
    expect(html(hastToReact(tree))).toBe('<span class="hljs-keyword">const</span> x = <span class="hljs-title function_">&lt;b&gt;f&lt;/b&gt;</span><span class="hljs-x"></span>')
  })
})

describe('the engines', () => {
  it('highlight a tagged language and guess common ones', () => {
    expect(html(highlightCode('const x = "<img src=x onerror=alert(1)>"', 'js'))).toContain('<span class="hljs-string">&quot;&lt;img src=x onerror=alert(1)&gt;&quot;</span>')
    expect(highlightCode('x', 'not-a-language')).toBeNull()
    const python = 'def greet(name):\n    """Say hi."""\n    for i in range(3):\n        print(f"hi {name}")\n    return None\n'
    expect(html(highlightCode(python, ''))).toContain('hljs-keyword')
    expect(highlightCode('see you at eight, bring snacks', '')).toBeNull() // prose stays plain
  })

  it('render math to safe MathML, and refuse what would reach out', () => {
    expect(html(renderMath('\\frac{a}{b}', false))).toMatch(/^<math><mfrac><mi>a<\/mi><mi>b<\/mi><\/mfrac><\/math>$/)
    expect(html(renderMath('x^2', true))).toContain('display="block"')
    expect(renderMath('\\frac{', false)).toBeNull()
    for (const evil of ['\\href{javascript:alert(1)}{x}', '\\url{javascript:alert(1)}', '\\includegraphics{https://evil.example/x.png}', '\\htmlClass{modal}{x}', '\\class{modal}{x}']) {
      const out = html(renderMath(evil, false))
      expect(out).not.toMatch(/href|src=|javascript|modal|<a|<img/i)
    }
  })
})

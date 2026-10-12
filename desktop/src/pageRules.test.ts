import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { MAX_PREVIEW_URL, pageRequestAllowed, pageViewSource, PREVIEW_PREFIX } from './pageRules'

const PAGE = 'http://localhost:47070/pages/AAAAAAAAAAAAAAAAAAAAAA?scripts=1'

test('a page view only opens a published page with scripts, or a preview', () => {
  assert.deepEqual(pageViewSource(PAGE), { kind: 'page', url: PAGE })
  assert.deepEqual(pageViewSource('https://chat.example.com/pages/AAAAAAAAAAAAAAAAAAAAAA?scripts=1')?.kind, 'page')
  for (const bad of [
    'http://localhost:47070/pages/AAAAAAAAAAAAAAAAAAAAAA', // without scripts it's the plain frame's job
    'http://localhost:47070/pages/AAAAAAAAAAAAAAAAAAAAAA?scripts=1&x=1',
    'http://localhost:47070/pages/AAAAAAAAAAAAAAAAAAAAAA?scripts=1#x',
    'http://user:pw@localhost:47070/pages/AAAAAAAAAAAAAAAAAAAAAA?scripts=1',
    'http://localhost:47070/pages/short?scripts=1',
    'http://localhost:47070/files/AAAAAAAAAAAAAAAAAAAAAA?scripts=1',
    'http://localhost:47070/pages/../files/AAAAAAAAAAAAAAAAAAAAAA?scripts=1',
    'file:///C:/pages/AAAAAAAAAAAAAAAAAAAAAA?scripts=1',
    'app://iskra/index.html',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    `${PREVIEW_PREFIX}not base64!`,
    PREVIEW_PREFIX + 'A'.repeat(MAX_PREVIEW_URL),
    42,
    null,
  ]) assert.equal(pageViewSource(bad), null, String(bad))
  assert.deepEqual(pageViewSource(`${PREVIEW_PREFIX}PGgxPmhpPC9oMT4=`)?.kind, 'preview')
})

test("a page's session lets through only its own document and its server's images", () => {
  assert.equal(pageRequestAllowed(PAGE, PAGE, 'mainFrame', 'GET'), true)
  assert.equal(pageRequestAllowed(PAGE, 'http://localhost:47070/files/AAAAAAAAAAAAAAAAAAAAAA/cat.png', 'image', 'GET'), true)
  assert.equal(pageRequestAllowed(PAGE, PAGE, 'mainFrame', 'POST'), false)
  assert.equal(pageRequestAllowed(PAGE, 'http://localhost:47070/pages/BBBBBBBBBBBBBBBBBBBBBB?scripts=1', 'mainFrame', 'GET'), false)
  assert.equal(pageRequestAllowed(PAGE, PAGE, 'subFrame', 'GET'), false)
  assert.equal(pageRequestAllowed(PAGE, 'http://localhost:47070/files/AAAAAAAAAAAAAAAAAAAAAA/cat.png', 'xhr', 'GET'), false)
  assert.equal(pageRequestAllowed(PAGE, 'http://localhost:47071/files/AAAAAAAAAAAAAAAAAAAAAA/cat.png', 'image', 'GET'), false)
  assert.equal(pageRequestAllowed(PAGE, 'http://127.0.0.1:47070/files/AAAAAAAAAAAAAAAAAAAAAA/cat.png', 'image', 'GET'), false)
  assert.equal(pageRequestAllowed(PAGE, 'http://localhost:47070/api/AAAAAAAAAAAAAAAAAAAAAA', 'image', 'GET'), false)
  assert.equal(pageRequestAllowed(PAGE, 'ws://localhost:47070/files/AAAAAAAAAAAAAAAAAAAAAA', 'webSocket', 'GET'), false)
  // A preview needs nothing at all.
  assert.equal(pageRequestAllowed(null, PAGE, 'mainFrame', 'GET'), false)
  assert.equal(pageRequestAllowed(null, 'http://127.0.0.1:1/x.png', 'image', 'GET'), false)
})

test('opaque origins never match each other (security review)', () => {
  const preview = 'data:text/html;charset=utf-8;base64,PGgxPmhpPC9oMT4='
  assert.equal(pageRequestAllowed(preview, 'file:///files/AAAAAAAAAAAAAAAAAAAA', 'image', 'GET'), false)
  assert.equal(pageRequestAllowed(preview, 'app://iskra/files/AAAAAAAAAAAAAAAAAAAA', 'image', 'GET'), false)
  assert.equal(pageRequestAllowed('app://iskra/x', 'app://iskra/files/AAAAAAAAAAAAAAAAAAAA', 'image', 'GET'), false)
})

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { MAX_PREVIEW_URL, pageFetchAllowed, pageRequestAllowed, pageViewSource, PREVIEW_PREFIX } from './pageRules'

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

const ACTIVITY = 'http://localhost:47070/activities/AAAAAAAAAAAAAAAAAAAAAA/index.html'

test("an activity view opens only an activity's start page", () => {
  assert.deepEqual(pageViewSource(ACTIVITY), { kind: 'activity', url: ACTIVITY })
  for (const bad of [
    'http://localhost:47070/activities/AAAAAAAAAAAAAAAAAAAAAA/game.html',
    'http://localhost:47070/activities/AAAAAAAAAAAAAAAAAAAAAA/index.html?x=1',
    'http://localhost:47070/activities/AAAAAAAAAAAAAAAAAAAAAA/index.html#x',
    'http://localhost:47070/activities/short/index.html',
    'http://u:p@localhost:47070/activities/AAAAAAAAAAAAAAAAAAAAAA/index.html',
    'file:///activities/AAAAAAAAAAAAAAAAAAAAAA/index.html',
  ]) assert.equal(pageViewSource(bad), null, bad)
})

test("an activity's session lets through only that activity's own files", () => {
  const file = (path: string) => `http://localhost:47070/activities/AAAAAAAAAAAAAAAAAAAAAA/${path}`
  assert.equal(pageRequestAllowed(ACTIVITY, ACTIVITY, 'mainFrame', 'GET'), true)
  for (const type of ['script', 'stylesheet', 'image', 'font', 'media']) assert.equal(pageRequestAllowed(ACTIVITY, file('a/b.js'), type, 'GET'), true, type)
  assert.equal(pageRequestAllowed(ACTIVITY, file('game.js'), 'script', 'POST'), false)
  for (const type of ['xhr', 'webSocket', 'subFrame', 'ping', 'object', 'other']) assert.equal(pageRequestAllowed(ACTIVITY, file('game.js'), type, 'GET'), false, type)
  // Another activity, another server, the server's other paths, hidden files, queries.
  assert.equal(pageRequestAllowed(ACTIVITY, 'http://localhost:47070/activities/BBBBBBBBBBBBBBBBBBBBBB/game.js', 'script', 'GET'), false)
  assert.equal(pageRequestAllowed(ACTIVITY, 'http://127.0.0.1:47070/activities/AAAAAAAAAAAAAAAAAAAAAA/game.js', 'script', 'GET'), false)
  assert.equal(pageRequestAllowed(ACTIVITY, 'http://localhost:47070/files/AAAAAAAAAAAAAAAAAAAAAA/cat.png', 'image', 'GET'), false)
  assert.equal(pageRequestAllowed(ACTIVITY, file('.env'), 'script', 'GET'), false)
  assert.equal(pageRequestAllowed(ACTIVITY, file('game.js?x=1'), 'script', 'GET'), false)
  assert.equal(pageRequestAllowed(ACTIVITY, 'https://evil.example/x.js', 'script', 'GET'), false)
  // The app's fetches for the view: the same files, and for pages still only their images.
  assert.equal(pageFetchAllowed(ACTIVITY, file('sounds/pop.mp3')), true)
  assert.equal(pageFetchAllowed(ACTIVITY, 'http://localhost:47070/health'), false)
  assert.equal(pageFetchAllowed(PAGE, 'http://localhost:47070/files/AAAAAAAAAAAAAAAAAAAAAA/cat.png'), true)
  assert.equal(pageFetchAllowed(PAGE, 'http://localhost:47070/activities/AAAAAAAAAAAAAAAAAAAAAA/index.html'), false)
})

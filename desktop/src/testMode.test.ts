import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BLANK_THUMBNAIL, OFFSCREEN, pickerChoices, placeInArea, realScreenThumbnails, testWindowArea, thumbnailSize } from './testMode'

test('the test window area is read only from a valid env var, never in a packaged app', () => {
  assert.deepEqual(testWindowArea({ ISKRA_E2E_WINDOW_AREA: '1920,0,2560,1400' }, false), { x: 1920, y: 0, width: 2560, height: 1400 })
  assert.deepEqual(testWindowArea({ ISKRA_E2E_WINDOW_AREA: ' -1280, 200 ,1280,984 ' }, false), { x: -1280, y: 200, width: 1280, height: 984 })
  assert.equal(testWindowArea({ ISKRA_E2E_WINDOW_AREA: 'offscreen' }, false), 'offscreen')
  assert.equal(testWindowArea({ ISKRA_E2E_WINDOW_AREA: '1920,0,2560,1400' }, true), null)
  assert.equal(testWindowArea({ ISKRA_E2E_WINDOW_AREA: 'offscreen' }, true), null)
  assert.equal(testWindowArea({}, false), null)
  assert.equal(testWindowArea({ ISKRA_E2E_WINDOW_AREA: '' }, false), null)
  assert.equal(testWindowArea({ ISKRA_E2E_WINDOW_AREA: '1,2,3' }, false), null)
  assert.equal(testWindowArea({ ISKRA_E2E_WINDOW_AREA: '1,2,0,4' }, false), null)
  assert.equal(testWindowArea({ ISKRA_E2E_WINDOW_AREA: '1,2,3.5,4' }, false), null)
  assert.equal(testWindowArea({ ISKRA_E2E_WINDOW_AREA: 'a,b,c,d' }, false), null)
  assert.equal(testWindowArea({ ISKRA_E2E_WINDOW_AREA: 'primary' }, false), null)
})

test('a test window is centred in the area', () => {
  const area = { x: 1920, y: 40, width: 2560, height: 1400 }
  assert.deepEqual(placeInArea({ width: 1280, height: 800 }, area), { x: 1920 + 640, y: 40 + 300, width: 1280, height: 800 })
  assert.deepEqual(placeInArea({ width: 360, height: 250 }, area), { x: 1920 + 1100, y: 40 + 575, width: 360, height: 250 })
  // Monitors left of or above the primary have negative coordinates.
  assert.deepEqual(placeInArea({ width: 101, height: 101 }, { x: -1000, y: -500, width: 1000, height: 500 }), { x: -1000 + 449, y: -500 + 199, width: 101, height: 101 })
})

test('a test window bigger than the area is shrunk to fit it', () => {
  const area = { x: 0, y: 0, width: 1024, height: 728 }
  assert.deepEqual(placeInArea({ width: 1280, height: 800 }, area), { x: 0, y: 0, width: 1024, height: 728 })
  assert.deepEqual(placeInArea({ width: 1280, height: 600 }, area), { x: 0, y: 64, width: 1024, height: 600 })
  assert.deepEqual(placeInArea({ width: 800, height: 900 }, { x: 100, y: 50, width: 1024, height: 728 }), { x: 100 + 112, y: 50, width: 800, height: 728 })
})

test('offscreen keeps the size and puts the window far from every monitor', () => {
  const placed = placeInArea({ width: 1280, height: 800 }, 'offscreen')
  assert.deepEqual(placed, { ...OFFSCREEN, width: 1280, height: 800 })
  assert.ok(placed.x + placed.width < -10000 && placed.y + placed.height < -10000)
  assert.ok(placed.x > -32767 && placed.y > -32767)
})

test('test runs never show real screen thumbnails unless a spec opts in to real capture', () => {
  assert.equal(realScreenThumbnails({}, false), true)
  assert.equal(realScreenThumbnails({ ISKRA_E2E: '1' }, true), true) // a packaged app is never a test run
  assert.equal(realScreenThumbnails({ ISKRA_E2E: '1' }, false), false)
  assert.equal(realScreenThumbnails({ ISKRA_E2E_WINDOW_AREA: 'offscreen' }, false), false)
  assert.equal(realScreenThumbnails({ ISKRA_E2E_WINDOW_AREA: 'primary' }, false), false)
  assert.equal(realScreenThumbnails({ ISKRA_E2E: '1', ISKRA_E2E_SPEAKERS: '1' }, false), true)
  assert.deepEqual(thumbnailSize(false), { width: 0, height: 0 })
  const real = 'data:image/png;base64,REALSCREEN'
  const sources = [{ id: 'screen:0:0', name: 'Entire screen', thumbnail: { toDataURL: () => real } }, { id: 'window:1:0', name: 'Notes', thumbnail: { toDataURL: () => real } }]
  const fake = pickerChoices(sources, false)
  assert.deepEqual(fake.map((c) => [c.id, c.isScreen]), [['screen:0:0', true], ['window:1:0', false]])
  assert.ok(fake.every((c) => c.thumbnail === BLANK_THUMBNAIL))
  assert.ok(pickerChoices(sources, true).every((c) => c.thumbnail === real))
})

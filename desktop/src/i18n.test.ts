import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DESKTOP_TEXT, languageFromLocales, parseLanguage } from './i18n'
import { aboutDetail, parseDesktopSettings, trayMenu } from './platform'

/** Every key in both languages, with functions called on sample arguments. */
function flatten(tree: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'function') out[path] = String(value('@1', '@2', '@3'))
    else if (typeof value === 'string') out[path] = value
    else flatten(value, path, out)
  }
  return out
}

test('Swedish has every desktop text, none empty, with the same placeholders', () => {
  const en = flatten(DESKTOP_TEXT.en)
  const sv = flatten(DESKTOP_TEXT.sv)
  assert.deepEqual(Object.keys(sv).sort(), Object.keys(en).sort())
  for (const [key, text] of Object.entries(sv)) {
    assert.ok(text.trim(), key)
    for (const arg of ['@1', '@2', '@3']) assert.equal(text.includes(arg), en[key].includes(arg), `${key}: ${arg}`)
  }
  assert.equal(DESKTOP_TEXT.sv.about.buttons.length, DESKTOP_TEXT.en.about.buttons.length)
})

test('the OS language picks Swedish or English', () => {
  assert.equal(languageFromLocales(['sv-SE', 'en-US']), 'sv')
  assert.equal(languageFromLocales(['de-DE', 'sv_FI']), 'sv')
  assert.equal(languageFromLocales(['en-GB', 'sv-SE']), 'en')
  assert.equal(languageFromLocales(['fr-FR']), 'en')
  assert.equal(languageFromLocales([]), 'en')
  assert.equal(parseLanguage('sv'), 'sv')
  assert.equal(parseLanguage('de'), null)
  assert.equal(parseDesktopSettings({ language: 'sv' }).language, 'sv')
  assert.equal(parseDesktopSettings({ language: 42 }).language, null)
})

test('the tray and About box in Swedish', () => {
  const labels = trayMenu({ state: 'none' }, false, true, DESKTOP_TEXT.sv).filter((i) => i.action).map((i) => i.label)
  assert.deepEqual(labels, ['Öppna Iskra', 'Om Iskra', 'Sök efter uppdateringar', 'Avsluta Iskra'])
  assert.equal(trayMenu({ state: 'ready', version: '2.1.0' }, false, true, DESKTOP_TEXT.sv)[3].label, 'Starta om och uppdatera till 2.1.0')
  const about = aboutDetail({ app: '2.0.0', electron: '44', chrome: '140', node: '24' }, 'win32', 'x64', DESKTOP_TEXT.sv)
  assert.match(about, /^Version 2\.0\.0 \(Windows, x64\)/)
  assert.match(about, /Röst- och textchatt/)
})

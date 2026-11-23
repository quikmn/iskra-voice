import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DESKTOP_TEXT, languageFromLocales, parseLanguage, setDesktopLanguage, text, textFor } from './i18n'
import { parseDesktopSettings, trayMenu } from './platform'

/** Every key of a language, with functions called on sample arguments. */
function flatten(tree: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'function') out[path] = String(value('@1', '@2', '@3'))
    else if (typeof value === 'string') out[path] = value
    else flatten(value, path, out)
  }
  return out
}

const en = flatten(DESKTOP_TEXT.en)
const others = Object.keys(DESKTOP_TEXT).filter((code) => code !== 'en')

test('every file in text/ is loaded under its code', () => {
  const files = readdirSync(join(__dirname, 'text')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort()
  assert.deepEqual(Object.keys(DESKTOP_TEXT).sort(), files)
  for (const code of files) assert.match(code, /^[a-z]{2,3}$/)
  assert.ok(others.includes('sv'))
})

for (const code of others) {
  test(`${code} has every desktop text, none empty, with the same arguments, and keeps the name Iskra`, () => {
    const texts = flatten(DESKTOP_TEXT[code])
    assert.deepEqual(Object.keys(texts).sort(), Object.keys(en).sort())
    for (const [key, value] of Object.entries(texts)) {
      assert.ok(value.trim(), `${code}:${key} is empty`)
      assert.equal(value, value.trim(), `${code}:${key} starts or ends with a space`)
      for (const arg of ['@1', '@2', '@3']) assert.equal(value.includes(arg), en[key].includes(arg), `${code}:${key}: ${arg}`)
      if (en[key].includes('Iskra')) assert.ok(value.includes('Iskra'), `${code}:${key} lost the name Iskra`)
    }
  })
}

test('the OS language picks a language we have text for, else English', () => {
  assert.equal(languageFromLocales(['sv-SE', 'en-US']), 'sv')
  assert.equal(languageFromLocales(['xx-XX', 'sv_FI']), 'sv')
  assert.equal(languageFromLocales(['en-GB', 'sv-SE']), 'en')
  assert.equal(languageFromLocales(['xx-XX']), 'en')
  assert.equal(languageFromLocales(['constructor', 'toString']), 'en')
  assert.equal(languageFromLocales([]), 'en')
})

test("the page's language is kept by code, and one without desktop text shows English", () => {
  assert.equal(parseLanguage('sv'), 'sv')
  assert.equal(parseLanguage('xx'), 'xx')
  for (const bad of ['', 'SV', 'sv-SE', '../sv', 'constructor', 42, null, undefined]) assert.equal(parseLanguage(bad), null)
  assert.equal(parseDesktopSettings({ language: 'sv' }).language, 'sv')
  assert.equal(parseDesktopSettings({ language: 42 }).language, null)
  assert.equal(textFor('sv'), DESKTOP_TEXT.sv)
  assert.equal(textFor('xx'), DESKTOP_TEXT.en)
  assert.equal(textFor('toString'), DESKTOP_TEXT.en)
  setDesktopLanguage('xx')
  assert.equal(text().tray.open, 'Open Iskra')
  setDesktopLanguage('sv')
  assert.equal(text().tray.open, 'Öppna Iskra')
  setDesktopLanguage('en')
})

test('the tray in Swedish', () => {
  const labels = trayMenu({ state: 'none' }, false, true, DESKTOP_TEXT.sv).filter((i) => i.action).map((i) => i.label)
  assert.deepEqual(labels, ['Öppna Iskra', 'Om Iskra', 'Sök efter uppdateringar', 'Avsluta Iskra'])
  assert.equal(trayMenu({ state: 'ready', version: '2.1.0' }, false, true, DESKTOP_TEXT.sv)[3].label, 'Starta om och uppdatera till 2.1.0')
})

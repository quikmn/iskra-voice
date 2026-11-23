// The phone apps list the app's languages too. iOS only tells the page about languages the app says it has
// (`navigator.language` in the web view), so a language missing from Info.plist never gets picked by "Automatic".
// Android takes the voice notification's texts from res/values-<code>/strings.xml.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LANGUAGE_REGISTRY, SOURCE_LANGUAGE } from './languages'

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../mobile')
const shipped = LANGUAGE_REGISTRY.filter((l) => l.shipped)

/** The strings of the `CFBundleLocalizations` array in an Info.plist. */
function plistLocalizations(file: string): string[] {
  const text = readFileSync(resolve(MOBILE, file), 'utf8')
  const array = /<key>CFBundleLocalizations<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)
  return [...(array?.[1] ?? '').matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1])
}

/** What iOS calls a language: the code, or the locale where the catalog is one country's variant (pt → pt-BR). */
const iosName = (l: { code: string; locale: string }) => (l.code === 'pt' ? l.locale : l.code)

describe('the phone apps', () => {
  it.each(['ios/App/App/Info.plist', 'ios/App/ShareExtension/Info.plist'])('%s lists every shipped language', (file) => {
    expect(plistLocalizations(file).sort()).toEqual(shipped.map(iosName).sort())
  })

  it('Android has the voice notification texts in every shipped language', () => {
    const names = (file: string) => [...readFileSync(file, 'utf8').matchAll(/<string name="([^"]+)"(?![^>]*translatable="false")[^>]*>([^<]*)</g)]
    const res = resolve(MOBILE, 'android/app/src/main/res')
    const english = names(resolve(res, 'values/strings.xml')).map((m) => m[1]).sort()
    expect(english.length).toBeGreaterThan(0)
    for (const { code } of shipped) {
      if (code === SOURCE_LANGUAGE) continue
      const file = resolve(res, `values-${code}/strings.xml`)
      expect(existsSync(file), file).toBe(true)
      const found = names(file)
      expect(found.map((m) => m[1]).sort(), code).toEqual(english)
      for (const [, name, text] of found) expect(text.trim(), `${code} ${name}`).not.toBe('')
    }
  })
})

// The phone apps list the app's languages too. iOS only tells the page about languages the app says it has
// (`navigator.language` in the web view), so a language missing from Info.plist never gets picked by "Automatic".
// Android takes the voice notification's texts from res/values-<code>/strings.xml.
import { describe, expect, it } from 'vitest'
import { LANGUAGE_REGISTRY, SOURCE_LANGUAGE } from './languages'

const PLISTS = import.meta.glob('../../../mobile/ios/App/{App,ShareExtension}/Info.plist', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const STRINGS = import.meta.glob('../../../mobile/android/app/src/main/res/values*/strings.xml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const shipped = LANGUAGE_REGISTRY.filter((l) => l.shipped)

/** The strings of the `CFBundleLocalizations` array in an Info.plist. */
function plistLocalizations(text: string): string[] {
  const array = /<key>CFBundleLocalizations<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)
  return [...(array?.[1] ?? '').matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1])
}

/** What iOS calls a language: the code, or the locale where the catalog is one country's variant (pt → pt-BR). */
const iosName = (l: { code: string; locale: string }) => (l.code === 'pt' ? l.locale : l.code)

/** The translatable texts of a strings.xml, as [name, text]. */
const texts = (xml: string) => [...xml.matchAll(/<string name="([^"]+)"(?![^>]*translatable="false")[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]] as const)

describe('the phone apps', () => {
  it('both iOS Info.plist files list every shipped language', () => {
    expect(Object.keys(PLISTS)).toHaveLength(2)
    for (const [file, text] of Object.entries(PLISTS)) expect(plistLocalizations(text).sort(), file).toEqual(shipped.map(iosName).sort())
  })

  it('Android has the voice notification texts in every shipped language', () => {
    const file = (folder: string) => Object.entries(STRINGS).find(([path]) => path.endsWith(`/res/${folder}/strings.xml`))?.[1]
    const english = texts(file('values') ?? '').map(([name]) => name).sort()
    expect(english.length).toBeGreaterThan(0)
    for (const { code } of shipped) {
      if (code === SOURCE_LANGUAGE) continue
      const xml = file(`values-${code}`)
      expect(xml, `res/values-${code}/strings.xml`).toBeDefined()
      const found = texts(xml!)
      expect(found.map(([name]) => name).sort(), code).toEqual(english)
      for (const [name, text] of found) expect(text.trim(), `${code} ${name}`).not.toBe('')
    }
  })
})

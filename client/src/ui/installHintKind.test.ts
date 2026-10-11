import { describe, expect, it } from 'vitest'
import { dismissHint, HINT_DISMISSED, hintDismissed, installHintKind, type HintEnv } from './installHintKind'

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36'
const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

const env = (over: Partial<HintEnv>): HintEnv => ({
  userAgent: iphone, maxTouchPoints: 5, standalone: false, referrer: '', desktopApp: false, nativeApp: false, automated: false, ...over,
})

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) }
}

describe('install hint', () => {
  it('tells iPhone and iPad browsers to add Iskra to the Home Screen', () => {
    expect(installHintKind(env({}))).toBe('ios')
    // iPadOS says "Macintosh" but has a touch screen; a real Mac doesn't.
    expect(installHintKind(env({ userAgent: ipad, maxTouchPoints: 5 }))).toBe('ios')
    expect(installHintKind(env({ userAgent: ipad, maxTouchPoints: 0 }))).toBeNull()
  })

  it('offers the Android app on Android', () => {
    expect(installHintKind(env({ userAgent: android }))).toBe('android')
  })

  it('stays away from computers, installed apps, the desktop and phone apps and automation', () => {
    expect(installHintKind(env({ userAgent: windows, maxTouchPoints: 0 }))).toBeNull()
    expect(installHintKind(env({ standalone: true }))).toBeNull()
    expect(installHintKind(env({ userAgent: android, standalone: true }))).toBeNull()
    // The Android app (Trusted Web Activity) opens Iskra with an android-app:// referrer.
    expect(installHintKind(env({ userAgent: android, referrer: 'android-app://foo.iskra.app/' }))).toBeNull()
    expect(installHintKind(env({ desktopApp: true }))).toBeNull()
    // The iPhone/iPad app (mobile/) is already the app: no "Add to Home Screen".
    expect(installHintKind(env({ nativeApp: true }))).toBeNull()
    expect(installHintKind(env({ automated: true }))).toBeNull()
  })

  it('remembers dismissal per hint', () => {
    const store = memoryStore()
    expect(hintDismissed(store, 'ios')).toBe(false)
    dismissHint(store, 'ios')
    expect(hintDismissed(store, 'ios')).toBe(true)
    expect(hintDismissed(store, 'android')).toBe(false)
    dismissHint(store, 'ios')
    dismissHint(store, 'android')
    expect(store.data[HINT_DISMISSED]).toBe('ios,android')
    expect(hintDismissed(store, 'android')).toBe(true)
  })

  it('copes with storage that is missing or throws (private mode)', () => {
    const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(hintDismissed(null, 'ios')).toBe(false)
    expect(hintDismissed(throwing, 'ios')).toBe(false)
    expect(() => dismissHint(throwing, 'ios')).not.toThrow()
    expect(() => dismissHint(null, 'ios')).not.toThrow()
  })
})

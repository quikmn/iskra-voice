import { describe, expect, it } from 'vitest'
import { desktopOs, LINKS, RELEASE_VERSION } from './links'

describe('desktop downloads', () => {
  it('picks the app for the visitor', () => {
    expect(desktopOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', 'Win32')).toBe('windows')
    expect(desktopOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 'MacIntel')).toBe('mac')
    expect(desktopOs('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Linux x86_64')).toBe('linux')
    expect(desktopOs('Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 Chrome/140.0', '')).toBe('linux')
  })

  it('offers no app on phones and tablets', () => {
    expect(desktopOs('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36', 'Linux armv81')).toBe('other')
    expect(desktopOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'iPhone')).toBe('other')
    // iPadOS pretends to be a Mac, but has a touch screen.
    expect(desktopOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 'MacIntel', 5)).toBe('other')
  })

  it('links the files the release builds', () => {
    expect(LINKS.macAppleSilicon.endsWith(`/v${RELEASE_VERSION}/Iskra-${RELEASE_VERSION}-mac-arm64.dmg`)).toBe(true)
    expect(LINKS.macIntel).toMatch(/-mac-x64\.dmg$/)
    expect(LINKS.linuxAppImage).toMatch(/-x86_64\.AppImage$/)
    expect(LINKS.linuxDeb).toMatch(/-amd64\.deb$/)
    expect(LINKS.linuxRpm).toMatch(/-x86_64\.rpm$/)
  })
})

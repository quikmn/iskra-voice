import i18next from 'i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DesktopNoticeToast, noticeText } from './DesktopNotices'

describe('the desktop shell’s notices, in the app’s words', () => {
  const en = i18next.getFixedT('en')
  const sv = i18next.getFixedT('sv')

  it('says what "Check for updates" found, per result', () => {
    expect(noticeText({ kind: 'update-check', result: 'found', version: '2.1.0' }, en)).toEqual({
      title: 'Iskra 2.1.0 is downloading',
      body: "It installs in the background. When it's ready, choose Restart to update from the tray menu or the app.",
    })
    expect(noticeText({ kind: 'update-check', result: 'up-to-date', version: '2.0.0' }, en)).toEqual({ title: "You're up to date", body: 'Iskra 2.0.0 is the newest version.' })
    expect(noticeText({ kind: 'update-check', result: 'off', version: '2.0.0' }, en)).toEqual({ title: 'Updates are off in this build', body: "Development builds don't update themselves." })
    expect(noticeText({ kind: 'update-check', result: 'failed', version: '2.0.0' }, en)).toEqual({ title: "Couldn't check for updates", body: 'Check your internet connection and try again.' })
    // And in Swedish, with the version where it belongs.
    expect(noticeText({ kind: 'update-check', result: 'up-to-date', version: '2.0.0' }, sv)).toEqual({ title: 'Du har senaste versionen', body: 'Iskra 2.0.0 är den senaste versionen.' })
    expect(noticeText({ kind: 'update-check', result: 'found', version: '2.1.0' }, sv).title).toBe('Iskra 2.1.0 laddas ner')
  })

  it('About on the first run names the build', () => {
    const about = noticeText({ kind: 'about' }, en)
    expect(about.title).toMatch(/^Iskra \d+\.\d+\.\d+\S* · ([0-9a-f]{7}|dev)$/)
    expect(about.body).toBe('Voice and text chat for friends, on servers you own.') // no shell versions outside the desktop app
  })

  it('renders as the app’s toast: a status with a close button, no raw HTML', () => {
    const html = renderToStaticMarkup(<DesktopNoticeToast notice={{ kind: 'update-check', result: 'up-to-date', version: '2.0.0' }} />)
    expect(html).toContain('role="status"')
    expect(html).toContain('class="update-toast desktop-notice-toast"')
    expect(html).toContain('<strong>You&#x27;re up to date</strong>')
    expect(html).toContain('<span>Iskra 2.0.0 is the newest version.</span>')
    expect(html).toContain('aria-label="Dismiss"')
    const tricky = renderToStaticMarkup(<DesktopNoticeToast notice={{ kind: 'update-check', result: 'found', version: '2.1.0<b>' }} />)
    expect(tricky).not.toContain('<b>')
  })
})

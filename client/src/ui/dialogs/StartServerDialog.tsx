import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { desktopOs, LINKS, type DesktopOs } from '../../links'
import { Modal } from '../bits'

const OS_NAME: Record<Exclude<DesktopOs, 'other'>, string> = { windows: 'Windows', mac: 'Mac', linux: 'Linux' }

function visitorOs(): DesktopOs {
  return typeof navigator === 'undefined' ? 'other' : desktopOs(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)
}

/** Chromium browsers can tell an Intel Mac from Apple silicon; others get Apple silicon first. */
function useMacIntel(active: boolean): boolean {
  const [intel, setIntel] = useState(false)
  useEffect(() => {
    const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> } }).userAgentData
    if (!active || !data?.getHighEntropyValues) return
    let alive = true
    data.getHighEntropyValues(['architecture']).then((v) => alive && setIntel(v.architecture === 'x86'), () => undefined)
    return () => {
      alive = false
    }
  }, [active])
  return intel
}

/** The big download button for this visitor's computer, and the other systems underneath. */
function DesktopDownload({ os }: { os: DesktopOs }) {
  const { t } = useTranslation()
  const intel = useMacIntel(os === 'mac')
  return (
    <>
      {os === 'windows' && <a className="button primary" href={LINKS.windowsInstaller}>{t('settings.start.downloadFor', { os: 'Windows' })}</a>}
      {os === 'mac' && (
        <a className="button primary" href={intel ? LINKS.macIntel : LINKS.macAppleSilicon}>{t('settings.start.downloadFor', { os: intel ? 'Mac (Intel)' : 'Mac' })}</a>
      )}
      {os === 'linux' && <a className="button primary" href={LINKS.linuxAppImage}>{t('settings.start.downloadFor', { os: 'Linux (AppImage)' })}</a>}
      {os === 'other' && <p className="muted">{t('settings.start.otherOs')}</p>}

      <p className="muted download-others">
        {os === 'mac' && <>{intel ? <a href={LINKS.macAppleSilicon}>Apple silicon</a> : <a href={LINKS.macIntel}>Intel Mac</a>} · </>}
        {os === 'linux' && <><a href={LINKS.linuxDeb}>.deb</a> · <a href={LINKS.linuxRpm}>.rpm</a> · </>}
        {os !== 'windows' && <><a href={LINKS.windowsInstaller}>Windows</a> · </>}
        {os !== 'mac' && <><a href={LINKS.macAppleSilicon}>Mac (Apple silicon)</a> · <a href={LINKS.macIntel}>Mac (Intel)</a> · </>}
        {os !== 'linux' && <><a href={LINKS.linuxAppImage}>Linux AppImage</a> · <a href={LINKS.linuxDeb}>.deb</a> · <a href={LINKS.linuxRpm}>.rpm</a> · </>}
        <a href={LINKS.releases} target="_blank" rel="noopener noreferrer">{t('settings.start.allDownloads')}</a>
      </p>

      {os === 'windows' && (
        <p className="muted">{t('settings.start.signed')}</p>
      )}
      {os === 'mac' && <p className="muted">{t('settings.start.macFirst')}</p>}
    </>
  )
}

/** In the browser: how to start your own server (the desktop app can do it in one click). */
export function StartServerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [os] = useState(visitorOs)
  return (
    <Modal title={t('settings.start.title')} onClose={onClose}>
      <section className="guide-option">
        <h3>{os !== 'other' ? t('settings.start.easiestFor', { os: OS_NAME[os] }) : t('settings.start.easiest')}</h3>
        <ol>
          <li>{t('settings.start.step1')}</li>
          <li><Trans i18nKey="settings.start.step2" components={{ b: <strong /> }} /></li>
          <li><Trans i18nKey="settings.start.step3" components={{ b: <strong /> }} /></li>
        </ol>
        <DesktopDownload os={os} />
      </section>

      <section className="guide-option">
        <h3>{t('settings.start.selfTitle')}</h3>
        <ol>
          <li>
            <Trans i18nKey="settings.start.self1" components={{
              win: <a href={LINKS.serverWindows} />, linux: <a href={LINKS.serverLinux} />,
              arm: <a href={LINKS.serverMacAppleSilicon} />, intel: <a href={LINKS.serverMacIntel} />,
            }} />
          </li>
          <li>
            <Trans i18nKey="settings.start.self2" components={{ code: <code /> }} />
          </li>
          <li>{t('settings.start.self3')}</li>
        </ol>
        <p className="muted">
          <Trans i18nKey="settings.start.https" components={{ code: <code /> }} />{' '}
          <a href={LINKS.hostingGuide} target="_blank" rel="noopener noreferrer">{t('settings.start.hostingGuide')}</a>
        </p>
      </section>
    </Modal>
  )
}

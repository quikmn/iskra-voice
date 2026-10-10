import { useEffect, useState } from 'react'
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
  const intel = useMacIntel(os === 'mac')
  return (
    <>
      {os === 'windows' && <a className="button primary" href={LINKS.windowsInstaller}>Download Iskra for Windows</a>}
      {os === 'mac' && (
        <a className="button primary" href={intel ? LINKS.macIntel : LINKS.macAppleSilicon}>Download Iskra for Mac{intel ? ' (Intel)' : ''}</a>
      )}
      {os === 'linux' && <a className="button primary" href={LINKS.linuxAppImage}>Download Iskra for Linux (AppImage)</a>}
      {os === 'other' && <p className="muted">The app runs on the Windows, Mac or Linux computer that will host your server.</p>}

      <p className="muted download-others">
        {os === 'mac' && <>{intel ? <a href={LINKS.macAppleSilicon}>Apple silicon</a> : <a href={LINKS.macIntel}>Intel Mac</a>} · </>}
        {os === 'linux' && <><a href={LINKS.linuxDeb}>.deb</a> · <a href={LINKS.linuxRpm}>.rpm</a> · </>}
        {os !== 'windows' && <><a href={LINKS.windowsInstaller}>Windows</a> · </>}
        {os !== 'mac' && <><a href={LINKS.macAppleSilicon}>Mac (Apple silicon)</a> · <a href={LINKS.macIntel}>Mac (Intel)</a> · </>}
        {os !== 'linux' && <><a href={LINKS.linuxAppImage}>Linux AppImage</a> · <a href={LINKS.linuxDeb}>.deb</a> · <a href={LINKS.linuxRpm}>.rpm</a> · </>}
        <a href={LINKS.releases} target="_blank" rel="noopener noreferrer">All downloads</a>
      </p>

      {os === 'windows' && (
        <p className="muted">Signed by Open Source Developer Viktor Lundgren. While the app is new, Windows may still ask once before running it.</p>
      )}
      {os === 'mac' && <p className="muted">The first time, macOS may ask you to confirm: right-click Iskra in Applications and choose Open.</p>}
    </>
  )
}

/** In the browser: how to start your own server (the desktop app can do it in one click). */
export function StartServerDialog({ onClose }: { onClose: () => void }) {
  const [os] = useState(visitorOs)
  return (
    <Modal title="Start your own server" onClose={onClose}>
      <section className="guide-option">
        <h3>Easiest: the Iskra app{os !== 'other' ? ` for ${OS_NAME[os]}` : ''}</h3>
        <ol>
          <li>Download and install Iskra.</li>
          <li>Click <strong>Create a server</strong>. It runs on your computer, voice included, and you're the owner.</li>
          <li>Click <strong>Invite friends</strong> and send them the link.</li>
        </ol>
        <DesktopDownload os={os} />
      </section>

      <section className="guide-option">
        <h3>Or run the server yourself (home PC or a VPS)</h3>
        <ol>
          <li>
            Download the server for <a href={LINKS.serverWindows}>Windows</a>, <a href={LINKS.serverLinux}>Linux</a> or
            Mac (<a href={LINKS.serverMacAppleSilicon}>Apple silicon</a>, <a href={LINKS.serverMacIntel}>Intel</a>) and unpack it.
          </li>
          <li>
            Run <code>iskra-server my-server</code>. It creates a folder called <code>my-server</code> that holds everything.
          </li>
          <li>Open the link it prints to become the owner, then invite your friends.</li>
        </ol>
        <p className="muted">
          For friends joining over the internet from a browser, the server needs HTTPS. It's built in: set your domain in{' '}
          <code>server.json</code> and it gets a free certificate automatically.{' '}
          <a href={LINKS.hostingGuide} target="_blank" rel="noopener noreferrer">Hosting guide</a>
        </p>
      </section>
    </Modal>
  )
}

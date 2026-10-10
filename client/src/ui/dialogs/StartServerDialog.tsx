import { LINKS } from '../../links'
import { Modal } from '../bits'

/** In the browser: how to start your own server (the desktop app can do it in one click). */
export function StartServerDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Start your own server" onClose={onClose}>
      <section className="guide-option">
        <h3>Easiest: the Iskra app for Windows</h3>
        <ol>
          <li>Download and install Iskra.</li>
          <li>Click <strong>Create a server</strong>. It runs on your PC, voice included, and you're the owner.</li>
          <li>Click <strong>Invite friends</strong> and send them the link.</li>
        </ol>
        <a className="button primary" href={LINKS.windowsInstaller}>Download Iskra for Windows</a>
        <p className="muted">
          Signed by Open Source Developer Viktor Lundgren. While the app is new, Windows may still ask once before running it.
        </p>
      </section>

      <section className="guide-option">
        <h3>Or run the server yourself (home PC or a VPS)</h3>
        <ol>
          <li>
            Download the server for <a href={LINKS.serverWindows}>Windows</a> or <a href={LINKS.serverLinux}>Linux</a> and unpack it.
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

import { useEffect, useState } from 'react'
import { LINKS } from '../../links'
import { hostChecklist, hostSummary, lanHost, loadHostStatus, manualForwards, setInternet, useHosting, type Step } from '../../state/hosting'
import type { ServerState } from '../../state/store'
import { Spinner } from '../bits'
import './InternetSettings.css'

function StepIcon({ state }: { state: Step['state'] }) {
  if (state === 'working') return <span className="step-icon working" aria-hidden><Spinner /></span>
  const glyph = state === 'done' ? '✓' : state === 'problem' ? '!' : ''
  return <span className={`step-icon ${state}`} aria-hidden>{glyph}</span>
}

/** "Open to the internet": one switch for the owner, a live checklist, and what to do when it can't work. */
export function InternetSection({ server }: { server: ServerState }) {
  const status = useHosting((s) => s.status[server.key])
  const isOwner = server.me?.role === 'owner'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadHostStatus(server.key).catch((e: Error) => setError(e.message))
  }, [server.key])

  async function change(enabled: boolean) {
    setBusy(true)
    setError(null)
    try {
      await setInternet(server.key, enabled)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return (
      <section className="settings-section internet">
        <h3>Open to the internet</h3>
        {error ? <p className="error-text">{error}</p> : <Spinner />}
      </section>
    )
  }

  const summary = hostSummary(status)
  const steps = hostChecklist(status)
  const forwards = status.enabled && !status.cgnat ? manualForwards(status) : []
  const lan = lanHost(status)

  return (
    <section className="settings-section internet" data-testid="internet-section">
      <h3>Open to the internet</h3>
      <div className="internet-head">
        <div>
          <strong>Let friends anywhere join</strong>
          <p className={`internet-summary ${summary.tone}`}>{summary.text}</p>
        </div>
        <button
          className={`switch ${status.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={status.enabled}
          aria-label="Open to the internet"
          disabled={!isOwner || busy}
          onClick={() => void change(!status.enabled)}
        >
          <span />
        </button>
      </div>
      {!isOwner && <p className="muted">Only the owner can change this.</p>}
      {!status.enabled && isOwner && (
        <p className="muted">
          Iskra asks your router to open the ports, gives your server a free address and a real HTTPS certificate, so
          invite links work for friends anywhere. You can turn it off any time.
        </p>
      )}
      {error && <p className="error-text">{error}</p>}

      {status.enabled && (
        <ol className="checklist" aria-label="Progress">
          {steps.map((step) => (
            <li key={step.id} className={`step ${step.state}`} data-step={step.id} data-state={step.state}>
              <StepIcon state={step.state} />
              <div>
                <span className="step-label">{step.label}</span>
                {step.detail && <span className="step-detail">{step.detail}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}

      {status.enabled && status.cgnat && (
        <div className="internet-callout warn">
          <strong>Your provider shares one internet address between customers</strong>
          <p>
            This is called carrier-grade NAT. Nobody outside can reach a server in your home, whatever the router
            settings. Two good options: ask your provider for a public IPv4 address (often free, sometimes a small
            fee), or run the server on a small VPS, which costs a few euros a month.
          </p>
          <a href={`${LINKS.hostingGuide}#on-a-linux-vps-with-systemd`} target="_blank" rel="noopener noreferrer">How to run it on a VPS</a>
        </div>
      )}

      {forwards.length > 0 && (
        <div className="internet-callout" data-testid="manual-forwards">
          <strong>Forward these ports by hand</strong>
          <p>
            Open your router's settings page (often <code>192.168.1.1</code> or <code>192.168.0.1</code>), find
            "Port forwarding", and add{lan ? <> these, pointing at this computer, <code>{lan}</code></> : ' these, pointing at this computer'}:
          </p>
          <table className="forward-table">
            <thead>
              <tr><th>Outside port</th><th>To port</th><th>Type</th><th>For</th></tr>
            </thead>
            <tbody>
              {forwards.map((f) => (
                <tr key={`${f.protocol}-${f.external}`}>
                  <td>{f.external}</td><td>{f.internal}</td><td>{f.protocol}</td><td>{f.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Or turn on UPnP in the router and Iskra does this for you. Then press Check again.
          </p>
        </div>
      )}

      {status.enabled && status.publicUrl?.startsWith('http://') && (
        <div className="internet-callout" role="alert">
          <strong>This address has no HTTPS</strong>
          <p>
            <code>{status.publicUrl}</code> is set as PublicUrl in server.json. Over plain HTTP, anyone along the way can read
            messages and take over logins. Remove it and let Iskra get a certificate, or put the server behind HTTPS.
          </p>
        </div>
      )}
      {status.enabled && !status.publicUrl && status.address && status.https.state !== 'valid' && (
        <p className="internet-address muted">Waiting for HTTPS. Until then, invite links use your local address.</p>
      )}
      {status.enabled && status.publicUrl?.startsWith('https://') && (
        <p className="internet-address">
          Friends join at <code>{status.publicUrl}</code>. New invite links use it.
          {status.autoAddress && <span className="muted"> If your internet address changes, the address changes too; send new invites then.</span>}
        </p>
      )}

      <div className="internet-actions">
        {status.enabled && isOwner && (
          <button className="button" disabled={busy} onClick={() => void change(true)}>
            {busy ? <Spinner /> : 'Check again'}
          </button>
        )}
        {status.lanUrl && <span className="muted">On your network: <code>{status.lanUrl}</code></span>}
      </div>
    </section>
  )
}

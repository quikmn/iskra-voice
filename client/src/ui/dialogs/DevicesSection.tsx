// Settings → Devices: your devices, renaming, removing, and linking a new one.
import { useEffect, useState } from 'react'
import { refreshDevices, renameDevice, revokeDevice, useDevices, type DeviceView } from '../../state/devices'
import {
  cancelLinkOffer, confirmLinkOffer, linkableServers, startLinkOffer, useLinkOffer,
} from '../../state/link'
import { Modal, Spinner } from '../bits'
import { messageTime } from '../format'
import { Pencil } from '../icons'
import { QrCode } from '../QrCode'

function DeviceRow({ device }: { device: DeviceView }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(device.name)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()

  async function save() {
    if (!trimmed || trimmed === device.name) return setEditing(false)
    setBusy(true)
    await renameDevice(device.deviceKey, trimmed)
    setBusy(false)
    setEditing(false)
  }

  return (
    <li className="device-row">
      <div className="device-text">
        {editing ? (
          <div className="copy-row">
            <input aria-label="Device name" value={name} maxLength={32} autoFocus onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') { e.preventDefault(); setEditing(false) } }} />
            <button className="button small primary" disabled={!trimmed || busy} onClick={() => void save()}>Save</button>
          </div>
        ) : (
          <strong>
            {device.name}
            {device.current && <span className="pill device-current">This device</span>}
          </strong>
        )}
        <span className="muted">
          {device.platform && device.platform !== device.name ? `${device.platform} · ` : ''}
          {device.current ? 'Active now' : `Last seen ${messageTime(device.lastSeen)}`}
        </span>
      </div>
      {!editing && (
        <div className="device-actions">
          <button className="icon-button" aria-label={`Rename ${device.name}`} title="Rename" onClick={() => setEditing(true)}>
            <Pencil size={16} />
          </button>
          {!device.current && (confirming ? (
            <>
              <button className="button small danger" disabled={busy} onClick={async () => { setBusy(true); await revokeDevice(device.deviceKey) }}>
                Remove
              </button>
              <button className="button small" onClick={() => setConfirming(false)}>Keep</button>
            </>
          ) : (
            <button className="button small danger-outline" onClick={() => setConfirming(true)}>Remove</button>
          ))}
        </div>
      )}
    </li>
  )
}

export function DevicesSection() {
  const devices = useDevices((s) => s.devices)
  const loaded = useDevices((s) => s.loaded)
  const [linking, setLinking] = useState(false)
  useEffect(() => void refreshDevices(), [])

  return (
    <section className="settings-section">
      <h3>Devices</h3>
      <p className="muted">Everywhere you're signed in. Removing a device signs it out and stops it getting new messages.</p>
      {!loaded ? <Spinner /> : devices.length === 0 ? (
        <p className="muted">Connect to a server to see your devices.</p>
      ) : (
        <ul className="device-list">
          {devices.map((d) => <DeviceRow key={d.deviceKey} device={d} />)}
        </ul>
      )}
      <button className="button" onClick={() => setLinking(true)}>Link a device</button>
      {linking && <LinkDeviceDialog onClose={() => setLinking(false)} />}
    </section>
  )
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const left = Math.max(0, Math.round((until - now) / 1000))
  return <>{left > 0 ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Expired'}</>
}

/** The existing device's side: show the code, check the confirmation, send the account. */
export function LinkDeviceDialog({ onClose }: { onClose: () => void }) {
  const state = useLinkOffer()
  const servers = linkableServers()
  const [serverKey, setServerKey] = useState(servers[0]?.key ?? '')
  const [history, setHistory] = useState(true)
  const [copied, setCopied] = useState(false)
  const [typed, setTyped] = useState('')

  useEffect(() => () => void cancelLinkOffer(), [])

  function close() {
    void cancelLinkOffer()
    onClose()
  }

  return (
    <Modal title="Link a device" onClose={close}>
      {state.phase === 'idle' && (servers.length === 0 ? (
        <p className="muted">Linking goes through one of your servers. Connect to a server first.</p>
      ) : (
        <>
          <p className="muted">
            Sign in on your phone or another computer without your recovery key. Your account is sent encrypted, straight to the new device.
          </p>
          {servers.length > 1 && (
            <label className="field">
              <span>Through server</span>
              <select value={serverKey} onChange={(e) => setServerKey(e.target.value)}>
                {servers.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
              </select>
            </label>
          )}
          <label className="checkbox field">
            <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
            Also copy recent direct messages
          </label>
          <button className="button primary" onClick={() => void startLinkOffer(serverKey, history)}>Show code</button>
        </>
      ))}

      {state.phase === 'creating' && <Spinner />}

      {state.phase === 'waiting' && (
        <div className="link-offer">
          <p>On the new device, open Iskra, choose <strong>I already have Iskra</strong>, and scan this code.</p>
          <QrCode text={state.url} label="Device link QR code" />
          <p className="muted">Or type this code:</p>
          <div className="link-code" data-testid="link-code">{state.text}</div>
          <div className="copy-row">
            <button className="button small" onClick={async () => { await navigator.clipboard.writeText(state.text); setCopied(true) }}>
              {copied ? 'Copied!' : 'Copy code'}
            </button>
            <span className="muted small-text"><Countdown until={state.expiresAt} /> · via {state.serverName}</span>
          </div>
          <p className="warning-text small-text">Anyone with this code can become you. Only use it on your own device.</p>
        </div>
      )}

      {state.phase === 'confirm' && (
        <form className="link-offer" onSubmit={(e) => { e.preventDefault(); void confirmLinkOffer(typed) }}>
          <p>{state.info ? <><strong>{state.info}</strong> wants to link.</> : 'A device wants to link.'} Type the number it shows:</p>
          <input
            className="confirm-code"
            aria-label="Number on the new device"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            placeholder="000 000"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
          />
          <p className="muted">Only your own new device shows this number. Then it gets your account.</p>
          <div className="copy-row">
            <button type="submit" className="button primary" disabled={typed.replace(/\D/g, '').length !== 6}>Link it</button>
            <button type="button" className="button" onClick={close}>Cancel</button>
          </div>
        </form>
      )}

      {state.phase === 'sending' && <p className="muted"><Spinner /> Sending your account…</p>}

      {state.phase === 'done' && (
        <div className="link-offer">
          <p className="success-text">Done! Your account is on the new device.</p>
          <button className="button primary" onClick={() => { onClose(); void refreshDevices() }}>Close</button>
        </div>
      )}

      {state.phase === 'error' && (
        <div className="link-offer">
          <p className="error-text">{state.message}</p>
          <button className="button" onClick={() => void cancelLinkOffer()}>Try again</button>
        </div>
      )}
    </Modal>
  )
}

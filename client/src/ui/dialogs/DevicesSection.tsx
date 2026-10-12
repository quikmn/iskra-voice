// Settings → Devices: your devices, renaming, removing, and linking a new one.
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { refreshDevices, renameDevice, revokeDevice, useDevices, type DeviceView } from '../../state/devices'
import {
  cancelLinkOffer, confirmLinkOffer, linkableServers, startLinkOffer, useLinkOffer,
} from '../../state/link'
import { Modal, Spinner } from '../bits'
import { messageTime } from '../format'
import { Pencil } from '../icons'
import { QrCode } from '../QrCode'
import { SignOutSection } from './SignOut'

function DeviceRow({ device }: { device: DeviceView }) {
  const { t } = useTranslation()
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
            <input aria-label={t('settings.devices.name')} value={name} maxLength={32} autoFocus onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') { e.preventDefault(); setEditing(false) } }} />
            <button className="button small primary" disabled={!trimmed || busy} onClick={() => void save()}>{t('common.save')}</button>
          </div>
        ) : (
          <strong>
            {device.name}
            {device.current && <span className="pill device-current">{t('settings.devices.thisDevice')}</span>}
          </strong>
        )}
        <span className="muted">
          {device.platform && device.platform !== device.name ? `${device.platform} · ` : ''}
          {device.current ? t('settings.devices.activeNow') : t('settings.devices.lastSeen', { when: messageTime(device.lastSeen) })}
        </span>
      </div>
      {!editing && (
        <div className="device-actions">
          <button className="icon-button" aria-label={t('settings.devices.renameNamed', { name: device.name })} title={t('settings.devices.rename')} onClick={() => setEditing(true)}>
            <Pencil size={16} />
          </button>
          {!device.current && (confirming ? (
            <>
              <button className="button small danger" disabled={busy} onClick={async () => { setBusy(true); await revokeDevice(device.deviceKey) }}>
                {t('common.remove')}
              </button>
              <button className="button small" onClick={() => setConfirming(false)}>{t('settings.devices.keep')}</button>
            </>
          ) : (
            <button className="button small danger-outline" onClick={() => setConfirming(true)}>{t('common.remove')}</button>
          ))}
        </div>
      )}
    </li>
  )
}

export function DevicesSection() {
  const { t } = useTranslation()
  const devices = useDevices((s) => s.devices)
  const loaded = useDevices((s) => s.loaded)
  const [linking, setLinking] = useState(false)
  useEffect(() => void refreshDevices(), [])

  return (
    <section className="settings-section">
      <h2>{t('settings.sections.devices')}</h2>
      <p className="muted">{t('settings.devices.intro')}</p>
      {!loaded ? <Spinner /> : devices.length === 0 ? (
        <p className="muted">{t('settings.devices.empty')}</p>
      ) : (
        <ul className="device-list">
          {devices.map((d) => <DeviceRow key={d.deviceKey} device={d} />)}
        </ul>
      )}
      <button className="button" onClick={() => setLinking(true)}>{t('settings.devices.link')}</button>
      {linking && <LinkDeviceDialog onClose={() => setLinking(false)} />}
      <SignOutSection />
    </section>
  )
}

function Countdown({ until }: { until: number }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const left = Math.max(0, Math.round((until - now) / 1000))
  return <>{left > 0 ? t('settings.devices.expiresIn', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` }) : t('settings.devices.expired')}</>
}

/** The existing device's side: show the code, check the confirmation, send the account. */
export function LinkDeviceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
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
    <Modal title={t('settings.devices.link')} onClose={close}>
      {state.phase === 'idle' && (servers.length === 0 ? (
        <p className="muted">{t('settings.devices.linkNoServer')}</p>
      ) : (
        <>
          <p className="muted">{t('settings.devices.linkIntro')}</p>
          {servers.length > 1 && (
            <label className="field">
              <span>{t('settings.devices.throughServer')}</span>
              <select value={serverKey} onChange={(e) => setServerKey(e.target.value)}>
                {servers.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
              </select>
            </label>
          )}
          <label className="checkbox field">
            <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
            {t('settings.devices.bringHistory')}
          </label>
          <button className="button primary" onClick={() => void startLinkOffer(serverKey, history)}>{t('settings.devices.showCode')}</button>
        </>
      ))}

      {state.phase === 'creating' && <Spinner />}

      {state.phase === 'waiting' && (
        <div className="link-offer">
          <p><Trans i18nKey="settings.devices.scanHint" components={{ b: <strong /> }} /></p>
          <QrCode text={state.url} label={t('settings.devices.qrLabel')} />
          <p className="muted">{t('settings.devices.orType')}</p>
          <div className="link-code" data-testid="link-code">{state.text}</div>
          <div className="copy-row">
            <button className="button small" onClick={async () => { await navigator.clipboard.writeText(state.text); setCopied(true) }}>
              {copied ? t('settings.recovery.copied') : t('settings.devices.copyCode')}
            </button>
            <span className="muted small-text"><Countdown until={state.expiresAt} /> · {t('settings.devices.via', { server: state.serverName })}</span>
          </div>
          <p className="warning-text small-text">{t('settings.devices.codeWarning')}</p>
        </div>
      )}

      {state.phase === 'confirm' && (
        <form className="link-offer" onSubmit={(e) => { e.preventDefault(); void confirmLinkOffer(typed) }}>
          <p>{state.info ? <Trans i18nKey="settings.devices.wantsToLink" values={{ device: state.info }} components={{ b: <strong /> }} /> : t('settings.devices.aDeviceWants')} {t('settings.devices.typeNumber')}</p>
          <input
            className="confirm-code"
            aria-label={t('settings.devices.numberLabel')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            placeholder="000 000"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
          />
          <p className="muted">{t('settings.devices.numberHint')}</p>
          <div className="copy-row">
            <button type="submit" className="button primary" disabled={typed.replace(/\D/g, '').length !== 6}>{t('settings.devices.linkIt')}</button>
            <button type="button" className="button" onClick={close}>{t('common.cancel')}</button>
          </div>
        </form>
      )}

      {state.phase === 'sending' && (
        state.total ? (
          <div className="link-progress" role="status">
            <p className="muted"><Spinner /> {t('settings.devices.sendingHistory', { percent: Math.round((100 * (state.sent ?? 0)) / state.total) })}</p>
            <progress max={state.total} value={state.sent ?? 0} aria-label={t('settings.devices.historySent')} />
          </div>
        ) : <p className="muted"><Spinner /> {t('settings.devices.sendingAccount')}</p>
      )}

      {state.phase === 'done' && (
        <div className="link-offer">
          <p className="success-text">{t('settings.devices.linked')}</p>
          {state.warning && <p className="warning-text">{state.warning}</p>}
          <button className="button primary" onClick={() => { onClose(); void refreshDevices() }}>{t('common.close')}</button>
        </div>
      )}

      {state.phase === 'error' && (
        <div className="link-offer">
          <p className="error-text">{state.message}</p>
          <button className="button" onClick={() => void cancelLinkOffer()}>{t('common.tryAgain')}</button>
        </div>
      )}
    </Modal>
  )
}

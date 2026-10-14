// "Connect without port forwarding" (experimental): the owner's switch, what the peer-to-peer network sees, and how
// the host's connection looks (from the desktop app that runs the tunnel, or from a standalone server's own iskra-p2p
// sidecar through p2p.status). Part of Server settings → Internet access.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { HostedServer } from '../../platform/desktop'
import { loadP2pStatus, rotateP2p, setP2p, useP2p } from '../../state/p2p'
import type { ServerState } from '../../state/store'
import { Spinner } from '../bits'

export function P2pSection({ server, here }: { server: ServerState; here: HostedServer | null }) {
  const { t } = useTranslation()
  const isOwner = server.me?.role === 'owner'
  const status = useP2p((s) => s.status[server.key])
  const tunnel = here?.p2p ?? null
  // A standalone server runs the tunnel itself (null when a desktop app hosts it, absent on older servers).
  const own = here ? null : (status?.tunnel ?? null)
  const canSwitch = isOwner && (!!here || !!own)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const enabled = status?.enabled ?? !!server.p2p

  useEffect(() => {
    if (isOwner) loadP2pStatus(server.key).catch((e: Error) => setError(errorMessage(e)))
  }, [server.key, isOwner])

  // The server's own tunnel starts after the switch: follow it (quickly while it starts, then now and then).
  const ownState = enabled ? own?.state : undefined
  useEffect(() => {
    if (!isOwner || !ownState) return
    const timer = setInterval(() => void loadP2pStatus(server.key).catch(() => undefined), ownState === 'starting' ? 1500 : 15_000)
    return () => clearInterval(timer)
  }, [server.key, isOwner, ownState])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const state = !enabled ? 'off' : here ? (tunnel?.state ?? 'starting') : (own?.state ?? 'elsewhere')
  const summary =
    state === 'off' ? t('hosting.p2p.summary.off')
    : state === 'ready' ? t('hosting.p2p.summary.on')
    : state === 'starting' ? t('hosting.p2p.summary.starting')
    : state === 'unavailable' ? t('hosting.p2p.summary.unavailable')
    : state === 'failed' ? t('hosting.p2p.summary.failed', { error: (here ? tunnel?.error : own?.error) ?? '' })
    : state === 'missing' ? t('hosting.p2p.summary.missing')
    : t('hosting.p2p.summary.elsewhere')
  const tone = state === 'ready' ? 'ok' : state === 'off' || state === 'starting' ? '' : 'warn'
  const nat = here ? tunnel?.nat : own?.nat
  const natLine = !nat ? null : !nat.firewalled ? t('hosting.p2p.nat.open') : nat.randomized ? t('hosting.p2p.nat.hard') : t('hosting.p2p.nat.easy')

  return (
    <div className="internet-callout p2p-section" data-testid="p2p-section" data-state={state}>
      <div className="internet-head">
        <div>
          <strong>
            {t('hosting.p2p.title')} <span className="p2p-chip">{t('hosting.p2p.experimental')}</span>
          </strong>
          <p className={`internet-summary ${tone}`}>{summary}</p>
        </div>
        {canSwitch && (
          <button
            className={`switch ${enabled ? 'on' : ''}`}
            role="switch"
            aria-checked={enabled}
            aria-label={t('hosting.p2p.switch')}
            disabled={busy}
            onClick={() => void run(() => setP2p(server.key, !enabled))}
          >
            <span />
          </button>
        )}
      </div>
      <p className="muted small-print" data-testid="p2p-privacy">{t('hosting.p2p.privacy')}</p>
      {isOwner && !here && !own && <p className="muted">{t('hosting.p2p.notHere')}</p>}
      {isOwner && own && !enabled && <p className="muted">{t('hosting.p2p.standalone')}</p>}
      {enabled && (tunnel || status) && (
        <ul className="p2p-facts" data-testid="p2p-facts">
          {state === 'starting' && <li><Spinner /> {t('hosting.p2p.nat.unknown')}</li>}
          {natLine && <li className={nat && nat.randomized ? 'warn' : 'good'} data-nat={!nat?.firewalled ? 'open' : nat?.randomized ? 'hard' : 'easy'}>{natLine}</li>}
          {status && <li>{t('hosting.p2p.connected', { count: status.connected })}</li>}
          {status?.hostKey && <li className="muted"><code>{status.hostKey.slice(0, 16)}…</code> {t('hosting.p2p.hostKey')}</li>}
        </ul>
      )}
      {enabled && canSwitch && (
        <div className="internet-actions">
          <button className="button small" disabled={busy} onClick={() => void run(() => rotateP2p(server.key))}>
            {busy ? <Spinner /> : t('hosting.p2p.rotate')}
          </button>
          <span className="muted">{t('hosting.p2p.rotateHint')}</span>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

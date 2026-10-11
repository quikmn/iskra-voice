// GIF settings: the admin's KLIPY key and mode (Settings → Overview), and each viewer's auto-load choice (Appearance).
import { useState } from 'react'
import { roleRank, type GifMode } from '../../core/protocol'
import { configureGifs, setGifAutoLoad, useGifs, useGifStatus } from '../../state/gifs'
import type { ServerState } from '../../state/store'
import { LINKS } from '../../links'
import './gifs.css'

export function GifSettings({ server }: { server: ServerState }) {
  const status = useGifStatus(server.key)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  if (!server.me || roleRank(server.me.role) < roleRank('admin')) return null
  const enabled = !!status?.enabled
  const mode: GifMode = status?.mode ?? 'direct'

  async function save(change: { key?: string; mode?: GifMode }, done: string) {
    setBusy(true)
    setMessage(null)
    try {
      await configureGifs(server.key, change)
      if (change.key !== undefined) setKey('')
      setMessage({ error: false, text: done })
    } catch (e) {
      setMessage({ error: true, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-subsection gif-settings">
      <h4>GIF picker</h4>
      <p className="muted">
        GIF search uses KLIPY (Google closed Tenor's API in 2026). Get a free API key from KLIPY and paste it here. A test key allows
        100 searches an hour. <a href={LINKS.gifsGuide} target="_blank" rel="noopener noreferrer">How to get a key</a>
      </p>
      <p>Status: <strong>{enabled ? 'On' : 'Off'}</strong></p>
      <div className="copy-row">
        <input
          type="password"
          autoComplete="off"
          value={key}
          placeholder={enabled ? 'Paste a new key to replace it' : 'KLIPY API key'}
          aria-label="KLIPY API key"
          onChange={(e) => setKey(e.target.value.trim())}
          onKeyDown={(e) => e.key === 'Enter' && key && void save({ key }, 'GIFs are on.')}
        />
        <button className="button primary" disabled={busy || !key} onClick={() => void save({ key }, 'GIFs are on.')}>{enabled ? 'Replace key' : 'Turn on'}</button>
        {enabled && <button className="button" disabled={busy} onClick={() => void save({ key: '' }, 'GIFs are off.')}>Turn off</button>}
      </div>

      <fieldset className="gif-mode" disabled={busy}>
        <legend>How apps get GIFs</legend>
        <label className="radio">
          <input type="radio" name={`gif-mode-${server.key}`} checked={mode === 'direct'} onChange={() => void save({ mode: 'direct' }, 'Apps now load GIFs from KLIPY directly.')} />
          <span>
            <span><strong>Direct</strong> (default, as KLIPY's terms ask)</span>
            <span className="muted">
              Members' apps search KLIPY and load GIFs from it themselves. <strong>KLIPY sees your address and searches.</strong> The key is
              sent to members' apps, which is fine for a key made just for this server. GIFs in chat only load after a click, unless someone
              turns on auto-load for themselves.
            </span>
          </span>
        </label>
        <label className="radio">
          <input type="radio" name={`gif-mode-${server.key}`} checked={mode === 'proxy'} onChange={() => void save({ mode: 'proxy' }, 'GIFs now go through this server.')} />
          <span>
            <span><strong>Through this server</strong> (only with KLIPY's written approval)</span>
            <span className="muted">
              The server searches and loads every GIF, so KLIPY only sees the server's address; the key never leaves the server. KLIPY's
              standard terms don't allow this without their written approval: ask developers@klipy.com first.
            </span>
          </span>
        </label>
      </fieldset>
      {message && <p className={message.error ? 'error-text' : 'muted'} role="status">{message.text}</p>}
    </div>
  )
}

/** Settings → Appearance: whether GIFs that come straight from KLIPY load without a click. */
export function GifViewerSettings() {
  const autoLoad = useGifs((s) => s.autoLoad)
  return (
    <section className="settings-section">
      <h3>GIFs</h3>
      <label className="checkbox">
        <input type="checkbox" checked={autoLoad} onChange={(e) => setGifAutoLoad(e.target.checked)} />
        Load GIFs from KLIPY without asking (on servers where apps load GIFs directly; KLIPY then sees your address)
      </label>
    </section>
  )
}

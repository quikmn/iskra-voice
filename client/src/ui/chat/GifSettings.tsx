// Settings → Overview, for admins: turning on the GIF picker with a KLIPY API key (kept on the server only).
import { useState } from 'react'
import { roleRank } from '../../core/protocol'
import { configureGifs, useGifs } from '../../state/gifs'
import type { ServerState } from '../../state/store'
import { LINKS } from '../../links'
import './gifs.css'

export function GifSettings({ server }: { server: ServerState }) {
  const enabled = useGifs((s) => s.enabled[server.key])
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  if (!server.me || roleRank(server.me.role) < roleRank('admin')) return null

  async function save(value: string) {
    setBusy(true)
    setMessage(null)
    try {
      await configureGifs(server.key, value)
      setKey('')
      setMessage({ error: false, text: value ? 'GIFs are on.' : 'GIFs are off.' })
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
        GIF search uses KLIPY (Google closed Tenor's API in 2026). Searches and the GIFs themselves go through this server, so KLIPY only sees
        the server's address, never your members'. Paste a KLIPY API key to turn it on; it stays on the server and is never sent to anyone.
        A test key allows 100 searches an hour (the server caches results for 5 minutes). KLIPY's standard terms ask apps to load GIFs
        directly, so ask them (developers@klipy.com) to approve routing through your server for a production key.
      </p>
      <p>
        Status: <strong>{enabled ? 'On' : 'Off'}</strong>
        {' · '}
        <a href={LINKS.gifsGuide} target="_blank" rel="noopener noreferrer">How to get a key</a>
      </p>
      <div className="copy-row">
        <input
          type="password"
          autoComplete="off"
          value={key}
          placeholder={enabled ? 'Paste a new key to replace it' : 'KLIPY API key'}
          aria-label="KLIPY API key"
          onChange={(e) => setKey(e.target.value.trim())}
          onKeyDown={(e) => e.key === 'Enter' && key && void save(key)}
        />
        <button className="button primary" disabled={busy || !key} onClick={() => void save(key)}>{enabled ? 'Replace key' : 'Turn on'}</button>
        {enabled && <button className="button" disabled={busy} onClick={() => void save('')}>Turn off</button>}
      </div>
      {message && <p className={message.error ? 'error-text' : 'muted'} role="status">{message.text}</p>}
    </div>
  )
}

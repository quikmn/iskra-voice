// Forward a message to a channel you can post in on this server, or to someone as a DM.
import { useState } from 'react'
import { roleRank, type Message } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { useDms } from '../../state/dms'
import { forwardToChannel, forwardToDm } from '../../state/forward'
import { Avatar, Modal } from '../bits'
import { Hash } from '../icons'
import { plainText } from '../markdown'
import { formatSize } from '../chat/helpers'
import './organize.css'

type Target = { kind: 'channel'; id: number; label: string } | { kind: 'dm'; key: string; label: string }

export function ForwardDialog({ server, message, onClose }: { server: ServerState; message: Message; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const friends = useDms((s) => s.friends)
  const me = server.me

  const channels: Target[] = server.channels
    .filter((c) => c.kind === 'text' && me && roleRank(me.role) >= roleRank(c.writeRole))
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ kind: 'channel', id: c.id, label: c.name }))
  const people = new Map<string, string>()
  for (const m of Object.values(server.members)) if (m.accountKey !== me?.accountKey && !m.bot) people.set(m.accountKey, m.name)
  for (const f of Object.values(friends)) if (f.accountKey !== me?.accountKey && !people.has(f.accountKey)) people.set(f.accountKey, f.name)
  const dms: Target[] = [...people].map(([key, label]) => ({ kind: 'dm' as const, key, label })).sort((a, b) => a.label.localeCompare(b.label))
  const q = query.trim().toLowerCase().replace(/^[#@]/, '')
  const shown = [...channels, ...dms].filter((t) => !q || t.label.toLowerCase().includes(q))

  async function send(target: Target) {
    const tag = target.kind === 'channel' ? `c${target.id}` : target.key
    setBusy(tag)
    setError(null)
    try {
      if (target.kind === 'channel') await forwardToChannel(server.key, message, target.id)
      else await forwardToDm(server, message, target.key)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(null)
    }
  }

  const preview = plainText(message.text, { nameOf: (k) => server.members[k]?.name ?? null }).replace(/\s+/g, ' ').slice(0, 140)
  return (
    <Modal title="Forward message" onClose={onClose}>
      <blockquote className="forward-preview">
        {preview || `${message.attachments.length} file${message.attachments.length === 1 ? '' : 's'}`}
      </blockquote>
      <label className="field">
        <span>Send to</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search channels and people" aria-label="Search channels and people" />
      </label>
      <div className="forward-targets" role="list">
        {shown.length === 0 && <p className="muted">Nothing matches.</p>}
        {shown.map((t) => {
          const tag = t.kind === 'channel' ? `c${t.id}` : t.key
          return (
            <div key={tag} className="forward-target" role="listitem">
              {t.kind === 'channel'
                ? <span className="forward-icon"><Hash size={16} /></span>
                : <Avatar name={t.label} accountKey={t.key} size={24} />}
              <span className="forward-name">{t.label}</span>
              {t.kind === 'dm' && <span className="muted forward-kind">Direct message</span>}
              <button className="button small" disabled={busy !== null} onClick={() => void send(t)}
                aria-label={`Forward to ${t.kind === 'channel' ? '#' : ''}${t.label}`}>
                {busy === tag ? 'Sending…' : 'Send'}
              </button>
            </div>
          )
        })}
      </div>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

export const ForwardIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m15 17 5-5-5-5" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" />
  </svg>
)

/** "Forwarded from #channel" above a forwarded message. */
export function ForwardedLine({ label, onOpen }: { label: string | null; onOpen?: () => void }) {
  return (
    <div className="forwarded-line">
      <ForwardIcon size={13} />
      {label ? (
        <>Forwarded from {onOpen ? <button className="link" onClick={onOpen}>{label}</button> : <span>{label}</span>}</>
      ) : 'Forwarded'}
    </div>
  )
}

/** Files in a forwarded DM: links only, opened on click (never loaded on their own, so no server sees you). */
export function ForwardedFiles({ files }: { files: { name: string; url: string; size: number }[] }) {
  return (
    <ul className="forwarded-files">
      {files.map((f) => (
        <li key={f.url}>
          <a href={f.url} target="_blank" rel="noopener noreferrer">{f.name}</a> <span className="muted">{formatSize(f.size)}</span>
        </li>
      ))}
    </ul>
  )
}

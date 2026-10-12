// Key transparency in the UI: Settings → Security (each server's log and anything found), the log itself (an
// auditor's view: every entry, checked here), a banner when something doesn't add up, and a contact's key history.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fingerprint } from '../../core/connection'
import { b64u } from '../../core/crypto'
import { emptyView, entryHash, extendView, LogError, parseEntry, verifyHead, type LogEntry } from '../../core/keylog'
import { nameOf } from '../../state/dms'
import { keysOf } from '../../state/keyMap'
import { dismissFinding, findingsAbout, storedHead, useKt, type Finding, type FindingKind } from '../../state/kt'
import { connectionFor, useApp } from '../../state/store'
import { Modal, Spinner } from '../bits'
import { fullTime, messageTime } from '../format'
import { errorMessage } from '../../i18n/errors'
import './keys.css'

const TEXT = {
  fork: 'keys.kt.found.fork',
  rollback: 'keys.kt.found.rollback',
  'bad-log': 'keys.kt.found.badLog',
  'unlogged-key': 'keys.kt.found.unloggedKey',
  'unlogged-rotation': 'keys.kt.found.unloggedRotation',
  split: 'keys.kt.found.split',
  'gossip-fork': 'keys.kt.found.gossipFork',
  'gossip-conflict': 'keys.kt.found.gossipConflict',
  lookalike: 'keys.kt.found.lookalike',
  'device-unknown': 'keys.kt.found.deviceUnknown',
} as const satisfies Record<FindingKind, string>

const serverName = (key: string) => useApp.getState().servers[key]?.name ?? fingerprint(key)

function FindingText({ finding }: { finding: Finding }) {
  const { t } = useTranslation()
  return (
    <>
      {t(TEXT[finding.kind], {
        server: finding.server ? serverName(finding.server) : '',
        servers: (finding.servers ?? []).map(serverName).join(', '),
        name: finding.person ? nameOf(finding.person) : t('common.someone'),
        friend: finding.by ? nameOf(finding.by) : t('common.someone'),
      })}
    </>
  )
}

function FindingList({ findings }: { findings: Finding[] }) {
  const { t } = useTranslation()
  return (
    <ul className="kt-findings">
      {findings.map((f) => (
        <li key={f.id} className={`kt-finding ${f.severity}`} data-testid="kt-finding">
          <p><FindingText finding={f} /> <time className="muted small-text" title={fullTime(f.at)}>{messageTime(f.at)}</time></p>
          <button className="button small" onClick={() => dismissFinding(f.id)}>{t('keys.kt.dismiss')}</button>
        </li>
      ))}
    </ul>
  )
}

export function KeyTransparencySection() {
  const { t } = useTranslation()
  const order = useApp((s) => s.order)
  const servers = useApp((s) => s.servers)
  const logs = useKt((s) => s.logs)
  const findings = useKt((s) => s.findings)
  const [viewing, setViewing] = useState<string | null>(null)
  return (
    <section className="settings-section" data-testid="kt-section">
      <h2>{t('keys.kt.title')}</h2>
      <p className="muted">{t('keys.kt.intro')}</p>
      <p className="muted small-text">{t('keys.kt.limits')}</p>
      <h3 className="h4">{t('keys.kt.findings')}</h3>
      {findings.length ? <><FindingList findings={findings} /><p className="muted small-text">{t('keys.kt.advice')}</p></> : <p className="success-text">{t('keys.kt.nothing')}</p>}
      <h3 className="h4">{t('keys.kt.servers')}</h3>
      {order.length === 0 && <p className="muted">{t('keys.kt.noServers')}</p>}
      <ul className="kt-servers">
        {order.map((key) => {
          const log = logs[key]
          return (
            <li key={key} className="kt-server">
              <div className="kt-server-meta">
                <strong>{servers[key]?.name ?? fingerprint(key)}</strong>
                <span className={`small-text ${log?.state === 'problem' ? 'error-text' : 'muted'}`} data-testid="kt-status">
                  {!log || log.state === 'checking' ? t('keys.kt.status.checking')
                    : log.state === 'unsupported' ? t('keys.kt.status.unsupported')
                      : log.state === 'problem' ? t('keys.kt.status.problem')
                        : t('keys.kt.status.ok', { count: log.seq, when: messageTime(log.checkedAt) })}
                </span>
              </div>
              {log && log.state !== 'unsupported' && connectionFor(key) && (
                <button className="button small" onClick={() => setViewing(key)}>{t('keys.kt.viewLog')}</button>
              )}
            </li>
          )
        })}
      </ul>
      {viewing && <KeyLogDialog serverKey={viewing} onClose={() => setViewing(null)} />}
    </section>
  )
}

interface Row { seq: number; entry: LogEntry; hash: string }

/** The whole log of one server, read and checked from the first entry: what an owner or auditor looks at. */
export function KeyLogDialog({ serverKey, onClose }: { serverKey: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const conn = connectionFor(serverKey)
      if (!conn) return
      try {
        const entries: { seq: number; data: string }[] = []
        let head = null
        for (let page = 0; page < 200; page++) {
          const result = await conn.request('keylog.entries', { after: entries.at(-1)?.seq ?? 0, limit: 100 })
          head = result.head
          entries.push(...result.entries)
          if (!result.entries.length || (entries.at(-1)?.seq ?? 0) >= head.seq) break
        }
        if (!head || !verifyHead(serverKey, head)) throw new LogError('bad-signature')
        extendView(emptyView(serverKey), head, entries) // throws if anything doesn't link up
        let hash: Uint8Array = new Uint8Array(32)
        const list: Row[] = entries.map((e) => {
          hash = entryHash(hash, e.seq, e.data)
          return { seq: e.seq, entry: parseEntry(e.data)!, hash: b64u(hash) }
        })
        // What this device stored before must be part of this history.
        const stored = storedHead(serverKey)
        const matches = !stored?.sig || stored.seq === 0 || list.find((r) => r.seq === stored.seq)?.hash === stored.hash
        if (cancelled) return
        setRows(list)
        setVerdict(matches ? { ok: true, text: t('keys.kt.log.verified', { count: list.length }) } : { ok: false, text: t('keys.kt.log.mismatch') })
      } catch (e) {
        if (cancelled) return
        setRows([])
        setVerdict({ ok: false, text: t('keys.kt.log.failed', { problem: e instanceof LogError ? e.problem : errorMessage(e) }) })
      }
    })()
    return () => { cancelled = true }
  }, [serverKey, t])

  const describe = (e: LogEntry) => {
    switch (e.kind) {
      case 'join': return t('keys.kt.log.join', { name: e.name })
      case 'name': return t('keys.kt.log.name', { name: e.name })
      case 'rotate': return t('keys.kt.log.rotate')
      case 'contest': return t('keys.kt.log.contest')
      case 'resolve': return t('keys.kt.log.resolve')
    }
  }
  const keyLine = (e: LogEntry) => 'key' in e
    ? t('keys.kt.log.key', { key: fingerprint(e.key) })
    : t('keys.kt.log.newKey', { from: fingerprint(e.rotation.oldKey), to: fingerprint(e.rotation.newKey) })

  return (
    <Modal title={t('keys.kt.log.title', { server: serverName(serverKey) })} onClose={onClose}>
      <p className="muted">{t('keys.kt.log.intro')}</p>
      {!rows ? <p className="muted"><Spinner /> {t('keys.kt.log.loading')}</p> : (
        <>
          {verdict && <p className={verdict.ok ? 'success-text' : 'error-text'} role="status" data-testid="kt-verdict">{verdict.text}</p>}
          <ol className="kt-log" data-testid="kt-log">
            {rows.map((r) => (
              <li key={r.seq} className="kt-entry">
                <span className="kt-seq">#{r.seq}</span>
                <span className="kt-what">
                  <span>{describe(r.entry)}</span>
                  <span className="muted small-text">{keyLine(r.entry)} · <time title={fullTime(r.entry.at)}>{messageTime(r.entry.at)}</time></span>
                </span>
                <code className="kt-hash" title={r.hash}>{r.hash.slice(0, 8)}</code>
              </li>
            ))}
          </ol>
        </>
      )}
    </Modal>
  )
}

/** Above the chat: something serious turned up (a forked or rewritten log, servers or friends disagreeing). */
export function KtNotices() {
  const { t } = useTranslation()
  const all = useKt((s) => s.findings)
  const findings = all.filter((f) => f.severity === 'high')
  const [open, setOpen] = useState(false)
  if (!findings.length) return null
  return (
    <div className="nudge kt-banner" role="alert" data-testid="kt-banner">
      <p><strong>{t('keys.kt.banner')}</strong> <FindingText finding={findings[0]} /></p>
      <div className="copy-row">
        <button className="button small" onClick={() => setOpen(true)}>{t('keys.kt.details')}</button>
        <button className="button small" onClick={() => findings.forEach((f) => dismissFinding(f.id))}>{t('keys.kt.dismiss')}</button>
      </div>
      {open && (
        <Modal title={t('keys.kt.title')} onClose={() => setOpen(false)}>
          <FindingList findings={all} />
          <p className="muted small-text">{t('keys.kt.advice')}</p>
        </Modal>
      )}
    </div>
  )
}

/** In a DM: findings about this person. */
export function DmKtWarning({ peer }: { peer: string }) {
  const findings = useKt((s) => s.findings)
  const about = findingsAbout(findings, peer)
  if (!about.length) return null
  return (
    <div className="dm-key-warning" role="alert" data-testid="kt-dm-warning">
      <FindingText finding={about[0]} />
    </div>
  )
}

/** Safety number dialog: every key we've known for this person, newest first, and when this device first saw it. */
export function KeyHistory({ peer }: { peer: string }) {
  const { t } = useTranslation()
  const seen = useKt((s) => s.seen)
  const keys = keysOf(peer)
  return (
    <div className="kt-history">
      <h3 className="h4">{t('keys.kt.history.title')}</h3>
      <ul>
        {keys.map((key, i) => (
          <li key={key}>
            <span>{i === 0 ? t('keys.kt.history.current') : t('keys.kt.history.earlier')}</span> <code>{fingerprint(key)}</code>
            {seen[key] && <span className="muted small-text"> · {t('keys.kt.history.firstSeen', { when: messageTime(seen[key].first) })}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

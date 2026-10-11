// Docs dialogs: a page's menu, its history (with restore), the link picker and the "someone saved first" choice.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel, DocPage, DocRevision } from '../../core/protocol'
import { pageLink } from '../../core/pushRoute'
import type { ServerState } from '../../state/store'
import {
  deletePage, getRevision, loadPages, movePage, pageHistory, restoreRevision, setHome, startNewPage, useDocs, type DocDraft,
} from '../../state/docs'
import { changeCounts, diffLines, filterPages, merge3, moveTarget, pageTree, type DiffLine } from '../../state/docsLogic'
import { errorMessage } from '../../i18n/errors'
import { Modal, Spinner } from '../bits'
import { appUrl, fullTime } from '../format'
import { relativeTime } from '../chat/pinThreadHelpers'
import { MenuItem, MenuTitle, OrgMenu } from '../organize/OrgMenu'
import { Hash } from '../icons'
import { renderDoc } from './docMarkdown'
import { DocsIcon, PageIcon } from './icons'
import { useDocContext, type DocsAbilities } from './hooks'

export type { MenuAnchor } from '../organize/OrgMenu'
import type { MenuAnchor } from '../organize/OrgMenu'

export const linkToPage = (server: ServerState, page: Pick<DocPage, 'id' | 'channelId'>) =>
  pageLink(appUrl(server.appUrl), server.key, page.channelId, page.id)

// ── A page's menu ───────────────────────────────────────────────────────────

export function PageMenu({ server, channel, page, pages, can, anchor, onHistory, onClose }: {
  server: ServerState; channel: Channel; page: DocPage; pages: DocPage[]; can: DocsAbilities
  anchor: MenuAnchor | null; onHistory: () => void; onClose: () => void
}) {
  const { t } = useTranslation()
  const [view, setView] = useState<'menu' | 'parent' | 'delete'>('menu')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const home = useDocs((s) => s.home[server.key])
  const tree = pageTree(pages)
  const children = tree.find((n) => n.page.id === page.id)?.children ?? []
  const up = moveTarget(pages, page.id, -1)
  const down = moveTarget(pages, page.id, 1)
  const isHome = home?.pageId === page.id
  const canDelete = can.edit && (page.createdBy === server.me?.accountKey || can.moderate)

  const run = (action: () => Promise<unknown>) => () => {
    void action().then(onClose, (e) => setError(errorMessage(e)))
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(linkToPage(server, page))
      setCopied(true)
      setTimeout(onClose, 700)
    } catch {
      setError(t('docs.menu.copyFailed'))
    }
  }

  return (
    <OrgMenu anchor={anchor} label={t('docs.page.options')} onClose={onClose}>
      {view === 'delete' ? (
        <div className="sheet-confirm">
          <strong>{t('docs.menu.deleteTitle', { title: page.title })}</strong>
          <p className="muted">{children.length ? t('docs.menu.deleteHintChildren', { count: children.length }) : t('docs.menu.deleteHint')}</p>
          <button className="button danger wide" onClick={run(() => deletePage(server.key, page.id))}>{t('docs.menu.delete')}</button>
          <button className="button wide" onClick={() => setView('menu')}>{t('common.cancel')}</button>
        </div>
      ) : view === 'parent' ? (
        <>
          <MenuTitle onBack={() => setView('menu')}>{t('docs.menu.moveUnder', { title: page.title })}</MenuTitle>
          <div className="org-list" role="menu">
            {tree.filter((n) => n.page.id !== page.id).map(({ page: p }) => (
              <MenuItem key={p.id} checked={page.parentId === p.id} onClick={run(() => movePage(server.key, page.id, p.id, null))}>{p.title}</MenuItem>
            ))}
          </div>
        </>
      ) : (
        <>
          <MenuTitle>{page.title}</MenuTitle>
          <div className="org-list" role="menu">
            <MenuItem onClick={() => void copy()}>{copied ? t('common.copied') : t('docs.menu.copyLink')}</MenuItem>
            <MenuItem onClick={() => { onHistory(); onClose() }}>{t('docs.page.history')}</MenuItem>
            {can.edit && (
              <>
                <div className="org-sep" role="separator" />
                {page.parentId === null && (
                  <MenuItem onClick={() => { startNewPage(server.key, channel.id, page.id); onClose() }}>{t('docs.menu.addSubPage')}</MenuItem>
                )}
                {up && <MenuItem onClick={run(() => movePage(server.key, page.id, up.parentId, up.before))}>{t('docs.menu.moveUp')}</MenuItem>}
                {down && <MenuItem onClick={run(() => movePage(server.key, page.id, down.parentId, down.before))}>{t('docs.menu.moveDown')}</MenuItem>}
                {children.length === 0 && tree.length > 1 && (
                  <MenuItem onClick={() => setView('parent')}>{t('docs.menu.makeSubPage')}</MenuItem>
                )}
                {page.parentId !== null && (
                  <MenuItem onClick={run(() => movePage(server.key, page.id, null, null))}>{t('docs.menu.toTop')}</MenuItem>
                )}
              </>
            )}
            {can.home && (
              <MenuItem onClick={run(() => setHome(server.key, isHome ? null : page.id))} hint={isHome ? undefined : t('docs.menu.startHereHint')}>
                {isHome ? t('docs.menu.unsetStartHere') : t('docs.menu.setStartHere')}
              </MenuItem>
            )}
            {canDelete && (
              <>
                <div className="org-sep" role="separator" />
                <MenuItem danger onClick={() => setView('delete')}>{t('docs.menu.delete')}</MenuItem>
              </>
            )}
          </div>
        </>
      )}
      {error && <p className="error-text sheet-error" role="alert">{error}</p>}
    </OrgMenu>
  )
}

// ── History ─────────────────────────────────────────────────────────────────

export function HistoryDialog({ server, page, canRestore, onClose }: { server: ServerState; page: DocPage; canRestore: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const [revisions, setRevisions] = useState<DocRevision[] | null>(null)
  const [chosen, setChosen] = useState<DocRevision | null>(null)
  const [current, setCurrent] = useState<DocRevision | null>(null)
  const [mode, setMode] = useState<'page' | 'changes'>('page')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ctx = useDocContext(server)
  const name = (k: string) => server.members[k]?.name ?? t('docs.someone')

  useEffect(() => {
    pageHistory(server.key, page.id).then(setRevisions, (e) => setError(errorMessage(e)))
  }, [server.key, page.id, page.version])

  async function choose(r: DocRevision) {
    setError(null)
    try {
      const [full, now] = await Promise.all([
        getRevision(server.key, page.id, r.version),
        current?.version === page.version ? Promise.resolve(current) : getRevision(server.key, page.id, page.version).catch(() => null),
      ])
      setChosen(full)
      setCurrent(now)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function restore() {
    if (!chosen) return
    setBusy(true)
    try {
      await restoreRevision(server.key, page, chosen.version)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const diff = useMemo(() => (chosen && current ? diffLines((current.text ?? '').split('\n'), (chosen.text ?? '').split('\n')) : null), [chosen, current])

  return (
    <Modal
      title={t('docs.history.title', { title: page.title })}
      wide
      className="docs-history"
      onBack={chosen ? () => setChosen(null) : undefined}
      onClose={onClose}
      footer={chosen && canRestore && chosen.version !== page.version ? (
        <>
          <button className="button" onClick={() => setChosen(null)}>{t('common.back')}</button>
          <button className="button primary" disabled={busy} onClick={() => void restore()}>{t('docs.history.restore', { version: chosen.version })}</button>
        </>
      ) : undefined}
    >
      {error && <p className="error-text">{error}</p>}
      {!revisions ? <Spinner /> : chosen ? (
        <div className="docs-revision">
          <p className="muted">
            {t('docs.history.savedBy', { version: chosen.version, name: name(chosen.author), time: fullTime(chosen.createdAt) })}
          </p>
          <div className="segmented small" role="radiogroup" aria-label={t('docs.history.show')}>
            <button role="radio" aria-checked={mode === 'page'} className={mode === 'page' ? 'on' : ''} onClick={() => setMode('page')}>{t('docs.history.asPage')}</button>
            <button role="radio" aria-checked={mode === 'changes'} className={mode === 'changes' ? 'on' : ''} onClick={() => setMode('changes')}>{t('docs.history.changes')}</button>
          </div>
          {mode === 'page' ? (
            <div className="docs-content docs-revision-body">
              <h1 className="docs-title">{chosen.title}</h1>
              {renderDoc(chosen.text ?? '', ctx)}
            </div>
          ) : diff ? <DiffView lines={diff} emptyText={t('docs.history.same')} /> : <Spinner />}
        </div>
      ) : (
        <ol className="docs-revisions">
          {revisions.map((r) => (
            <li key={r.version}>
              <button className="docs-revision-row" onClick={() => void choose(r)}>
                <span className="docs-revision-version">v{r.version}</span>
                <span className="docs-revision-who">
                  <strong>{name(r.author)}</strong>
                  <span className="muted" title={fullTime(r.createdAt)}> · {relativeTime(r.createdAt)}</span>
                  {r.restoredFrom !== null && <span className="muted"> · {t('docs.history.restoredFrom', { version: r.restoredFrom })}</span>}
                  {r.version === page.version && <span className="docs-current-pill">{t('docs.history.current')}</span>}
                </span>
                {r.title !== page.title && <span className="docs-revision-title muted">{r.title}</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
      {revisions && !chosen && <p className="muted docs-history-note">{t('docs.history.note')}</p>}
    </Modal>
  )
}

/** Lines added and removed, with unchanged stretches folded down to a little context. */
export function DiffView({ lines, emptyText }: { lines: DiffLine[]; emptyText: string }) {
  const { t } = useTranslation()
  const changed = lines.map((l) => l.kind !== 'same')
  if (!changed.some(Boolean)) return <p className="muted">{emptyText}</p>
  const near = (i: number) => changed.slice(Math.max(0, i - 2), i + 3).some(Boolean)
  const rows: ReactNode[] = []
  let skipped = 0
  lines.forEach((line, i) => {
    if (line.kind === 'same' && !near(i)) {
      skipped++
      return
    }
    if (skipped) rows.push(<div key={`s${i}`} className="diff-skip">{t('docs.diff.unchanged', { count: skipped })}</div>)
    skipped = 0
    rows.push(
      <div key={i} className={`diff-line ${line.kind}`}>
        <span className="diff-mark" aria-label={line.kind === 'added' ? t('docs.diff.added') : line.kind === 'removed' ? t('docs.diff.removed') : undefined}>
          {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
        </span>
        <span className="diff-text">{line.text || ' '}</span>
      </div>,
    )
  })
  if (skipped) rows.push(<div key="end" className="diff-skip">{t('docs.diff.unchanged', { count: skipped })}</div>)
  return <div className="diff-view" role="table" aria-label={t('docs.diff.label')}>{rows}</div>
}

// ── Linking ─────────────────────────────────────────────────────────────────

/** Pick a page (any docs channel you can see) or a channel to link to. */
export function LinkPicker({ server, onPick, onClose }: { server: ServerState; onPick: (url: string, label: string) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const lists = useDocs((s) => s.lists)
  const base = appUrl(server.appUrl)
  const docsChannels = server.channels.filter((c) => c.kind === 'docs')
  useEffect(() => {
    for (const c of docsChannels) if (!useDocs.getState().lists[`${server.key}:${c.id}`]) void loadPages(server.key, c.id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const pages = docsChannels.flatMap((c) => lists[`${server.key}:${c.id}`]?.pages ?? [])
  const shown = filterPages(pages, query).slice(0, 40)
  const channels = server.channels.filter((c) => (c.kind === 'text' || c.kind === 'forum' || c.kind === 'docs') && c.name.includes(query.trim().toLowerCase()))
  const channelName = (id: number) => server.channels.find((c) => c.id === id)?.name ?? ''
  return (
    <Modal title={t('docs.link.title')} onClose={onClose} className="docs-link-picker">
      <label className="field">
        <span>{t('docs.link.search')}</span>
        <input autoFocus value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <p className="docs-tree-heading">{t('docs.link.pages')}</p>
      {shown.length === 0 ? <p className="muted">{t('docs.tree.noMatches')}</p> : (
        <ul className="docs-pick-list">
          {shown.map((p) => (
            <li key={p.id}>
              <button className="docs-pick" onClick={() => onPick(linkToPage(server, p), p.title)}>
                <PageIcon size={14} /> {p.title} <span className="muted">#{channelName(p.channelId)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="docs-tree-heading">{t('docs.link.channels')}</p>
      <ul className="docs-pick-list">
        {channels.slice(0, 20).map((c) => (
          <li key={c.id}>
            <button className="docs-pick" onClick={() => onPick(`${base.replace(/\/+$/, '')}/#/open/${server.key}/c/${c.id}`, `#${c.name}`)}>
              {c.kind === 'docs' ? <DocsIcon size={14} /> : <Hash size={14} />} {c.name}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted docs-history-note">{t('docs.link.messages')}</p>
    </Modal>
  )
}

// ── Someone saved first ─────────────────────────────────────────────────────

export type ConflictChoice =
  | { kind: 'merge'; text: string; conflicts: number }
  | { kind: 'mine' }
  | { kind: 'theirs' }

/** The draft is behind `latest`: show what they changed and let the writer merge, overwrite or take theirs. */
export function ConflictDialog({ server, draft, latest, onChoose, onClose }: {
  server: ServerState; draft: DocDraft; latest: DocPage; onChoose: (choice: ConflictChoice) => void; onClose: () => void
}) {
  const { t } = useTranslation()
  const [show, setShow] = useState<'theirs' | 'mine' | null>(null)
  const theirs = latest.text ?? ''
  const merged = useMemo(() => merge3(draft.baseText, draft.text, theirs), [draft.baseText, draft.text, theirs])
  const theirCounts = useMemo(() => changeCounts(draft.baseText, theirs), [draft.baseText, theirs])
  const myCounts = useMemo(() => changeCounts(draft.baseText, draft.text), [draft.baseText, draft.text])
  const diff = useMemo(() => show === 'theirs' ? diffLines(draft.baseText.split('\n'), theirs.split('\n'))
    : show === 'mine' ? diffLines(draft.baseText.split('\n'), draft.text.split('\n')) : null, [show, draft.baseText, draft.text, theirs])
  const who = server.members[latest.updatedBy]?.name ?? t('docs.someone')

  return (
    <Modal title={t('docs.conflict.title')} wide className="docs-conflict" onClose={onClose}>
      <p>{t('docs.conflict.intro', { name: who, time: relativeTime(latest.updatedAt) })}</p>
      <ul className="docs-conflict-counts">
        <li>
          <button className="docs-linkish" onClick={() => setShow(show === 'theirs' ? null : 'theirs')}>
            {t('docs.conflict.theirChanges', { name: who, added: theirCounts.added, removed: theirCounts.removed })}
          </button>
        </li>
        <li>
          <button className="docs-linkish" onClick={() => setShow(show === 'mine' ? null : 'mine')}>
            {t('docs.conflict.myChanges', { added: myCounts.added, removed: myCounts.removed })}
          </button>
        </li>
      </ul>
      {diff && <DiffView lines={diff} emptyText={t('docs.history.same')} />}
      <div className="docs-conflict-choices">
        <button className="docs-choice primary" onClick={() => onChoose({ kind: 'merge', ...merged })}>
          <strong>{merged.conflicts ? t('docs.conflict.mergeMarked') : t('docs.conflict.merge')}</strong>
          <span className="muted">{merged.conflicts
            ? t('docs.conflict.mergeMarkedHint', { count: merged.conflicts })
            : t('docs.conflict.mergeHint')}</span>
        </button>
        <button className="docs-choice" onClick={() => onChoose({ kind: 'mine' })}>
          <strong>{t('docs.conflict.mine')}</strong>
          <span className="muted">{t('docs.conflict.mineHint', { name: who })}</span>
        </button>
        <button className="docs-choice" onClick={() => onChoose({ kind: 'theirs' })}>
          <strong>{t('docs.conflict.theirs')}</strong>
          <span className="muted">{t('docs.conflict.theirsHint')}</span>
        </button>
      </div>
    </Modal>
  )
}

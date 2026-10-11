// A docs channel: its pages in a tree beside the open page (on phones the tree is its own screen), a reading view
// with an outline, and the editor. Pages are written in the app's Markdown plus tables and pictures (docMarkdown.tsx).
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel, DocPage, DocSearchResult } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { docsKey, loadPage, loadPages, openPage, searchDocs, startEditing, startNewPage, useDocs } from '../../state/docs'
import { filterPages, pageTree } from '../../state/docsLogic'
import { Spinner } from '../bits'
import { ChevronLeft, Menu, Pencil, Plus, Users } from '../icons'
import { SearchIcon } from '../chat/extraIcons'
import { relativeTime } from '../chat/pinThreadHelpers'
import { fullTime } from '../format'
import { errorMessage } from '../../i18n/errors'
import type { Panel } from '../Shell'
import { docHeadings, renderDoc } from './docMarkdown'
import { useDocContext, useDocsAbilities, type DocsAbilities } from './hooks'
import { DocsIcon, FlagIcon, HistoryIcon, PageIcon } from './icons'
import { PageEditor } from './PageEditor'
import { HistoryDialog, PageMenu, type MenuAnchor } from './DocDialogs'
import './docs.css'

const NO_PAGES: DocPage[] = []

export function DocsView({ server, channel, onToggle }: { server: ServerState; channel: Channel; onToggle: (panel: Panel) => void }) {
  const { t } = useTranslation()
  const key = docsKey(server.key, channel.id)
  const list = useDocs((s) => s.lists[key])
  const openId = useDocs((s) => s.open[key]) ?? null
  const draft = useDocs((s) => s.drafts[key])
  const online = server.status.state === 'online'
  const can = useDocsAbilities(server, channel)
  const pages = list?.pages ?? NO_PAGES

  useEffect(() => {
    if (online && !list) void loadPages(server.key, channel.id)
  }, [online, list, server.key, channel.id])

  const page = openId !== null ? pages.find((p) => p.id === openId) : undefined
  // A link to a page that's gone (or hidden): back to the overview once the list is in.
  useEffect(() => {
    if (openId !== null && list && !list.loading && !page) openPage(server.key, channel.id, null)
  }, [openId, list, page, server.key, channel.id])

  const editing = !!draft && (draft.pageId === null || draft.pageId === openId)
  const showingPage = editing || !!page

  return (
    <div className={`chat docs ${showingPage ? 'docs-has-page' : ''} ${editing ? 'docs-editing' : ''}`}>
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('docs.view.openChannels')}>
          <Menu />
        </button>
        {showingPage && (
          <button className="icon-button docs-back" onClick={() => openPage(server.key, channel.id, null)} aria-label={t('docs.view.allPages')}>
            <ChevronLeft />
          </button>
        )}
        <h1>
          <span className="hash"><DocsIcon size={20} /></span>
          {channel.name}
        </h1>
        <span className="spacer" />
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label={t('docs.view.members')} title={t('docs.view.members')}>
          <Users />
        </button>
      </header>

      <div className="docs-body">
        <PageTree server={server} channel={channel} pages={pages} openId={openId} canEdit={can.edit} loading={!list || (list.loading && pages.length === 0)} />
        <main className="docs-main">
          {list?.error && <div className="banner error"><span>{list.error}</span></div>}
          {editing ? (
            <PageEditor key={draft.pageId ?? 'new'} server={server} channel={channel} draft={draft} pages={pages} />
          ) : page ? (
            <PageReader key={page.id} server={server} channel={channel} page={page} pages={pages} can={can} />
          ) : !list || (list.loading && pages.length === 0) ? (
            <div className="docs-empty"><Spinner /></div>
          ) : (
            <Overview server={server} channel={channel} pages={pages} canEdit={can.edit} />
          )}
        </main>
      </div>
    </div>
  )
}

// ── The page tree ───────────────────────────────────────────────────────────

function PageTree({ server, channel, pages, openId, canEdit, loading }: {
  server: ServerState; channel: Channel; pages: DocPage[]; openId: number | null; canEdit: boolean; loading: boolean
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<DocSearchResult[] | null>(null)
  const home = useDocs((s) => s.home[server.key])
  const tree = useMemo(() => pageTree(pages), [pages])
  const titleMatches = useMemo(() => (query.trim() ? filterPages(pages, query) : []), [pages, query])

  // Searching the text too, once typing pauses.
  useEffect(() => {
    if (!query.trim()) {
      setHits(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      searchDocs(server.key, query, channel.id).then((r) => live && setHits(r), () => live && setHits([]))
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, server.key, channel.id])

  const textHits = (hits ?? []).filter((h) => !titleMatches.some((p) => p.id === h.page.id))
  const open = (id: number) => {
    openPage(server.key, channel.id, id)
    document.querySelector('.docs-main')?.scrollTo({ top: 0 })
  }

  const row = (page: DocPage, sub: boolean) => (
    <li key={page.id}>
      <button className={`docs-tree-item ${sub ? 'sub' : ''} ${page.id === openId ? 'active' : ''}`} onClick={() => open(page.id)}
        aria-current={page.id === openId ? 'page' : undefined}>
        {home?.pageId === page.id ? <FlagIcon size={14} /> : <PageIcon size={14} />}
        <span className="docs-tree-title">{page.title}</span>
      </button>
    </li>
  )

  return (
    <nav className="docs-tree" aria-label={t('docs.tree.label', { channel: channel.name })}>
      <div className="docs-tree-top">
        <label className="docs-filter">
          <SearchIcon size={14} />
          <input type="search" value={query} maxLength={200} placeholder={t('docs.tree.search')} aria-label={t('docs.tree.search')}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && query && (e.preventDefault(), setQuery(''))} />
        </label>
        {canEdit && (
          <button className="button primary small docs-new" onClick={() => startNewPage(server.key, channel.id, null)}>
            <Plus size={14} /> {t('docs.tree.newPage')}
          </button>
        )}
      </div>
      {loading ? null : query.trim() ? (
        <div className="docs-tree-results">
          <ul className="docs-tree-list">{titleMatches.map((p) => row(p, false))}</ul>
          {textHits.length > 0 && (
            <>
              <p className="docs-tree-heading">{t('docs.tree.inText')}</p>
              <ul className="docs-tree-list">
                {textHits.map((h) => (
                  <li key={h.page.id}>
                    <button className="docs-tree-item hit" onClick={() => open(h.page.id)}>
                      <PageIcon size={14} />
                      <span className="docs-tree-title">{h.page.title}<span className="docs-hit-snippet">{highlighted(h)}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {hits !== null && titleMatches.length === 0 && textHits.length === 0 && <p className="docs-tree-note">{t('docs.tree.noMatches')}</p>}
        </div>
      ) : pages.length === 0 ? (
        <p className="docs-tree-note">{t('docs.tree.empty')}</p>
      ) : (
        <ul className="docs-tree-list">
          {tree.map((node) => (
            <li key={node.page.id}>
              <ul className="docs-tree-group">
                {row(node.page, false)}
                {node.children.map((c) => row(c, true))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

/** A search snippet with its matches marked (React elements, never HTML). */
export function highlighted(hit: Pick<DocSearchResult, 'snippet' | 'matches'>) {
  const parts: ReactNode[] = []
  let pos = 0
  hit.matches.forEach(([start, length], i) => {
    if (start < pos || start + length > hit.snippet.length) return
    parts.push(hit.snippet.slice(pos, start), <mark key={i}>{hit.snippet.slice(start, start + length)}</mark>)
    pos = start + length
  })
  parts.push(hit.snippet.slice(pos))
  return parts
}

// ── The overview (no page open) ─────────────────────────────────────────────

function Overview({ server, channel, pages, canEdit }: { server: ServerState; channel: Channel; pages: DocPage[]; canEdit: boolean }) {
  const { t } = useTranslation()
  const tree = useMemo(() => pageTree(pages), [pages])
  const recent = useMemo(() => [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5), [pages])
  const name = (k: string) => server.members[k]?.name ?? t('docs.someone')

  if (pages.length === 0) {
    return (
      <div className="docs-empty">
        <span className="empty-icon"><DocsIcon size={32} /></span>
        <h2>{t('docs.overview.emptyTitle')}</h2>
        <p className="muted">{canEdit ? t('docs.overview.emptyWriter') : t('docs.overview.emptyReader')}</p>
        {canEdit && (
          <button className="button primary" onClick={() => startNewPage(server.key, channel.id, null)}>
            <Plus size={16} /> {t('docs.overview.first')}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="docs-overview">
      <h2 className="docs-overview-title">{t('docs.overview.title', { channel: channel.name })}</h2>
      <p className="muted">{t('docs.overview.count', { count: pages.length })}</p>
      <div className="docs-cards">
        {tree.map(({ page, children }) => (
          <button key={page.id} className="docs-card" onClick={() => openPage(server.key, channel.id, page.id)}>
            <span className="docs-card-title"><PageIcon size={16} /> {page.title}</span>
            {children.length > 0 && <span className="docs-card-sub">{children.map((c) => c.title).join(' · ')}</span>}
            <span className="docs-card-meta">{t('docs.page.edited', { name: name(page.updatedBy), time: relativeTime(page.updatedAt) })}</span>
          </button>
        ))}
      </div>
      <h3 className="docs-section-title">{t('docs.overview.recent')}</h3>
      <ul className="docs-recent">
        {recent.map((p) => (
          <li key={p.id}>
            <button className="docs-linkish" onClick={() => openPage(server.key, channel.id, p.id)}>{p.title}</button>
            <span className="muted"> · {t('docs.page.edited', { name: name(p.updatedBy), time: relativeTime(p.updatedAt) })}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Reading a page ──────────────────────────────────────────────────────────

const More = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
  </svg>
)

function PageReader({ server, channel, page, pages, can }: {
  server: ServerState; channel: Channel; page: DocPage; pages: DocPage[]; can: DocsAbilities
}) {
  const { t } = useTranslation()
  const full = useDocs((s) => s.texts[docsKey(server.key, page.id)])
  const home = useDocs((s) => s.home[server.key])
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuAnchor | null | false>(false)
  const [history, setHistory] = useState(false)
  const content = useRef<HTMLDivElement>(null)
  const ctx = useDocContext(server)
  const online = server.status.state === 'online'
  const current = full && full.version === page.version ? full : undefined

  useEffect(() => {
    if (!current && online) loadPage(server.key, page.id).then(() => setError(null), (e) => setError(errorMessage(e)))
  }, [current, online, server.key, page.id, page.version])

  const parent = page.parentId !== null ? pages.find((p) => p.id === page.parentId) : undefined
  const children = useMemo(() => pageTree(pages).find((n) => n.page.id === page.id)?.children ?? [], [pages, page.id])
  const text = (current ?? full)?.text ?? ''
  const headings = useMemo(() => docHeadings(text), [text])
  const rendered = useMemo(() => renderDoc(text, ctx), [text, ctx.serverUrl, server.members]) // eslint-disable-line react-hooks/exhaustive-deps
  const name = (k: string) => server.members[k]?.name ?? t('docs.someone')

  const openMenu = (e: MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setMenu({ x: rect.right - 220, y: rect.bottom + 4 })
  }

  function jumpToHeading(index: number) {
    content.current?.querySelectorAll<HTMLElement>('.md-heading')[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <article className="docs-reader" aria-labelledby={`doc-title-${page.id}`}>
      {parent && (
        <nav className="docs-crumbs" aria-label={t('docs.page.breadcrumb')}>
          <button className="docs-linkish" onClick={() => openPage(server.key, channel.id, parent.id)}>{parent.title}</button>
          <span aria-hidden> › </span>
        </nav>
      )}
      <header className="docs-page-head">
        <h1 id={`doc-title-${page.id}`} className="docs-title">{page.title}</h1>
        <div className="docs-page-actions">
          {can.edit && (
            <button className="button small" disabled={!current} onClick={() => current && startEditing(server.key, current)}>
              <Pencil size={14} /> {t('docs.page.edit')}
            </button>
          )}
          <button className="icon-button" onClick={openMenu} aria-label={t('docs.page.options')} title={t('docs.page.options')}>
            <More />
          </button>
        </div>
      </header>
      <p className="docs-meta">
        {home?.pageId === page.id && <span className="docs-home-badge"><FlagIcon size={12} /> {t('docs.home.badge')}</span>}
        <span title={fullTime(page.updatedAt)}>{t('docs.page.edited', { name: name(page.updatedBy), time: relativeTime(page.updatedAt) })}</span>
        <button className="docs-linkish docs-history-link" onClick={() => setHistory(true)}>
          <HistoryIcon size={13} /> {t('docs.page.history')}
        </button>
      </p>
      {error && <div className="banner error"><span>{error}</span></div>}
      {headings.length >= 3 && (
        <details className="docs-outline">
          <summary>{t('docs.page.outline')}</summary>
          <ul>
            {headings.map((h) => (
              <li key={h.index} className={`level-${h.level}`}>
                <button className="docs-linkish" onClick={() => jumpToHeading(h.index)}>{h.text.replace(/[*_`~|]/g, '')}</button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!full ? (
        <div className="docs-empty"><Spinner /></div>
      ) : text ? (
        <div className="docs-content" ref={content}>{rendered}</div>
      ) : (
        <p className="muted docs-blank">{can.edit ? t('docs.page.blankWriter') : t('docs.page.blank')}</p>
      )}
      {children.length > 0 && (
        <section className="docs-children" aria-label={t('docs.page.subPages')}>
          <h2 className="docs-section-title">{t('docs.page.subPages')}</h2>
          <div className="docs-cards">
            {children.map((c) => (
              <button key={c.id} className="docs-card" onClick={() => openPage(server.key, channel.id, c.id)}>
                <span className="docs-card-title"><PageIcon size={16} /> {c.title}</span>
                <span className="docs-card-meta">{t('docs.page.edited', { name: name(c.updatedBy), time: relativeTime(c.updatedAt) })}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {menu !== false && (
        <PageMenu server={server} channel={channel} page={page} pages={pages} can={can} anchor={menu}
          onHistory={() => setHistory(true)} onClose={() => setMenu(false)} />
      )}
      {history && <HistoryDialog server={server} page={page} canRestore={can.edit} onClose={() => setHistory(false)} />}
    </article>
  )
}

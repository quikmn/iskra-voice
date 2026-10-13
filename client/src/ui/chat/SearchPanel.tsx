// Search results beside the chat (full screen on phones). Matches are highlighted with React elements.
import { useTranslation } from 'react-i18next'
import type { SearchResult } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { closeSearch, resultCount, runSearch, setSearchText, useSearch } from '../../state/search'
import { conversationLabel } from '../../state/threads'
import { jumpToMessage } from '../../state/jump'
import { Avatar, Spinner } from '../bits'
import { fullTime, hueFor, messageTime } from '../format'
import { Close } from '../icons'
import { highlightSegments, readableMentions } from './searchQuery'
import { ArrowLeft, SearchIcon } from './extraIcons'
import { useEscapeLayer } from '../layers'
import { resolveKey } from '../../state/keyMap'
import { DocSearchHits } from '../docs/DocSearchHits'
import { stripMarkdownPieces } from '../plainMarkdown'

const HINTS = [
  ['from:', 'chat.search.hints.from'],
  ['in:', 'chat.search.hints.in'],
  ['has:file', 'chat.search.hints.hasFile'],
  ['has:link', 'chat.search.hints.hasLink'],
  ['before:', 'chat.search.hints.before'],
  ['after:', 'chat.search.hints.after'],
] as const

const isPhone = () => window.matchMedia('(max-width: 760px)').matches

export function SearchPanel({ server }: { server: ServerState }) {
  const { text, searched, results, total, totalCapped, hasMore, loading, error } = useSearch()
  useEscapeLayer(closeSearch)
  const { t } = useTranslation()

  function addFilter(filter: string) {
    const next = `${text.trim()} ${filter}`.trimStart()
    setSearchText(next)
    document.querySelector<HTMLInputElement>('.side-panel .panel-search input, .desktop-search input')?.focus()
  }

  return (
    <section className="side-panel search-panel" aria-label={t('chat.search.results')}>
      <header className="side-panel-header">
        <button className="icon-button panel-back" onClick={closeSearch} aria-label={t('chat.search.close')}><ArrowLeft /></button>
        <label className="header-search panel-search">
          <SearchIcon size={15} />
          <input
            type="search"
            placeholder={t('chat.search.placeholder', { name: server.name })}
            aria-label={t('chat.search.searchMessages')}
            value={text}
            maxLength={300}
            autoFocus={isPhone()}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runSearch(server.key)}
          />
        </label>
        <div className="panel-title desktop-title">
          <h2>{searched ? (loading && results.length === 0 ? t('chat.search.searching') : resultCount(total, totalCapped)) : t('common.search')}</h2>
        </div>
        <span className="spacer" />
        <button className="icon-button panel-close" onClick={closeSearch} aria-label={t('chat.search.close')} title={t('common.close')}><Close /></button>
      </header>

      <div className="search-results">
        {error && <p className="error-text search-note">{error}</p>}
        {searched && <DocSearchHits server={server} query={searched} />}
        {searched && server.channels.some((c) => c.e2ee) && <p className="search-note muted small-text">{t('e2ee.search.local')}</p>}
        {!searched && !error && (
          <div className="search-help">
            <p className="muted">{t('chat.search.help')}</p>
            <div className="search-chips">
              {HINTS.map(([filter, label]) => (
                <button key={filter} className="search-chip" onClick={() => addFilter(filter)}>
                  <code>{filter}</code> <span className="muted">{t(label)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {searched && !loading && !error && results.length === 0 && (
          <div className="search-note">
            <p>{t('chat.search.none')}</p>
            <p className="muted">{t('chat.search.noneHint')}</p>
          </div>
        )}
        {results.length > 0 && <p className="search-note muted mobile-count">{resultCount(total, totalCapped)}</p>}
        <ul className="result-list">
          {results.map((result) => <ResultCard key={result.message.id} server={server} result={result} />)}
        </ul>
        {loading && <div className="search-note"><Spinner /></div>}
        {hasMore && !loading && (
          <button className="button wide load-more" onClick={() => void runSearch(server.key, true)}>{t('chat.search.more')}</button>
        )}
      </div>
    </section>
  )
}

function ResultCard({ server, result }: { server: ServerState; result: SearchResult }) {
  const { message, matches } = result
  const { t } = useTranslation()
  const name = message.imported?.name ?? (server.members[message.author] ?? server.members[resolveKey(message.author)])?.name ?? t('chat.author.formerMember')
  const nameOf = (k: string) => server.members[k]?.name ?? null
  const segments = stripMarkdownPieces(highlightSegments(message.text, matches))
  return (
    <li>
      <button
        className="result-card"
        onClick={() => {
          void jumpToMessage(server.key, message.channelId, message.id)
          if (isPhone()) closeSearch()
        }}
      >
        <span className="result-where">{conversationLabel(server, message.channelId)}</span>
        <span className="result-row">
          <Avatar name={name} accountKey={message.author} size={28} />
          <span className="result-body">
            <span className="message-meta">
              <span className="author" style={{ color: `hsl(${hueFor(message.author)} 70% var(--name-l))` }}>{name}</span>
              <time title={fullTime(message.createdAt)}>{messageTime(message.createdAt)}</time>
            </span>
            <span className="result-text">
              {segments.map((segment, i) =>
                segment.hit
                  ? <mark key={i}>{readableMentions(segment.text, nameOf)}</mark>
                  : <span key={i}>{readableMentions(segment.text, nameOf)}</span>,
              )}
              {!message.text && message.attachments.length > 0 && (
                <span className="muted">{t('chat.search.attachments', { count: message.attachments.length })}</span>
              )}
            </span>
          </span>
        </span>
      </button>
    </li>
  )
}

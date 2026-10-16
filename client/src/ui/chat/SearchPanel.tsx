// Search results beside the chat (full screen on phones). Matches are highlighted with React elements. "This server"
// lists one server's results; "Everywhere" groups every server's under its name, with how each one did, plus the
// direct messages and groups on this device.
import { useTranslation } from 'react-i18next'
import type { SearchResult } from '../../core/protocol'
import { useApp, type ServerState } from '../../state/store'
import { closeSearch, DMS, resultCount, runGroupMore, runSearch, setSearchScope, setSearchText, useSearch, type DmHit, type SearchGroup } from '../../state/search'
import { conversationLabel } from '../../state/threads'
import { jumpToMessage } from '../../state/jump'
import { nameOf, openConversation } from '../../state/dms'
import { openGroup, useGroups } from '../../state/groups'
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
  const { scope, text, searched, results, total, totalCapped, hasMore, loading, error, groups } = useSearch()
  useEscapeLayer(closeSearch)
  const { t } = useTranslation()
  const everywhere = scope === 'everywhere'

  function addFilter(filter: string) {
    const next = `${text.trim()} ${filter}`.trimStart()
    setSearchText(next)
    document.querySelector<HTMLInputElement>('.side-panel .panel-search input, .desktop-search input')?.focus()
  }

  const found = everywhere ? groups.some((g) => g.results.length + g.hits.length > 0) : results.length > 0
  return (
    <section className="side-panel search-panel" aria-label={t('chat.search.results')}>
      <header className="side-panel-header">
        <button className="icon-button panel-back" onClick={closeSearch} aria-label={t('chat.search.close')}><ArrowLeft /></button>
        <label className="header-search panel-search">
          <SearchIcon size={15} />
          <input
            type="search"
            placeholder={everywhere ? t('chat.search.placeholderEverywhere') : t('chat.search.placeholder', { name: server.name })}
            aria-label={t('chat.search.searchMessages')}
            value={text}
            maxLength={300}
            autoFocus={isPhone()}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runSearch(server.key)}
          />
        </label>
        <div className="panel-title desktop-title">
          <h2>{searched ? (loading && !found ? t('chat.search.searching') : resultCount(total, totalCapped)) : t('common.search')}</h2>
        </div>
        <span className="spacer" />
        <button className="icon-button panel-close" onClick={closeSearch} aria-label={t('chat.search.close')} title={t('common.close')}><Close /></button>
      </header>

      <div className="segmented search-scope" role="radiogroup" aria-label={t('chat.search.scopeLabel')}>
        <button role="radio" aria-checked={!everywhere} className={everywhere ? '' : 'on'} onClick={() => setSearchScope('server')}>{t('chat.search.scopeServer')}</button>
        <button role="radio" aria-checked={everywhere} className={everywhere ? 'on' : ''} onClick={() => setSearchScope('everywhere')}>{t('chat.search.scopeEverywhere')}</button>
      </div>

      <div className="search-results">
        {error && <p className="error-text search-note">{error}</p>}
        {searched && !everywhere && <DocSearchHits server={server} query={searched} />}
        {searched && !everywhere && server.channels.some((c) => c.e2ee) && <p className="search-note muted small-text">{t('e2ee.search.local')}</p>}
        {!searched && !error && (
          <div className="search-help">
            <p className="muted">{everywhere ? t('chat.search.helpEverywhere') : t('chat.search.help')}</p>
            <div className="search-chips">
              {HINTS.map(([filter, label]) => (
                <button key={filter} className="search-chip" onClick={() => addFilter(filter)}>
                  <code>{filter}</code> <span className="muted">{t(label)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {searched && !loading && !error && !found && (
          <div className="search-note">
            <p>{t('chat.search.none')}</p>
            <p className="muted">{t('chat.search.noneHint')}</p>
          </div>
        )}
        {found && <p className="search-note muted mobile-count">{resultCount(total, totalCapped)}</p>}
        {everywhere ? (
          searched && groups.map((group) => <GroupSection key={group.key} group={group} />)
        ) : (
          <>
            <ul className="result-list">
              {results.map((result) => <ResultCard key={result.message.id} server={server} result={result} />)}
            </ul>
            {loading && <div className="search-note"><Spinner /></div>}
            {hasMore && !loading && (
              <button className="button wide load-more" onClick={() => void runSearch(server.key, true)}>{t('chat.search.more')}</button>
            )}
          </>
        )}
      </div>
    </section>
  )
}

/** One server's (or this device's DMs') part of an "everywhere" search: a heading with how it did, then its hits. */
function GroupSection({ group }: { group: SearchGroup }) {
  const { t } = useTranslation()
  const server = useApp((s) => s.servers[group.key])
  const name = group.key === DMS ? t('chat.search.directMessages') : server?.name ?? t('chat.search.aServer')
  const count = group.results.length + group.hits.length
  const status = group.status === 'searching' ? <Spinner />
    : group.status === 'offline' ? t('chat.search.statusOffline')
      : group.status === 'forbidden' ? t('chat.search.statusForbidden')
        : group.status === 'skipped' || group.status === 'error' ? group.note
          : group.key === DMS ? t('chat.search.resultCount', { count }) : resultCount(group.total, group.totalCapped)
  return (
    <section className={`search-group ${group.status}`} aria-label={name}>
      <h3><span className="search-group-name">{name}</span> <span className="muted search-group-status" role={group.status === 'searching' ? 'status' : undefined}>{status}</span></h3>
      {count > 0 && (
        <ul className="result-list">
          {server && group.results.map((result) => <ResultCard key={result.message.id} server={server} result={result} />)}
          {group.key === DMS && group.hits.map((hit) => <DmHitCard key={`${hit.key}:${hit.message.id}`} hit={hit} />)}
        </ul>
      )}
      {group.hasMore && group.status === 'done' && (
        <button className="button wide load-more" onClick={() => void runGroupMore(group.key)}>{t('chat.search.more')}</button>
      )}
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

/** A hit in a direct message or a group on this device; opening it shows the conversation. */
function DmHitCard({ hit }: { hit: DmHit }) {
  const { message, matches } = hit
  const { t } = useTranslation()
  const group = useGroups((s) => (hit.kind === 'group' ? s.groups[hit.key] : undefined))
  const author = nameOf(message.from)
  const where = hit.kind === 'dm' ? nameOf(hit.key) : group?.name ?? t('chat.search.aGroup')
  const segments = stripMarkdownPieces(highlightSegments(message.text, matches))
  return (
    <li>
      <button
        className="result-card"
        onClick={() => {
          if (hit.kind === 'dm') openConversation(hit.key)
          else openGroup(hit.key)
          if (isPhone()) closeSearch()
        }}
      >
        <span className="result-where">{where}</span>
        <span className="result-row">
          <Avatar name={author} accountKey={message.from} size={28} />
          <span className="result-body">
            <span className="message-meta">
              <span className="author" style={{ color: `hsl(${hueFor(message.from)} 70% var(--name-l))` }}>{author}</span>
              <time title={fullTime(message.sentAt)}>{messageTime(message.sentAt)}</time>
            </span>
            <span className="result-text">
              {segments.map((segment, i) => (segment.hit ? <mark key={i}>{segment.text}</mark> : <span key={i}>{segment.text}</span>))}
            </span>
          </span>
        </span>
      </button>
    </li>
  )
}

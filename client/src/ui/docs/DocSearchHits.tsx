// Docs pages that match a message search, shown above the message results (plain words only, no filters).
import './docs.css'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DocSearchResult } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { goToPage, searchDocs } from '../../state/docs'
import { closeSearch } from '../../state/search'
import { highlighted } from './DocsView'
import { PageIcon } from './icons'

const FILTER = /(^|\s)(from|in|has|before|after):/i

export function DocSearchHits({ server, query }: { server: ServerState; query: string }) {
  const { t } = useTranslation()
  const [hits, setHits] = useState<DocSearchResult[]>([])
  const hasDocs = server.channels.some((c) => c.kind === 'docs')

  useEffect(() => {
    setHits([])
    if (!hasDocs || !query.trim() || FILTER.test(query)) return
    let live = true
    searchDocs(server.key, query).then((r) => live && setHits(r.slice(0, 5)), () => undefined)
    return () => {
      live = false
    }
  }, [server.key, query, hasDocs])

  if (!hits.length) return null
  const channelName = (id: number) => server.channels.find((c) => c.id === id)?.name ?? ''
  return (
    <section className="doc-hits" aria-label={t('docs.search.pages')}>
      <p className="search-note muted">{t('docs.search.pages')}</p>
      <ul className="result-list">
        {hits.map((hit) => (
          <li key={hit.page.id}>
            <button className="result-card" onClick={() => {
              goToPage(server.key, hit.page.channelId, hit.page.id)
              if (window.matchMedia('(max-width: 760px)').matches) closeSearch()
            }}>
              <span className="result-where">#{channelName(hit.page.channelId)}</span>
              <span className="result-row">
                <span className="doc-hit-icon"><PageIcon size={18} /></span>
                <span className="result-body">
                  <strong>{hit.page.title}</strong>
                  <span className="result-text">{highlighted(hit)}</span>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

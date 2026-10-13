import { describe, expect, it } from 'vitest'
import { closeSearch, openSearch, resultCount, setSearchText, useSearch } from './search'

describe('search result count', () => {
  // It counts messages: docs pages that match are listed apart, under "Pages".
  it('says 1000+ when the server stopped counting', () => {
    expect(resultCount(1, false)).toBe('1 message')
    expect(resultCount(12, false)).toBe('12 messages')
    expect(resultCount(1000, true)).toBe('1000+ messages')
  })
})

describe('the search box', () => {
  it('keeps what was typed when the panel opens, and empties when it closes', () => {
    setSearchText('flour')
    openSearch('server-a')
    expect(useSearch.getState()).toMatchObject({ key: 'server-a', text: 'flour' })
    useSearch.setState({ searched: 'flour', total: 2 })
    closeSearch()
    expect(useSearch.getState()).toMatchObject({ key: null, text: '', searched: '', total: 0 })
  })
})

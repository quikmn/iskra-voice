// ":par" in the composer suggests emoji (server emoji first); Enter/Tab picks, arrows move, Esc dismisses.
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { serverFileUrl, useOwnEmojis } from '../../state/expressions'
import { completeEmoji, emojiQueryAt, searchEmoji, type EmojiResult } from './emoji'
import { useTranslation } from 'react-i18next'

export function useEmojiSuggest(
  serverKey: string, text: string, caret: number, apply: (next: { text: string; caret: number }) => void,
): { open: boolean; onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean; popup: ReactNode } {
  const { t } = useTranslation()
  const emojis = useOwnEmojis(serverKey)
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const query = emojiQueryAt(text, caret)
  const results = query && query !== dismissed ? searchEmoji(query, emojis, 8) : []
  const active = results.length ? pick % results.length : 0

  const choose = (r: EmojiResult) => {
    apply(completeEmoji(text, caret, r.kind === 'custom' ? `:${r.emoji.name}:` : r.char))
    setPick(0)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!results.length) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length)
      return true
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault()
      choose(results[active])
      return true
    }
    if (e.key === 'Escape') {
      setDismissed(query)
      return true
    }
    return false
  }

  const popup = results.length > 0 && (
    <div className="mention-popup emoji-suggest" role="listbox" aria-label={t('expressions.suggest')}>
      {results.map((r, i) => {
        const label = r.kind === 'custom' ? r.emoji.name : r.name
        return (
          <button
            key={r.kind === 'custom' ? r.emoji.id : r.char}
            role="option"
            aria-selected={i === active}
            className={i === active ? 'active' : ''}
            onMouseDown={(e) => {
              e.preventDefault()
              choose(r)
            }}
          >
            <span className="suggest-glyph">
              {r.kind === 'custom' ? <img className="custom-emoji" src={serverFileUrl(serverKey, r.emoji.url) ?? undefined} alt="" /> : r.char}
            </span>
            :{label}:
          </button>
        )
      })}
    </div>
  )

  return { open: results.length > 0, onKeyDown, popup }
}

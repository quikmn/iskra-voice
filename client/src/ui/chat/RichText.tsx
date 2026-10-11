// Pieces markdown.tsx renders for richer text: highlighted code with a copy button, masked links that ask before
// leaving, and timestamps shown in the reader's own time zone.
import { useState, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Modal } from '../bits'
import { Copy } from '../icons'
import { formatTimestamp, highlight, type TimestampStyle } from './richTextRules'
import './rich-text.css'

export function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  const { t } = useTranslation()
  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard not allowed */
    }
  }
  return (
    <div className="code-wrap">
      <pre className="code-block" data-language={language || undefined}>
        <code>
          {language ? highlight(code, language).map((tok, i) => (tok.kind === 'plain' ? tok.text : <span key={i} className={`tok-${tok.kind}`}>{tok.text}</span>)) : code}
        </code>
      </pre>
      <button className="code-copy" onClick={() => void copy()} aria-label={t('chat.richText.copyCode')} title={t('chat.richText.copyCode')}>
        {copied ? t('common.copied') : <Copy size={14} />}
      </button>
    </div>
  )
}

/** [text](https://…): the text is the sender's choice, so opening asks first and shows where it really goes. */
export function MaskedLink({ url, children }: { url: string; children: ReactNode }) {
  const [asking, setAsking] = useState(false)
  const { t } = useTranslation()
  let host = url
  try {
    host = new URL(url).host
  } catch {
    /* shown as is */
  }
  return (
    <>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="masked-link"
        title={url}
        onClick={(e) => {
          e.preventDefault()
          setAsking(true)
        }}
      >
        {children}
      </a>
      {asking && (
        <Modal
          title={t('chat.richText.leaving')}
          onClose={() => setAsking(false)}
          footer={
            <>
              <button className="button" onClick={() => setAsking(false)}>{t('chat.richText.goBack')}</button>
              <button
                className="button primary"
                onClick={() => {
                  window.open(url, '_blank', 'noopener,noreferrer')
                  setAsking(false)
                }}
              >
                {t('chat.richText.openLink')}
              </button>
            </>
          }
        >
          <p><Trans i18nKey="chat.richText.linkGoesTo" values={{ host }} components={{ b: <strong /> }} /></p>
          <p className="masked-url"><code>{url}</code></p>
        </Modal>
      )}
    </>
  )
}

export function Timestamp({ ms, style }: { ms: number; style: TimestampStyle }) {
  useTranslation() // re-render in a new language
  return (
    <time className="md-timestamp" dateTime={new Date(ms).toISOString()} title={formatTimestamp(ms, 'F')}>
      {formatTimestamp(ms, style)}
    </time>
  )
}

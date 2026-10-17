// The Assistant panel: a side panel on wide screens, a sheet on phones. A chat with the user's own AI, approval cards
// for every change its tools (or a local MCP client) want to make, bot invite links shown only here, and the local
// "Assistant activity" list. All text is rendered by React; the model's answers go through the safe markdown renderer.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  clearActivity, closeAssistant, decide, dismissSecret, newConversation, sendToAssistant, stopAssistant, useAssistant, type ShownSecret,
} from '../../state/assistant/assistant'
import { isConfigured, type ProviderErrorCode } from '../../state/assistant/providers'
import { isLocalUrl, providerHost } from '../../state/assistant/url'
import type { ActivityEntry, ApprovalRequest } from '../../state/assistant/tools/registry'
import type { Turn } from '../../state/assistant/types'
import { effectiveColor, type ThemeFile } from '../../theme/theme'
import { openMySettings } from '../settings/open'
import { renderMarkdown } from '../markdown'
import { useEscapeLayer } from '../layers'
import { Close } from '../icons'
import './assistant.css'

export function Sparkle({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5zM18.5 15l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z" fill="currentColor" />
    </svg>
  )
}

/** The rail button, while the assistant is turned on. */
export function AssistantButton({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const enabled = useAssistant((s) => s.config.enabled)
  const waiting = useAssistant((s) => s.approvals.length)
  if (!enabled) return null
  return (
    <button className="server-icon assistant-icon" title={t('assistant.open')} aria-label={t('assistant.open')}
      onClick={() => {
        useAssistant.setState((s) => ({ open: !s.open }))
        onNavigate?.()
      }}>
      <Sparkle size={22} />
      {waiting > 0 && <span className="badge">{waiting}</span>}
    </button>
  )
}

/** Mounted once in the shell. */
export function AssistantLayer() {
  const open = useAssistant((s) => s.open && s.config.enabled)
  return open ? <AssistantPanel /> : null
}

function AssistantPanel() {
  const { t } = useTranslation()
  const tab = useAssistant((s) => s.tab)
  const config = useAssistant((s) => s.config)
  useEscapeLayer(closeAssistant, true)
  const host = providerHost(config.baseUrl) ?? ''
  const ready = isConfigured(config)
  return (
    <section className="assistant-panel" role="dialog" aria-modal="false" aria-label={t('assistant.title')} data-testid="assistant-panel">
      <header className="assistant-head">
        <Sparkle />
        <h2>{t('assistant.title')}</h2>
        <div className="segmented assistant-tabs" role="tablist">
          {(['chat', 'activity'] as const).map((x) => (
            <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => useAssistant.setState({ tab: x })}>
              {t(`assistant.tabs.${x}`)}
            </button>
          ))}
        </div>
        <button className="icon-button" title={t('assistant.settings')} aria-label={t('assistant.settings')} onClick={() => openMySettings('assistant')}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4-2.1-1.6zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" fill="currentColor" /></svg>
        </button>
        <button className="icon-button" title={t('assistant.close')} aria-label={t('assistant.close')} onClick={closeAssistant}><Close /></button>
      </header>
      {host && (
        <p className="assistant-privacy" data-testid="assistant-privacy">
          {t(isLocalUrl(config.baseUrl) ? 'assistant.privacyLocal' : 'assistant.privacy', { host })}
        </p>
      )}
      {tab === 'activity' ? <ActivityList /> : ready ? <Chat /> : <SetUp />}
    </section>
  )
}

function SetUp() {
  const { t } = useTranslation()
  return (
    <div className="assistant-setup">
      <h3>{t('assistant.setUpTitle')}</h3>
      <p className="muted">{t('assistant.setUpBody')}</p>
      <button className="button primary" onClick={() => openMySettings('assistant')}>{t('assistant.setUp')}</button>
    </div>
  )
}

function Chat() {
  const { t } = useTranslation()
  const turns = useAssistant((s) => s.turns)
  const busy = useAssistant((s) => s.busy)
  const error = useAssistant((s) => s.error)
  const ended = useAssistant((s) => s.ended)
  const approvals = useAssistant((s) => s.approvals)
  const secrets = useAssistant((s) => s.secrets)
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [turns.length, approvals.length, secrets.length, busy])

  function submit(text = draft) {
    if (!text.trim() || busy) return
    setDraft('')
    void sendToAssistant(text)
  }

  return (
    <>
      <div className="assistant-log" aria-live="polite">
        {turns.length === 0 && (
          <div className="assistant-empty">
            <p className="muted">{t('assistant.empty')}</p>
            <div className="assistant-examples">
              {(['summarize', 'channel', 'bot'] as const).map((x) => (
                <button key={x} className="chip" onClick={() => submit(t(`assistant.examples.${x}`))}>{t(`assistant.examples.${x}`)}</button>
              ))}
            </div>
            <p className="muted small">{t('assistant.pasteHint')}</p>
          </div>
        )}
        {turns.map((turn, i) => <TurnView key={i} turn={turn} />)}
        {secrets.map((s) => <SecretCard key={s.id} secret={s} />)}
        {approvals.map((a) => <ApprovalCard key={a.id} request={a} />)}
        {busy && approvals.length === 0 && <p className="muted assistant-thinking" role="status">{t('assistant.thinking')}</p>}
        {ended && <p className="muted" role="status">{t(`assistant.ended.${ended}`)}</p>}
        {error && (
          <p className="error-text" role="alert">
            {t(`assistant.errors.${error.code as ProviderErrorCode}`, { status: '' })}{error.detail && error.code !== 'network' ? ` ${error.detail}` : ''}
          </p>
        )}
        <div ref={end} />
      </div>
      <form className="assistant-composer" onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}>
        <textarea value={draft} rows={2} maxLength={20_000} placeholder={t('assistant.placeholder')} aria-label={t('assistant.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }} />
        <div className="assistant-composer-buttons">
          {turns.length > 0 && !busy && <button type="button" className="button small" onClick={newConversation}>{t('assistant.newChat')}</button>}
          {busy
            ? <button type="button" className="button small" onClick={stopAssistant}>{t('assistant.stop')}</button>
            : <button type="submit" className="button small primary" disabled={!draft.trim()}>{t('assistant.send')}</button>}
        </div>
      </form>
    </>
  )
}

const md = { nameOf: () => null }

function TurnView({ turn }: { turn: Turn }) {
  const { t } = useTranslation()
  if (turn.role === 'user') return <div className="assistant-msg mine"><span className="assistant-who">{t('assistant.you')}</span><div className="assistant-text">{turn.text}</div></div>
  if (turn.role === 'tool') return null
  return (
    <div className="assistant-msg">
      {turn.text && <div className="assistant-text markdown">{renderMarkdown(turn.text, md)}</div>}
      {turn.toolCalls.length > 0 && <p className="assistant-tools muted">{t('assistant.usedTool', { tools: [...new Set(turn.toolCalls.map((c) => c.name))].join(', ') })}</p>}
    </div>
  )
}

function SecretCard({ secret }: { secret: ShownSecret }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="assistant-card secret" data-testid="assistant-secret">
      <strong>{t('assistant.secret.botInvite', { server: secret.serverName })}</strong>
      <code className="assistant-secret-value">{secret.value}</code>
      <p className="muted small">{t('assistant.secret.botInviteHint')}</p>
      <div className="assistant-card-buttons">
        <button className="button small primary" onClick={() => void navigator.clipboard.writeText(secret.value).then(() => setCopied(true))}>
          {copied ? t('assistant.secret.copied') : t('assistant.secret.copy')}
        </button>
        <button className="button small" onClick={() => dismissSecret(secret.id)}>{t('assistant.secret.dismiss')}</button>
      </div>
    </div>
  )
}

/** The action in words; keys come from the tools (assistant.actions.*), arguments are names React renders as text. */
function actionText(t: unknown, summary: ApprovalRequest['summary'] | null, tool: string): string {
  const loose = t as (key: string, options: Record<string, unknown>) => string
  const fallback = loose('assistant.actions.unknown', { tool })
  if (!summary) return fallback
  return loose(`assistant.actions.${summary.key}`, { ...summary.args, tool, defaultValue: fallback })
}

function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const { t } = useTranslation()
  const danger = request.risk === 'destructive'
  return (
    <div className={`assistant-card approval ${danger ? 'danger' : ''}`} role="group" aria-label={t('assistant.approval.title')} data-testid="assistant-approval">
      <div className="assistant-card-top">
        <span className="muted small">{t(request.source === 'mcp' ? 'assistant.approval.titleMcp' : 'assistant.approval.title')}</span>
        <span className={`assistant-risk ${request.risk}`}>{t(`assistant.approval.risk.${request.risk === 'read' ? 'low' : request.risk}`)}</span>
      </div>
      <strong className="assistant-action">{actionText(t, request.summary, request.tool)}</strong>
      {request.serverName && <span className="muted small">{t('assistant.approval.onServer', { server: request.serverName })}</span>}
      {request.texts.length > 0 && (
        <div className="assistant-texts" data-testid="assistant-texts">
          <span className="muted small">{t(request.texts.some((x) => x.field !== 'theme') ? 'assistant.approval.posted' : 'assistant.approval.local')}</span>
          {request.texts.map((x, i) => (
            <div key={i} className="assistant-text-field">
              <span className="muted small">{t(`assistant.approval.fields.${x.field}`)}</span>
              <div className="assistant-text-value">{x.value}</div>
            </div>
          ))}
        </div>
      )}
      {request.preview?.theme && <ThemePreview theme={request.preview.theme} />}
      {request.request && (
        <details className="assistant-raw">
          <summary>{t('assistant.approval.details')}</summary>
          <pre>{`${request.request.type}\n${JSON.stringify(request.request.body, null, 2)}`}</pre>
        </details>
      )}
      <div className="assistant-card-buttons">
        <button className={`button small ${danger ? 'danger' : 'primary'}`} onClick={() => decide(request.id, 'approve')}>{t('assistant.approval.approve')}</button>
        <button className="button small" onClick={() => decide(request.id, 'deny')}>{t('assistant.approval.deny')}</button>
        {request.grantable && (
          <button className="button small subtle" title={t('assistant.approval.sessionHint')} onClick={() => decide(request.id, 'session')}>{t('assistant.approval.session')}</button>
        )}
      </div>
    </div>
  )
}

function ThemePreview({ theme }: { theme: ThemeFile }) {
  const { t } = useTranslation()
  const c = (key: Parameters<typeof effectiveColor>[1]) => effectiveColor(theme, key)
  return (
    <div className="assistant-theme-preview" aria-label={t('assistant.approval.preview')} role="img"
      style={{ background: c('bgDeep'), borderRadius: theme.radius ?? 8 }}>
      <div style={{ background: c('bgSidebar') }} className="side">
        <span style={{ background: c('accent') }} />
        <span style={{ background: c('textMuted') }} />
        <span style={{ background: c('textMuted') }} />
      </div>
      <div style={{ background: c('bgChat'), color: c('textNormal') }} className="main">
        <b style={{ color: c('textHeading') }}>{theme.meta.name}</b>
        <span style={{ color: c('textMuted') }}>Aa Bb Cc</span>
        <span className="pill" style={{ background: c('accent'), color: c('onAccent') }}>OK</span>
      </div>
    </div>
  )
}

function ActivityList() {
  const { t } = useTranslation()
  const activity = useAssistant((s) => s.activity)
  return (
    <div className="assistant-log">
      <p className="muted small">{t('assistant.activity.intro')}</p>
      {activity.length === 0 ? <p className="muted">{t('assistant.activity.empty')}</p> : (
        <>
          <ul className="assistant-activity" data-testid="assistant-activity">
            {activity.map((entry, i) => <ActivityRow key={`${entry.at}-${i}`} entry={entry} />)}
          </ul>
          <button className="button small" onClick={clearActivity}>{t('assistant.activity.clear')}</button>
        </>
      )}
    </div>
  )
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const { t } = useTranslation()
  const when = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const parts: ReactNode[] = [<span key="s" className={`assistant-status ${entry.status}`}>{t(`assistant.activity.status.${entry.status}`)}</span>]
  if (entry.source === 'mcp') parts.push(<span key="m" className="assistant-risk low">{t('assistant.activity.fromMcp')}</span>)
  return (
    <li>
      <div className="assistant-activity-top">{parts}<span className="muted small">{when}</span></div>
      <span>{actionText(t, entry.summary, entry.tool)}</span>
      {entry.serverName && <span className="muted small">{entry.serverName}</span>}
      {entry.detail && entry.status !== 'done' && <span className="muted small">{entry.detail}</span>}
    </li>
  )
}

// Server rules: the welcome screen new members agree on, the "Rules" entry in the channel list, the composer bar
// while you haven't agreed yet, and Settings → Rules for admins.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { activeServerState, useApp, type ServerState } from '../../state/store'
import { acceptRules, closeRules, loadRules, showRules, updateRules, useRules, useServerRules } from '../../state/rules'
import {
  MAX_RULES_LENGTH, MAX_WELCOME_LENGTH, hasRules, rulesProblem, rulesUpdate, shouldAutoOpen, type RulesDraft,
} from '../../state/voiceRulesLogic'
import { renderMarkdown } from '../markdown'
import { Modal, Spinner } from '../bits'
import { MenuItem } from '../organize/OrgMenu'
import './rules.css'

const BookIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6.5a2.5 2.5 0 0 0 0 5H19" />
    <path d="M9 7h6M9 11h4" />
  </svg>
)

function RulesText({ server, text }: { server: ServerState; text: string }) {
  return <div className="rules-text message-text">{renderMarkdown(text, { nameOf: (k) => server.members[k]?.name ?? null, me: server.me?.accountKey })}</div>
}

/** Mounted once: the rules screen for whichever server asked, and opening it by itself on a server you haven't agreed on. */
export function RulesLayer() {
  const open = useRules((s) => s.open)
  const server = useApp((s) => (open ? s.servers[open] : undefined))
  const active = useApp(activeServerState)
  const activeRules = useRules((s) => (active ? s.rules[active.key] : undefined))
  const dismissed = useRules((s) => (active ? s.dismissed[active.key] : undefined))

  useEffect(() => {
    if (active && !useRules.getState().open && shouldAutoOpen(activeRules, dismissed)) showRules(active.key)
  }, [active, activeRules, dismissed])

  if (!open || !server) return null
  return <RulesScreen server={server} />
}

function RulesScreen({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const rules = useServerRules(server.key)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!rules) return null
  const mustAgree = rules.mustAgree

  async function agree() {
    setBusy(true)
    setError(null)
    try {
      await acceptRules(server.key)
      closeRules()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={mustAgree ? t('rules.screen.welcome', { server: server.name }) : t('rules.screen.title', { server: server.name })}
      onClose={closeRules}
      wide
      className="rules-modal"
      footer={mustAgree ? (
        <>
          <button className="button" onClick={closeRules}>{t('rules.screen.notNow')}</button>
          <button className="button primary" disabled={busy} onClick={() => void agree()} data-testid="rules-agree">{t('rules.screen.agree')}</button>
        </>
      ) : (
        <button className="button primary" onClick={closeRules}>{t('common.close')}</button>
      )}
    >
      {rules.welcome && <p className="rules-welcome">{rules.welcome}</p>}
      {mustAgree && <p className="muted rules-lead">{t('rules.screen.lead')}</p>}
      {hasRules(rules) ? <RulesText server={server} text={rules.text} /> : <p className="muted">{t('rules.screen.none')}</p>}
      {!mustAgree && rules.required && rules.agreedVersion >= rules.version && <p className="muted rules-agreed">{t('rules.screen.agreed')}</p>}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

/** "Rules" at the top of the channel list, when the server has any. */
export function RulesButton({ server, onNavigate }: { server: ServerState; onNavigate: () => void }) {
  const { t } = useTranslation()
  const rules = useServerRules(server.key)
  if (!hasRules(rules) || !server.me) return null
  return (
    <button className={`channel rules-button ${rules!.mustAgree ? 'needs' : ''}`} onClick={() => { showRules(server.key); onNavigate() }}
      aria-label={rules!.mustAgree ? t('rules.button.needsLabel') : t('rules.button.label')}>
      <span className="hash"><BookIcon /></span>
      <span className="channel-name">{t('rules.button.name')}</span>
      {rules!.mustAgree && <span className="badge rules-badge">{t('rules.button.agree')}</span>}
    </button>
  )
}

/** "Server rules" in a server's menu (server rail), when it has any. */
export function ServerRulesItem({ serverKey, onDone }: { serverKey: string; onDone: () => void }) {
  const { t } = useTranslation()
  const rules = useServerRules(serverKey)
  if (!hasRules(rules)) return null
  return <MenuItem onClick={() => { onDone(); showRules(serverKey) }}>{t('rules.menuItem')}</MenuItem>
}

/** Shown instead of the composer until you agree. */
export function RulesBar({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  return (
    <div className="composer read-only rules-bar" role="status">
      <BookIcon />
      <span>{t('rules.bar.text')}</span>
      <button className="button primary small" onClick={() => showRules(server.key)}>{t('rules.bar.read')}</button>
    </div>
  )
}

/** Settings → Rules (admins). */
export function RulesSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const rules = useServerRules(server.key)
  const [draft, setDraft] = useState<RulesDraft | null>(null)
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadRules(server.key).catch((e: unknown) => setError(errorMessage(e)))
  }, [server.key])

  useEffect(() => {
    if (rules && !draft) setDraft({ text: rules.text, welcome: rules.welcome, required: rules.required, askEveryone: !rules.required })
  }, [rules, draft])

  if (!draft) return <section className="settings-section"><h2>{t('rules.settings.title')}</h2>{error ? <p className="error-text">{error}</p> : <Spinner />}</section>

  const { body, question } = rulesUpdate(rules, draft)
  const problem = rulesProblem(draft)
  const changed = !rules || body.text !== rules.text || body.welcome !== rules.welcome || body.required !== rules.required || body.reaccept
  const set = (patch: Partial<RulesDraft>) => {
    setDraft({ ...draft, ...patch })
    setSaved(false)
  }

  async function save() {
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      const next = await updateRules(server.key, body)
      setDraft({ text: next.text, welcome: next.welcome, required: next.required, askEveryone: !next.required })
      setSaved(true)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section rules-settings" data-testid="rules-section">
      <h2>{t('rules.settings.title')}</h2>
      <p className="muted">{t('rules.settings.intro')}</p>
      <label className="field">
        <span>{t('rules.settings.welcome')}</span>
        <input value={draft.welcome} maxLength={MAX_WELCOME_LENGTH} placeholder={t('rules.settings.welcomePlaceholder', { server: server.name })} aria-label={t('rules.settings.welcomeLabel')}
          onChange={(e) => set({ welcome: e.target.value })} />
      </label>
      <div className="rules-editor-head">
        <span>{t('rules.settings.rules')}</span>
        <div className="segmented" role="radiogroup" aria-label={t('rules.settings.mode')}>
          <button role="radio" aria-checked={!preview} className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>{t('rules.settings.write')}</button>
          <button role="radio" aria-checked={preview} className={preview ? 'on' : ''} onClick={() => setPreview(true)}>{t('rules.settings.preview')}</button>
        </div>
      </div>
      {preview ? (
        <div className="rules-preview">{draft.text.trim() ? <RulesText server={server} text={draft.text} /> : <p className="muted">{t('rules.settings.nothingToPreview')}</p>}</div>
      ) : (
        <textarea className="rules-input" value={draft.text} rows={10} aria-label={t('rules.settings.rulesLabel')} placeholder={t('rules.settings.placeholder')}
          onChange={(e) => set({ text: e.target.value })} />
      )}
      <small className={`muted rules-count ${draft.text.length > MAX_RULES_LENGTH ? 'over' : ''}`}>{draft.text.length} / {MAX_RULES_LENGTH}</small>

      <label className="checkbox">
        <input type="checkbox" checked={draft.required} onChange={(e) => set({ required: e.target.checked, askEveryone: rules?.required ? false : true })} />
        <span>
          {t('rules.settings.required')}
          <br /><small className="muted">{t('rules.settings.requiredHint')}</small>
        </span>
      </label>
      {question && (
        <label className="checkbox rules-ask">
          <input type="checkbox" checked={draft.askEveryone} onChange={(e) => set({ askEveryone: e.target.checked })} />
          {question === 'existing' ? (
            <span>
              {t('rules.settings.existing')}
              <br /><small className="muted">{t('rules.settings.existingHint')}</small>
            </span>
          ) : (
            <span>
              {t('rules.settings.again')}
              <br /><small className="muted">{t('rules.settings.againHint')}</small>
            </span>
          )}
        </label>
      )}
      {rules?.required && rules.agreed != null && rules.members != null && (
        <p className="muted" data-testid="rules-agreed-count">{t('rules.settings.agreedCount', { agreed: rules.agreed, members: rules.members })}</p>
      )}
      <div className="copy-row">
        <button className="button primary" disabled={!changed || busy || !!problem} onClick={() => void save()}>{t('common.save')}</button>
        {hasRules(rules) && <button className="button" onClick={() => showRules(server.key)}>{t('rules.settings.seeAsMember')}</button>}
        {saved && <span className="muted" role="status">{t('rules.settings.saved')}</span>}
      </div>
      {(problem || error) && <p className="error-text">{problem ?? error}</p>}
    </section>
  )
}

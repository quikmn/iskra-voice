// Server rules: the welcome screen new members agree on, the "Rules" entry in the channel list, the composer bar
// while you haven't agreed yet, and Settings → Rules for admins.
import { useEffect, useState } from 'react'
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
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={mustAgree ? `Welcome to ${server.name}` : `${server.name} rules`}
      onClose={closeRules}
      wide
      className="rules-modal"
      footer={mustAgree ? (
        <>
          <button className="button" onClick={closeRules}>Not now</button>
          <button className="button primary" disabled={busy} onClick={() => void agree()} data-testid="rules-agree">I agree</button>
        </>
      ) : (
        <button className="button primary" onClick={closeRules}>Close</button>
      )}
    >
      {rules.welcome && <p className="rules-welcome">{rules.welcome}</p>}
      {mustAgree && <p className="muted rules-lead">Before you chat, react or join voice here, please read the rules and agree to them.</p>}
      {hasRules(rules) ? <RulesText server={server} text={rules.text} /> : <p className="muted">This server has no rules yet.</p>}
      {!mustAgree && rules.required && rules.agreedVersion >= rules.version && <p className="muted rules-agreed">You agreed to these rules.</p>}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

/** "Rules" at the top of the channel list, when the server has any. */
export function RulesButton({ server, onNavigate }: { server: ServerState; onNavigate: () => void }) {
  const rules = useServerRules(server.key)
  if (!hasRules(rules) || !server.me) return null
  return (
    <button className={`channel rules-button ${rules!.mustAgree ? 'needs' : ''}`} onClick={() => { showRules(server.key); onNavigate() }}
      aria-label={rules!.mustAgree ? 'Server rules: agree to take part' : 'Server rules'}>
      <span className="hash"><BookIcon /></span>
      <span className="channel-name">Rules</span>
      {rules!.mustAgree && <span className="badge rules-badge">Agree</span>}
    </button>
  )
}

/** "Server rules" in a server's menu (server rail), when it has any. */
export function ServerRulesItem({ serverKey, onDone }: { serverKey: string; onDone: () => void }) {
  const rules = useServerRules(serverKey)
  if (!hasRules(rules)) return null
  return <MenuItem onClick={() => { onDone(); showRules(serverKey) }}>Server rules</MenuItem>
}

/** Shown instead of the composer until you agree. */
export function RulesBar({ server }: { server: ServerState }) {
  return (
    <div className="composer read-only rules-bar" role="status">
      <BookIcon />
      <span>Agree to the server rules to chat, react and join voice here.</span>
      <button className="button primary small" onClick={() => showRules(server.key)}>Read the rules</button>
    </div>
  )
}

/** Settings → Rules (admins). */
export function RulesSection({ server }: { server: ServerState }) {
  const rules = useServerRules(server.key)
  const [draft, setDraft] = useState<RulesDraft | null>(null)
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadRules(server.key).catch((e: Error) => setError(e.message))
  }, [server.key])

  useEffect(() => {
    if (rules && !draft) setDraft({ text: rules.text, welcome: rules.welcome, required: rules.required, askEveryone: !rules.required })
  }, [rules, draft])

  if (!draft) return <section className="settings-section"><h3>Rules</h3>{error ? <p className="error-text">{error}</p> : <Spinner />}</section>

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
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section rules-settings" data-testid="rules-section">
      <h3>Rules</h3>
      <p className="muted">
        Shown to new members when they join, and from Rules in the channel list. Formatting works like in messages (**bold**, lists, links).
      </p>
      <label className="field">
        <span>Welcome message (optional)</span>
        <input value={draft.welcome} maxLength={MAX_WELCOME_LENGTH} placeholder={`Welcome to ${server.name}!`} aria-label="Welcome message"
          onChange={(e) => set({ welcome: e.target.value })} />
      </label>
      <div className="rules-editor-head">
        <span>Rules</span>
        <div className="segmented" role="radiogroup" aria-label="Edit or preview">
          <button role="radio" aria-checked={!preview} className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>Write</button>
          <button role="radio" aria-checked={preview} className={preview ? 'on' : ''} onClick={() => setPreview(true)}>Preview</button>
        </div>
      </div>
      {preview ? (
        <div className="rules-preview">{draft.text.trim() ? <RulesText server={server} text={draft.text} /> : <p className="muted">Nothing to preview yet.</p>}</div>
      ) : (
        <textarea className="rules-input" value={draft.text} rows={10} aria-label="Rules" placeholder={'1. Be kind.\n2. No spam or self-promotion.\n3. Keep spoilers in ||spoiler tags||.'}
          onChange={(e) => set({ text: e.target.value })} />
      )}
      <small className={`muted rules-count ${draft.text.length > MAX_RULES_LENGTH ? 'over' : ''}`}>{draft.text.length} / {MAX_RULES_LENGTH}</small>

      <label className="checkbox">
        <input type="checkbox" checked={draft.required} onChange={(e) => set({ required: e.target.checked, askEveryone: rules?.required ? false : true })} />
        <span>
          Members must agree before they can take part
          <br /><small className="muted">Until they agree they can read, but not send messages, react or join voice. You and bots never have to.</small>
        </span>
      </label>
      {question && (
        <label className="checkbox rules-ask">
          <input type="checkbox" checked={draft.askEveryone} onChange={(e) => set({ askEveryone: e.target.checked })} />
          {question === 'existing' ? (
            <span>
              People already here must agree too
              <br /><small className="muted">Otherwise only people who join from now on are asked.</small>
            </span>
          ) : (
            <span>
              Ask everyone to agree again
              <br /><small className="muted">For changes that matter. Small fixes don't need it.</small>
            </span>
          )}
        </label>
      )}
      {rules?.required && rules.agreed != null && rules.members != null && (
        <p className="muted" data-testid="rules-agreed-count">{rules.agreed} of {rules.members} members have agreed to the current rules.</p>
      )}
      <div className="copy-row">
        <button className="button primary" disabled={!changed || busy || !!problem} onClick={() => void save()}>Save</button>
        {hasRules(rules) && <button className="button" onClick={() => showRules(server.key)}>See what members see</button>}
        {saved && <span className="muted" role="status">Saved.</span>}
      </div>
      {(problem || error) && <p className="error-text">{problem ?? error}</p>}
    </section>
  )
}

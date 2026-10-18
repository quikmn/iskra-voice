// Join questions: the layer that shows them on their own (after joining, from the server menu, /roles), the menu item,
// and Server settings → Join questions, where admins write the questions and pick the roles on join.
// Answers only ever give roles members could pick themselves; the server checks that on every save and every answer.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RoleGroup, ServerRole } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import {
  askableGroups, closeRolePicker, createRoleGroup, deleteRoleGroup, openRolePicker, updateRoleGroup, useRoleGroups,
  useServerRoleGroups, useServerRoles,
} from '../../state/roles'
import { applyAutoRoles, setAutoRoles, useAutoRoles } from '../../state/joinQuestions'
import {
  MAX_ANSWER_CHANNELS, MAX_ANSWER_LABEL, MAX_ANSWER_ROLES, MAX_ANSWERS, MAX_AUTO_ROLES, MAX_QUESTIONS, answerName, answersBody,
  answersOf, answersProblem, draftsOf, type AnswerDraft,
} from '../../state/joinQuestionsLogic'
import { openServerSettings } from '../settings/open'
import { useApp, type ServerState } from '../../state/store'
import { MenuItem } from '../organize/OrgMenu'
import { JoinQuestionsFlow } from './JoinQuestions'
import './roles.css'
import './joinQuestions.css'

const RoleName = ({ role }: { role: ServerRole }) => (
  <>
    <span className="role-dot" style={{ background: role.color ?? 'var(--muted)' }} aria-hidden />
    {role.icon && <span aria-hidden>{role.icon}</span>}
    {role.name}
  </>
)

// ── The questions on their own ──────────────────────────────────────────────

/** Mounted once: the join questions on their own (after joining, server menu, /roles). The rules screen shows them after agreeing. */
export function RolePickerLayer() {
  const open = useRoleGroups((s) => s.picker)
  const welcome = useRoleGroups((s) => !!s.pickerWelcome)
  const server = useApp((s) => (open ? s.servers[open] : undefined))
  if (!open || !server) return null
  return <JoinQuestionsFlow key={open} server={server} welcome={welcome} onClose={closeRolePicker} />
}

/** "Change my answers" in a server's menu, when the server asks anything. */
export function PickRolesItem({ server, onDone }: { server: ServerState; onDone: () => void }) {
  const { t } = useTranslation()
  const groups = askableGroups(useServerRoleGroups(server.key), useServerRoles(server.key))
  if (groups.length === 0 || !server.me || server.me.bot) return null
  return <MenuItem onClick={() => { onDone(); openRolePicker(server.key) }}>{t('joinQuestions.flow.menuItem')}</MenuItem>
}

// ── Settings → Join questions ───────────────────────────────────────────────

export function OnboardingSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const groups = useServerRoleGroups(server.key)
  const pickable = roles.filter((r) => r.selfAssign)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <section className="settings-section" data-testid="onboarding-section">
      <h2>{t('joinQuestions.editor.title')}</h2>
      <p className="muted">{t('joinQuestions.editor.intro')}</p>
      <div className="copy-row jq-safety">
        <p className="muted">{t('joinQuestions.editor.safety')}</p>
        {pickable.length === 0 && <button className="button small" onClick={() => openServerSettings(server.key, 'roles')}>{t('joinQuestions.editor.openRoles')}</button>}
      </div>
      {groups.length === 0 ? (
        <p className="empty-note">{t('joinQuestions.editor.noneYet')}</p>
      ) : (
        <ul className="onboarding-list">
          {groups.map((g) => (
            <li key={g.id}>
              {editing === g.id ? (
                <QuestionForm server={server} group={g} pickable={pickable} onDone={() => setEditing(null)} />
              ) : (
                <div className="onboarding-row">
                  <div className="onboarding-text">
                    <span className="onboarding-title">{g.title}</span>
                    {g.required && <span className="badge jq-required">{t('joinQuestions.editor.requiredBadge')}</span>}
                    {g.question && <span className="muted"> · {g.question}</span>}
                    <div className="onboarding-roles muted">
                      {g.multi ? t('joinQuestions.editor.multi') : t('joinQuestions.editor.single')}
                      {' · '}{answersOf(g).answers.map((a) => [a.emoji, answerName(a, roles)].filter(Boolean).join(' ')).filter(Boolean).join(', ')}
                    </div>
                  </div>
                  <span className="spacer" />
                  <button className="button small" onClick={() => setEditing(g.id)} aria-label={t('joinQuestions.editor.edit', { title: g.title })}>{t('common.edit')}</button>
                  <button className="button small danger-outline" aria-label={t('joinQuestions.editor.deleteLabel', { title: g.title })}
                    onClick={() => void deleteRoleGroup(server.key, g.id).then(() => setError(null), (e) => setError(errorMessage(e)))}>
                    {t('common.delete')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing === 'new' ? (
        <QuestionForm server={server} group={null} pickable={pickable} onDone={() => setEditing(null)} />
      ) : (
        <div className="copy-row">
          <button className="button primary" disabled={groups.length >= MAX_QUESTIONS} onClick={() => setEditing('new')}>{t('joinQuestions.editor.add')}</button>
          {askableGroups(groups, roles).length > 0 && <button className="button" onClick={() => openRolePicker(server.key)}>{t('joinQuestions.editor.preview')}</button>}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      <AutoRoles server={server} pickable={pickable} />
    </section>
  )
}

const blank = (): AnswerDraft => ({ label: '', emoji: '', roles: [], channels: [] })
const toggle = (list: number[], id: number, max: number) => (list.includes(id) ? list.filter((x) => x !== id) : list.length >= max ? list : [...list, id])

function QuestionForm({ server, group, pickable, onDone }: { server: ServerState; group: RoleGroup | null; pickable: ServerRole[]; onDone: () => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(group?.title ?? '')
  const [question, setQuestion] = useState(group?.question ?? '')
  const [multi, setMulti] = useState(group?.multi ?? false)
  const [required, setRequired] = useState(group?.required ?? false)
  const [answers, setAnswers] = useState<AnswerDraft[]>(() => (group ? draftsOf(group) : [blank()]))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = group ? t('joinQuestions.editor.edit', { title: group.title }) : t('joinQuestions.editor.add')
  const problem = answersProblem(answers)

  const change = (i: number, patch: Partial<AnswerDraft>) => setAnswers(answers.map((a, j) => (j === i ? { ...a, ...patch } : a)))

  async function save() {
    if (problem) return setError(t(`joinQuestions.editor.${problem}` as 'joinQuestions.editor.needAnswer', { max: problem === 'answerLong' ? MAX_ANSWER_LABEL : MAX_ANSWERS }))
    setBusy(true)
    try {
      const body = { title, question, multi, required, answers: answersBody(answers) }
      if (group) await updateRoleGroup(server.key, group.id, body)
      else await createRoleGroup(server.key, body)
      onDone()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <div className="onboarding-form" role="group" aria-label={label}>
      <label className="field">
        <span>{t('joinQuestions.editor.titleLabel')}</span>
        <input value={title} maxLength={60} placeholder={t('joinQuestions.editor.titlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        <span>{t('joinQuestions.editor.question')}</span>
        <input value={question} maxLength={200} placeholder={t('joinQuestions.editor.questionPlaceholder')} onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <div className="segmented small" role="radiogroup" aria-label={t('joinQuestions.editor.choice')}>
        <button type="button" role="radio" aria-checked={!multi} className={!multi ? 'on' : ''} onClick={() => setMulti(false)}>{t('joinQuestions.editor.single')}</button>
        <button type="button" role="radio" aria-checked={multi} className={multi ? 'on' : ''} onClick={() => setMulti(true)}>{t('joinQuestions.editor.multi')}</button>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        <span>{t('joinQuestions.editor.required')}</span>
      </label>

      <strong>{t('joinQuestions.editor.answers')}</strong>
      <ol className="jq-answer-editors">
        {answers.map((a, i) => (
          <li key={a.id ?? `new-${i}`} className="jq-answer-editor" role="group" aria-label={t('joinQuestions.editor.answerN', { n: i + 1 })}>
            <div className="jq-answer-head">
              <input className="jq-emoji-input" value={a.emoji} maxLength={16} aria-label={t('joinQuestions.editor.emoji')} placeholder="🙂"
                onChange={(e) => change(i, { emoji: e.target.value })} />
              <input className="jq-label-input" value={a.label} maxLength={MAX_ANSWER_LABEL} aria-label={t('joinQuestions.editor.label')}
                placeholder={t('joinQuestions.editor.labelPlaceholder')} onChange={(e) => change(i, { label: e.target.value })} />
              <button type="button" className="icon-button" aria-label={t('joinQuestions.editor.removeAnswer', { n: i + 1 })}
                onClick={() => setAnswers(answers.filter((_, j) => j !== i))}>✕</button>
            </div>
            {!a.label.trim() && a.roles.length > 0 && <small className="muted">{t('joinQuestions.editor.labelHint')}</small>}
            <fieldset className="jq-picks">
              <legend>{t('joinQuestions.editor.roles')}</legend>
              {pickable.length === 0 ? <small className="muted">{t('joinQuestions.editor.noRoles')}</small> : pickable.map((r) => {
                const on = a.roles.includes(r.id)
                return (
                  <button type="button" key={r.id} className={`role-option small ${on ? 'on' : ''}`} role="checkbox" aria-checked={on}
                    disabled={!on && a.roles.length >= MAX_ANSWER_ROLES} onClick={() => change(i, { roles: toggle(a.roles, r.id, MAX_ANSWER_ROLES) })}>
                    <RoleName role={r} />
                  </button>
                )
              })}
            </fieldset>
            <fieldset className="jq-picks">
              <legend>{t('joinQuestions.editor.channels')}</legend>
              {server.channels.map((c) => {
                const on = a.channels.includes(c.id)
                return (
                  <button type="button" key={c.id} className={`role-option small ${on ? 'on' : ''}`} role="checkbox" aria-checked={on}
                    disabled={!on && a.channels.length >= MAX_ANSWER_CHANNELS} onClick={() => change(i, { channels: toggle(a.channels, c.id, MAX_ANSWER_CHANNELS) })}>
                    #{c.name}
                  </button>
                )
              })}
            </fieldset>
          </li>
        ))}
      </ol>
      <div>
        <button type="button" className="button small" disabled={answers.length >= MAX_ANSWERS} onClick={() => setAnswers([...answers, blank()])}>
          {t('joinQuestions.editor.addAnswer')}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="copy-row">
        <button className="button primary" disabled={busy || !title.trim()} onClick={() => void save()}>{t('common.save')}</button>
        <button className="button" disabled={busy} onClick={onDone}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}

/** Roles on join: picked from the roles members could pick themselves; "Give to everyone now" for current members. */
function AutoRoles({ server, pickable }: { server: ServerState; pickable: ServerRole[] }) {
  const { t } = useTranslation()
  const saved = useAutoRoles(server.key)
  const [picked, setPicked] = useState<number[]>(saved)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setPicked(saved), [saved])
  const changed = picked.length !== saved.length || picked.some((id) => !saved.includes(id))

  async function run(action: () => Promise<string>) {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      setStatus(await action())
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="jq-auto" role="group" aria-labelledby="jq-auto-title" data-testid="auto-roles">
      <h3 id="jq-auto-title">{t('joinQuestions.auto.title')}</h3>
      <p className="muted">{t('joinQuestions.auto.intro')}</p>
      {pickable.length === 0 ? <p className="empty-note">{t('joinQuestions.editor.noRoles')}</p> : (
        <div className="jq-picks">
          {pickable.map((r) => {
            const on = picked.includes(r.id)
            return (
              <button type="button" key={r.id} className={`role-option small ${on ? 'on' : ''}`} role="checkbox" aria-checked={on}
                disabled={busy || (!on && picked.length >= MAX_AUTO_ROLES)}
                onClick={() => setPicked(on ? picked.filter((x) => x !== r.id) : [...picked, r.id])}>
                <RoleName role={r} />
              </button>
            )
          })}
        </div>
      )}
      <div className="copy-row">
        <button className="button primary" disabled={busy || !changed} onClick={() => void run(async () => { await setAutoRoles(server.key, picked); return t('joinQuestions.auto.saved') })}>
          {t('joinQuestions.auto.save')}
        </button>
        <button className="button" disabled={busy || changed || saved.length === 0}
          onClick={() => window.confirm(t('joinQuestions.auto.applyConfirm')) && void run(async () => t('joinQuestions.auto.applied', { count: await applyAutoRoles(server.key) }))}>
          {t('joinQuestions.auto.apply')}
        </button>
        {status && <span className="muted" role="status">{status}</span>}
      </div>
      {picked.length >= MAX_AUTO_ROLES && <small className="muted">{t('joinQuestions.auto.max', { max: MAX_AUTO_ROLES })}</small>}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

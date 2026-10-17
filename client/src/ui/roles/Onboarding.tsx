// Roles members pick themselves: the "Pick your roles" screen (after agreeing to the rules, from the server menu,
// and for /roles), and Server settings → Onboarding, where admins write the questions (pick groups) it asks.
// What you hold comes from the server (`member.updated`), never from the tap itself.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RoleGroup, ServerRole } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import {
  askableGroups, closeRolePicker, createRoleGroup, deleteRoleGroup, openRolePicker, pickRole, updateRoleGroup, useRoleGroups,
  useServerRoleGroups, useServerRoles,
} from '../../state/roles'
import { openServerSettings } from '../settings/open'
import { useApp, type ServerState } from '../../state/store'
import { Modal } from '../bits'
import { MenuItem } from '../organize/OrgMenu'
import './roles.css'

const RoleName = ({ role }: { role: ServerRole }) => (
  <>
    <span className="role-dot" style={{ background: role.color ?? 'var(--muted)' }} aria-hidden />
    {role.icon && <span aria-hidden>{role.icon}</span>}
    {role.name}
  </>
)

// ── Pick your roles ─────────────────────────────────────────────────────────

/** The groups as a member answers them. Each tap is one request; the chips follow `server.me.roles`. */
export function RolePicker({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const groups = askableGroups(useServerRoleGroups(server.key), roles)
  const mine = new Set(server.me?.roles ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle(role: ServerRole, on: boolean) {
    setBusy(true)
    try {
      await pickRole(server.key, role.id, on)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (groups.length === 0) return <p className="muted">{t('roles.picker.none')}</p>
  return (
    <div className="role-picker">
      {groups.map((g) => {
        const options = g.roles.map((id) => roles.find((r) => r.id === id && r.selfAssign)).filter((r): r is ServerRole => !!r)
        return (
          <section key={g.id} className="role-picker-group" aria-labelledby={`role-group-${g.id}`}>
            <h3 id={`role-group-${g.id}`}>{g.title}</h3>
            <p className="muted">{g.question || (g.multi ? t('roles.picker.multi') : t('roles.picker.single'))}</p>
            <div className="role-picker-options" role="group" aria-label={g.title}>
              {options.map((r) => {
                const on = mine.has(r.id)
                return (
                  <button key={r.id} type="button" className={`role-option ${on ? 'on' : ''}`} role="checkbox" aria-checked={on} disabled={busy}
                    onClick={() => void toggle(r, !on)}>
                    <RoleName role={r} />
                  </button>
                )
              })}
            </div>
            {g.question && <small className="muted">{g.multi ? t('roles.picker.multi') : t('roles.picker.single')}</small>}
          </section>
        )
      })}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  )
}

/** Mounted once: the picker on its own (server menu, /roles). The rules screen shows the same picker after agreeing. */
export function RolePickerLayer() {
  const { t } = useTranslation()
  const open = useRoleGroups((s) => s.picker)
  const server = useApp((s) => (open ? s.servers[open] : undefined))
  if (!open || !server) return null
  return (
    <Modal title={t('roles.picker.titleFor', { server: server.name })} onClose={closeRolePicker} className="rules-modal"
      footer={<button className="button primary" onClick={closeRolePicker} data-testid="role-picker-done">{t('roles.picker.done')}</button>}>
      <p className="muted rules-lead">{t('roles.picker.intro', { server: server.name })}</p>
      <RolePicker server={server} />
    </Modal>
  )
}

/** "Pick your roles" in a server's menu, when the server asks anything. */
export function PickRolesItem({ server, onDone }: { server: ServerState; onDone: () => void }) {
  const { t } = useTranslation()
  const groups = askableGroups(useServerRoleGroups(server.key), useServerRoles(server.key))
  if (groups.length === 0 || !server.me || server.me.bot) return null
  return <MenuItem onClick={() => { onDone(); openRolePicker(server.key) }}>{t('roles.picker.menuItem')}</MenuItem>
}

// ── Settings → Onboarding ───────────────────────────────────────────────────

export function OnboardingSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const groups = useServerRoleGroups(server.key)
  const pickable = roles.filter((r) => r.selfAssign)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const counts = new Map<number, number>()
  for (const m of Object.values(server.members)) for (const id of m.roles ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)

  return (
    <section className="settings-section" data-testid="onboarding-section">
      <h2>{t('roles.onboarding.title')}</h2>
      <p className="muted">{t('roles.onboarding.intro')}</p>
      {pickable.length === 0 && (
        <div className="copy-row">
          <p className="empty-note">{t('roles.onboarding.needRoles')}</p>
          <button className="button small" onClick={() => openServerSettings(server.key, 'roles')}>{t('roles.onboarding.openRoles')}</button>
        </div>
      )}
      {groups.length === 0 ? (
        pickable.length > 0 && <p className="empty-note">{t('roles.onboarding.noneYet')}</p>
      ) : (
        <ul className="onboarding-list">
          {groups.map((g) => (
            <li key={g.id}>
              {editing === g.id ? (
                <GroupForm server={server} group={g} pickable={pickable} onDone={() => setEditing(null)} />
              ) : (
                <div className="onboarding-row">
                  <div className="onboarding-text">
                    <span className="onboarding-title">{g.title}</span>
                    {g.question && <span className="muted"> · {g.question}</span>}
                    <div className="onboarding-roles muted">
                      {g.multi ? t('roles.onboarding.multi') : t('roles.onboarding.single')} · {g.roles.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean).join(', ') || t('roles.onboarding.noRoles')}
                    </div>
                  </div>
                  <span className="spacer" />
                  <button className="button small" onClick={() => setEditing(g.id)} aria-label={t('roles.onboarding.edit', { title: g.title })}>{t('common.edit')}</button>
                  <button className="button small danger-outline" aria-label={t('roles.onboarding.deleteLabel', { title: g.title })}
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
        <GroupForm server={server} group={null} pickable={pickable} onDone={() => setEditing(null)} />
      ) : (
        <div className="copy-row">
          <button className="button primary" disabled={pickable.length === 0 || groups.length >= 20} onClick={() => setEditing('new')}>{t('roles.onboarding.add')}</button>
          {askableGroups(groups, roles).length > 0 && <button className="button" onClick={() => openRolePicker(server.key)}>{t('roles.onboarding.preview')}</button>}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  )
}

function GroupForm({ server, group, pickable, onDone }: { server: ServerState; group: RoleGroup | null; pickable: ServerRole[]; onDone: () => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(group?.title ?? '')
  const [question, setQuestion] = useState(group?.question ?? '')
  const [multi, setMulti] = useState(group?.multi ?? false)
  const [picked, setPicked] = useState<number[]>(group?.roles ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = group ? t('roles.onboarding.edit', { title: group.title }) : t('roles.onboarding.add')

  async function save() {
    setBusy(true)
    try {
      if (group) await updateRoleGroup(server.key, group.id, { title, question, multi, roles: picked })
      else await createRoleGroup(server.key, { title, question, multi, roles: picked })
      onDone()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <div className="onboarding-form" role="group" aria-label={label}>
      <label className="field">
        <span>{t('roles.onboarding.groupTitle')}</span>
        <input value={title} maxLength={60} placeholder={t('roles.onboarding.groupTitlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        <span>{t('roles.onboarding.question')}</span>
        <input value={question} maxLength={200} placeholder={t('roles.onboarding.questionPlaceholder')} onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <div className="segmented small" role="radiogroup" aria-label={t('roles.onboarding.choice')}>
        <button type="button" role="radio" aria-checked={!multi} className={!multi ? 'on' : ''} onClick={() => setMulti(false)}>{t('roles.onboarding.single')}</button>
        <button type="button" role="radio" aria-checked={multi} className={multi ? 'on' : ''} onClick={() => setMulti(true)}>{t('roles.onboarding.multi')}</button>
      </div>
      <strong>{t('roles.onboarding.rolesLabel')}</strong>
      <ul className="role-checks">
        {pickable.map((r) => (
          <li key={r.id}>
            <label className="checkbox">
              <input type="checkbox" checked={picked.includes(r.id)} disabled={!picked.includes(r.id) && picked.length >= 25}
                onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((id) => id !== r.id))} />
              <RoleName role={r} />
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="error-text">{error}</p>}
      <div className="copy-row">
        <button className="button primary" disabled={busy || !title.trim() || picked.length === 0} onClick={() => void save()}>{t('common.save')}</button>
        <button className="button" disabled={busy} onClick={onDone}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}

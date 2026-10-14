// Settings → Roles: the built-in roles (Owner … Guest) above the custom ones. Each shows its colour, how many people hold
// it and, opened, what it can do (from the server's own table). Their colour and powers are adjustable (powers within
// the server's safety rules: never the owner's, only below your own role, only powers you have); names are fixed.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BaseAbility, Permission, Role } from '../../core/protocol'
import {
  adjustablePowers, BASE_ROLES, baseRoleCounts, baseRoleName, canAdjustBaseRole, canStyleBaseRole, describeBaseRole, powerChanges, resetBaseRole,
  updateBaseRole, updateBaseRolePowers, useServerBaseRoles,
} from '../../state/baseRoles'
import { useServerRoles } from '../../state/roles'
import { baseAllows, has, permissionHint, permissionLabel } from '../../state/permissions'
import { errorMessage } from '../../i18n/errors'
import type { ServerState } from '../../state/store'

export function BuiltinRoles({ server, selected, onSelect }: { server: ServerState; selected: Role | null; onSelect: (role: Role | null) => void }) {
  const { t } = useTranslation()
  const list = useServerBaseRoles(server.key)
  const counts = baseRoleCounts(server.members)
  return (
    <>
      <h3 className="roles-subhead">{t('roles.base.title')}</h3>
      <p className="muted">{t('roles.base.intro')}</p>
      <ol className="builtin-role-list" aria-label={t('roles.base.title')}>
        {BASE_ROLES.map((id) => {
          const info = list.find((b) => b.id === id)
          return (
            <li key={id} className={`role-row ${selected === id ? 'selected' : ''}`} data-base-role={id}>
              <button className="role-pick" onClick={() => onSelect(selected === id ? null : id)} aria-expanded={selected === id}>
                <span className="role-dot" style={{ background: info?.color ?? 'var(--muted)' }} aria-hidden />
                <span className="builtin-role-name">{baseRoleName(id)}</span>
                <span className="pill builtin-badge">{t('roles.base.badge')}</span>
                {info?.changed && <span className="pill builtin-changed">{t('roles.base.changedBadge')}</span>}
                <span className="muted">{counts[id]}</span>
              </button>
            </li>
          )
        })}
      </ol>
      {selected && <BuiltinRoleDetails key={selected} server={server} role={selected} />}
    </>
  )
}

function BuiltinRoleDetails({ server, role }: { server: ServerState; role: Role }) {
  const { t } = useTranslation()
  const list = useServerBaseRoles(server.key)
  const roles = useServerRoles(server.key)
  const info = list.find((b) => b.id === role)
  const [color, setColor] = useState(info?.color ?? null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const editable = canStyleBaseRole(server.me, roles, role, list)
  const { below, abilities, permissions } = describeBaseRole(list, role)
  const name = baseRoleName(role)
  const changes = powerChanges(info)
  const [powersStatus, setPowersStatus] = useState<string | null>(null) // kept here: the editor remounts after a save

  async function save() {
    try {
      await updateBaseRole(server.key, role, color ?? '')
      setError(null)
      setStatus(t('common.saved'))
    } catch (e) {
      setError(errorMessage(e))
      setStatus(null)
    }
  }

  return (
    <div className="role-editor builtin-role-details" role="group" aria-label={t('roles.base.about', { name })}>
      <p className="builtin-summary"><strong>{name}</strong> · {t(`roles.base.summary.${role}`)}</p>
      <p className="muted">{t('roles.base.channels', { role: name })}</p>
      {info?.changed ? (
        <>
          <p>{t('roles.base.canNow')}</p>
          <ul className="builtin-abilities">
            {info.abilities.map((a) => <li key={a}>{t(`roles.base.abilities.${a}`)}</li>)}
            {info.permissions.length > 0 && <li>{t('roles.base.permissionsList')} {info.permissions.map(permissionLabel).join(', ')}</li>}
            {info.abilities.length + info.permissions.length === 0 && <li className="muted">{t('roles.base.nothingSpecial')}</li>}
          </ul>
          <p className="muted small-text" data-testid="base-role-changed">
            {t('roles.base.changedNote', { added: changes.added.length, removed: changes.removed.length })}
          </p>
        </>
      ) : (
        <>
          {below && <p>{t('roles.base.everythingOf', { role: baseRoleName(below) })}</p>}
          {abilities.length + permissions.length === 0 ? (
            below && <p className="muted">{t('roles.base.nothingMore')}</p>
          ) : (
            <ul className="builtin-abilities">
              {abilities.map((a) => <li key={a}>{t(`roles.base.abilities.${a}`)}</li>)}
              {permissions.length > 0 && (
                <li>
                  {t('roles.base.everyPermission')} {permissions.map(permissionLabel).join(', ')}
                </li>
              )}
            </ul>
          )}
        </>
      )}
      {role === 'owner' ? <p className="muted small-text">{t('roles.base.ownerFixed')}</p> : <PowersEditor key={`${info?.abilities.join()}|${info?.permissions.join()}`} server={server} role={role} status={powersStatus} onStatus={setPowersStatus} />}
      <div className="field">
        <span>{t('roles.colour')}</span>
        <div className="copy-row">
          <input type="color" className="color-input" value={color ?? '#99aab5'} disabled={!editable} aria-label={t('roles.colourLabel')}
            onChange={(e) => setColor(e.target.value)} />
          <button className="button small" disabled={!editable || !color} onClick={() => setColor(null)}>{t('roles.noColour')}</button>
          {editable && <button className="button primary small" onClick={() => void save()}>{t('roles.base.saveColour')}</button>}
          {status && <span className="muted" role="status">{status}</span>}
        </div>
        <small className="muted">{editable ? t('roles.base.colourOrder') : t('roles.base.colourLocked')}</small>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

function toggle<T>(items: T[], item: T, on: boolean): T[] {
  return on ? [...items, item] : items.filter((x) => x !== item)
}

/** Ticks for what the role may get (remounted when the server's list changes); only roles below your own, only powers you have yourself (the server checks the same). */
function PowersEditor({ server, role, status, onStatus }: { server: ServerState; role: Role; status: string | null; onStatus: (status: string | null) => void }) {
  const { t } = useTranslation()
  const list = useServerBaseRoles(server.key)
  const roles = useServerRoles(server.key)
  const info = list.find((b) => b.id === role)
  const [abilities, setAbilities] = useState<BaseAbility[]>(info?.abilities ?? [])
  const [permissions, setPermissions] = useState<Permission[]>(info?.permissions ?? [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const adjustable = adjustablePowers(info)
  // Older servers: powers are fixed there.
  if (!info?.adjustable || adjustable.abilities.length + adjustable.permissions.length === 0) {
    return <p className="muted small-text">{t('roles.base.fixed')}</p>
  }
  const me = server.me
  const editable = canAdjustBaseRole(me, roles, role, list)
  const mineAbility = (a: BaseAbility) => baseAllows(list, me, a)
  const minePermission = (p: Permission) => has(me, roles, p, list)
  const dirty = abilities.length !== info.abilities.length || abilities.some((a) => !info.abilities.includes(a))
    || permissions.length !== info.permissions.length || permissions.some((p) => !info.permissions.includes(p))
  const limited = role === 'member' || role === 'guest'

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      setError(null)
      onStatus(t('common.saved'))
    } catch (e) {
      setError(errorMessage(e))
      onStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset className="builtin-powers" disabled={!editable || busy} aria-label={t('roles.base.powersTitle', { name: baseRoleName(role) })}>
      <div className="role-perms-head"><strong>{t('roles.base.powersTitle', { name: baseRoleName(role) })}</strong></div>
      <p className="muted small-text">{limited ? t('roles.base.powersLimited') : t('roles.base.powersIntro')}</p>
      <ul className="role-perms">
        {adjustable.abilities.map((a) => (
          <li key={a}>
            <label className="checkbox" title={mineAbility(a) ? undefined : t('roles.base.notYours')}>
              <input type="checkbox" checked={abilities.includes(a)} disabled={!mineAbility(a)} data-ability={a}
                onChange={(e) => setAbilities(toggle(abilities, a, e.target.checked))} />
              <span><span>{t(`roles.base.abilities.${a}`)}</span></span>
            </label>
          </li>
        ))}
        {adjustable.permissions.map((p) => (
          <li key={p}>
            <label className="checkbox" title={minePermission(p) ? undefined : t('roles.base.notYours')}>
              <input type="checkbox" checked={permissions.includes(p)} disabled={!minePermission(p)} data-permission={p}
                onChange={(e) => setPermissions(toggle(permissions, p, e.target.checked))} />
              <span>
                <span>{permissionLabel(p)}</span>
                <small className="muted">{permissionHint(p)}</small>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {!editable && <p className="muted small-text">{t('roles.base.powersLocked')}</p>}
      {error && <p className="error-text">{error}</p>}
      {editable && (
        <div className="copy-row role-editor-actions">
          <button className="button primary small" disabled={!dirty}
            onClick={() => void run(() => updateBaseRolePowers(server.key, role, abilities, permissions))}>
            {t('roles.base.savePowers')}
          </button>
          {info.changed && (
            <button className="button small" onClick={() => void run(() => resetBaseRole(server.key, role))}>{t('roles.base.reset')}</button>
          )}
          {status && <span className="muted" role="status">{status}</span>}
        </div>
      )}
    </fieldset>
  )
}

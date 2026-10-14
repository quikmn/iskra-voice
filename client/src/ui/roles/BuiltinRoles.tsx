// Settings → Roles: the built-in roles (Owner … Guest) above the custom ones. Each shows its colour, how many people hold
// it and, opened, what it can do (from the server's own table). Their colour is adjustable; names and powers are fixed.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Role } from '../../core/protocol'
import {
  BASE_ROLES, baseRoleCounts, baseRoleName, canStyleBaseRole, describeBaseRole, updateBaseRole, useServerBaseRoles,
} from '../../state/baseRoles'
import { useServerRoles } from '../../state/roles'
import { permissionLabel } from '../../state/permissions'
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
  const editable = canStyleBaseRole(server.me, roles, role)
  const { below, abilities, permissions } = describeBaseRole(list, role)
  const name = baseRoleName(role)

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
      <p className="muted small-text">{t('roles.base.fixed')}</p>
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

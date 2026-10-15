import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useServerRoles } from '../../state/roles'
import { has } from '../../state/permissions'
import { useApp, type ServerState } from '../../state/store'
import {
  DUCK_CHOICES, listsFor, MAX_PEOPLE, saveList, setPrioritySettings, useWhisper, type WhisperList,
} from '../../state/whisper'
import { keysAreGlobal } from '../../state/hotkeys'
import { HotkeyRows } from '../dialogs/HotkeySettings'
import { Close } from '../icons'
import './whisper.css'

function ListEditor({ server, list }: { server: ServerState; list: WhisperList }) {
  const { t } = useTranslation()
  const kind = list.target?.kind ?? 'off'
  const people = list.target?.kind === 'people' ? list.target.people : []
  const voiceChannels = server.channels.filter((c) => c.kind === 'voice')
  const me = server.me?.accountKey
  const candidates = Object.values(server.members)
    .filter((m) => m.accountKey !== me && !m.bot && !people.includes(m.accountKey))
    .sort((a, b) => a.name.localeCompare(b.name))
  const update = (patch: Partial<WhisperList>) => saveList(server.key, { ...list, ...patch })
  const nameId = `whisper-name-${list.slot}`

  return (
    <fieldset className="whisper-list" data-testid={`whisper-list-${list.slot}`}>
      <legend>{t('whisper.listN', { n: list.slot })}</legend>
      <label className="whisper-field" htmlFor={nameId}>
        <span>{t('whisper.name')}</span>
        <input id={nameId} value={list.name} maxLength={32} placeholder={t('whisper.namePlaceholder')} onChange={(e) => update({ name: e.target.value })} />
      </label>
      <div className="segmented" role="radiogroup" aria-label={t('whisper.to')}>
        {(['off', 'people', 'channel'] as const).map((k) => (
          <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''}
            onClick={() => update({
              target: k === 'off' ? null : k === 'people' ? { kind: 'people', people } : voiceChannels[0] ? { kind: 'channel', channelId: voiceChannels[0].id } : null,
            })}
            disabled={k === 'channel' && voiceChannels.length === 0}
          >
            {t(`whisper.${k}`)}
          </button>
        ))}
      </div>
      {kind === 'people' && (
        <div className="whisper-people">
          {people.length > 0 && (
            <ul className="whisper-chips">
              {people.map((key) => {
                const name = server.members[key]?.name ?? t('whisper.someone')
                return (
                  <li key={key} className="whisper-chip">
                    <span>{name}</span>
                    <button className="icon-button small" aria-label={t('whisper.remove', { name })}
                      onClick={() => {
                        const rest = people.filter((k) => k !== key)
                        update({ target: { kind: 'people', people: rest } })
                      }}>
                      <Close size={12} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {people.length < MAX_PEOPLE && (
            <select aria-label={t('whisper.addPerson')} value="" data-testid={`whisper-add-${list.slot}`}
              onChange={(e) => e.target.value && update({ target: { kind: 'people', people: [...people, e.target.value] } })}>
              <option value="">{t('whisper.addPerson')}</option>
              {candidates.map((m) => <option key={m.accountKey} value={m.accountKey}>{m.name}</option>)}
            </select>
          )}
        </div>
      )}
      {kind === 'channel' && list.target?.kind === 'channel' && (
        voiceChannels.length ? (
          <select aria-label={t('whisper.pickChannel')} value={list.target.channelId}
            onChange={(e) => update({ target: { kind: 'channel', channelId: Number(e.target.value) } })}>
            {voiceChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        ) : <p className="muted">{t('whisper.noChannels')}</p>
      )}
      <HotkeyRows actions={[`whisper${list.slot}` as const]} labels={{ [`whisper${list.slot}`]: t('whisper.key') }} />
    </fieldset>
  )
}

/** Settings → Voice & audio: whisper lists (per server, on this device), their keys, and priority speaking. */
export function WhisperSettingsSection() {
  const { t } = useTranslation()
  const order = useApp((s) => s.order)
  const servers = useApp((s) => s.servers)
  const active = useApp((s) => s.activeServer)
  const [picked, setPicked] = useState<string | null>(null)
  const serverKey = picked && servers[picked] ? picked : active && servers[active] ? active : order.find((k) => servers[k])
  const server = serverKey ? servers[serverKey] : undefined
  useWhisper((s) => (serverKey ? s.lists[serverKey] : undefined)) // re-render on changes
  const priority = useWhisper((s) => s.priority)
  const roles = useServerRoles(serverKey ?? '')
  const isPriority = !!server && has(server.me, roles, 'prioritySpeaker')

  return (
    <>
      <section className="settings-section whisper-settings" data-testid="whisper-settings">
        <h2>{t('whisper.title')}</h2>
        <p className="muted">{t('whisper.intro')}</p>
        {order.length > 1 && (
          <label className="whisper-field">
            <span>{t('whisper.server')}</span>
            <select value={serverKey ?? ''} onChange={(e) => setPicked(e.target.value)}>
              {order.filter((k) => servers[k]).map((k) => <option key={k} value={k}>{servers[k].name}</option>)}
            </select>
          </label>
        )}
        {server && (
          <div className="whisper-lists">
            {listsFor(server.key).map((list) => <ListEditor key={`${server.key}-${list.slot}`} server={server} list={list} />)}
          </div>
        )}
        <p className="muted">{keysAreGlobal(['whisper1']) ? t('whisper.keysDesktop') : t('whisper.keysBrowser')}</p>
        <p className="muted">{t('whisper.disabledHere')}</p>
      </section>
      <section className="settings-section whisper-settings">
        <h2>{t('whisper.priority.title')}</h2>
        <p className="muted">{t('whisper.priority.intro')}</p>
        {server && <p>{t(isPriority ? 'whisper.priority.youAre' : 'whisper.priority.youAreNot', { server: server.name })}</p>}
        <label className="checkbox">
          <input type="checkbox" checked={priority.always} onChange={(e) => setPrioritySettings({ always: e.target.checked })} />
          <span>{t('whisper.priority.always')}</span>
        </label>
        <p className="muted">{t('whisper.priority.alwaysHint')}</p>
        <HotkeyRows actions={['priority']} />
        <label className="whisper-field">
          <span>{t('whisper.priority.duck')}</span>
          <select value={priority.duckDb} onChange={(e) => setPrioritySettings({ duckDb: Number(e.target.value) })} data-testid="priority-duck">
            <option value={0}>{t('whisper.priority.duckOff')}</option>
            {DUCK_CHOICES.map((db) => <option key={db} value={db}>{t('whisper.priority.duckDb', { db: -db })}</option>)}
          </select>
        </label>
      </section>
    </>
  )
}



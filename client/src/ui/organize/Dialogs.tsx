// Admin dialogs: naming a category, and a channel's settings (name, who can see and post, slowmode, category, delete).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { t as translate } from '../../i18n'
import { ROLES, type Category, type Channel, type Role } from '../../core/protocol'
import { connectionFor, type ServerState } from '../../state/store'
import { createCategory, moveChannel, renameCategory, useCategories } from '../../state/organize'
import { Modal } from '../bits'
import { RolePicker } from '../dialogs/CreateChannelDialog'
import { slowmodeLabel, SLOWMODE_STEPS } from '../../state/moderationRules'
import { ChannelOverrides } from '../roles/RoleSettings'
import { UserLimitField } from '../rules/UserLimitField'

export function CategoryDialog({ server, category, onClose }: { server: ServerState; category?: Category; onClose: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(category?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()

  async function save() {
    if (!trimmed || busy) return
    setBusy(true)
    try {
      if (category) await renameCategory(server.key, category.id, trimmed)
      else await createCategory(server.key, trimmed)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={category ? t('organize.category.rename') : t('organize.category.create')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!trimmed || busy || trimmed === category?.name} onClick={() => void save()}>
            {category ? t('common.save') : t('common.create')}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t('organize.category.name')}</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} placeholder={t('organize.category.placeholder')} />
      </label>
      {!category && <p className="muted">{t('organize.category.hint')}</p>}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

export function ChannelSettingsDialog({ server, channel, onClose }: { server: ServerState; channel: Channel; onClose: () => void }) {
  const { t } = useTranslation()
  const categories = useCategories(server.key)
  const [name, setName] = useState(channel.name)
  const [readRole, setReadRole] = useState<Role>(channel.readRole)
  const [writeRole, setWriteRole] = useState<Role>(channel.writeRole)
  const [categoryId, setCategoryId] = useState<number | null>(channel.categoryId ?? null)
  const [slowmode, setSlowmode] = useState(channel.slowmode ?? 0)
  const [userLimit, setUserLimit] = useState(channel.userLimit ?? 0)
  const [hifi, setHifi] = useState(channel.hifi ?? false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const slug = name.trim().toLowerCase().split(/\s+/).filter(Boolean).join('-')
  const write = ROLES.indexOf(writeRole) < ROLES.indexOf(readRole) ? readRole : writeRole

  async function act(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    try {
      await action()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const save = () => act(async () => {
    const connection = connectionFor(server.key)
    if (!connection) throw new Error(translate('errors.codes.disconnected'))
    await connection.request('channel.update', {
      id: channel.id, name: slug, readRole, writeRole: write, slowmode,
      userLimit: channel.kind === 'voice' ? userLimit : undefined,
      hifi: channel.kind === 'voice' && hifi !== (channel.hifi ?? false) ? hifi : undefined,
    })
    if (categoryId !== (channel.categoryId ?? null)) await moveChannel(server.key, channel.id, categoryId, null)
  })

  return (
    <Modal
      title={t('organize.channelSettings.title', { name: `${channel.kind === 'text' || channel.kind === 'forum' ? '#' : ''}${channel.name}` })}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!slug || busy} onClick={() => void save()}>{t('common.save')}</button>
        </>
      }
    >
      <label className="field">
        <span>{t('organize.channelSettings.name')}</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      </label>
      <div className="options-row">
        <RolePicker label={t('organize.channelSettings.whoSees')} value={readRole} onChange={setReadRole} />
        <RolePicker
          label={channel.kind === 'voice' ? t('organize.channelSettings.whoSpeaks') : channel.kind === 'stage' ? t('organize.channelSettings.whoAsks') : channel.kind === 'docs' ? t('docs.channel.whoCanEdit') : t('organize.channelSettings.whoPosts')}
          value={write} onChange={setWriteRole} min={readRole} />
      </div>
      <label className="field">
        <span>{slowmode ? t('organize.channelSettings.slowmodeOn', { every: slowmodeLabel(slowmode) }) : t('organize.channelSettings.slowmodeOff')}</span>
        <input
          type="range" min={0} max={SLOWMODE_STEPS.length - 1} step={1} aria-label={t('organize.channelSettings.slowmodeLabel')}
          value={Math.max(0, SLOWMODE_STEPS.indexOf(slowmode as (typeof SLOWMODE_STEPS)[number]))}
          onChange={(e) => setSlowmode(SLOWMODE_STEPS[Number(e.target.value)])}
        />
        <small className="muted">{t('organize.channelSettings.slowmodeHint')}</small>
      </label>
      {channel.kind === 'voice' && <UserLimitField value={userLimit} onChange={setUserLimit} />}
      {channel.kind === 'voice' && (
        <div className="field">
          <label className="checkbox">
            <input type="checkbox" checked={hifi} onChange={(e) => setHifi(e.target.checked)} />
            {t('organize.channelSettings.hifi')}
          </label>
          <small className="muted">{t('organize.channelSettings.hifiHint')}</small>
        </div>
      )}
      <ChannelOverrides server={server} channel={channel} />
      <label className="field inline">
        <span>{t('organize.channelSettings.category')}</span>
        <select value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{t('organize.channelSettings.noCategory')}</option>
          {[...categories].sort((a, b) => a.position - b.position).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <div className="settings-danger">
        <div>
          <strong>{t('organize.channelSettings.deleteTitle')}</strong>
          <p className="muted">{t('organize.channelSettings.deleteHint')}</p>
        </div>
        {confirmDelete ? (
          <div className="copy-row">
            <button className="button danger" disabled={busy}
              onClick={() => void act(() => connectionFor(server.key)!.request('channel.delete', { id: channel.id }))}>
              {t('common.delete')}
            </button>
            <button className="button" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button>
          </div>
        ) : (
          <button className="button danger-outline" onClick={() => setConfirmDelete(true)}>{t('organize.channelSettings.deleteTitle')}</button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

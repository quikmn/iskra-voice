import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { ROLES, type Role } from '../../core/protocol'
import { connectionFor, selectChannel, type ServerState } from '../../state/store'
import { Modal } from '../bits'
import { useCategories } from '../../state/organize'
import { Hash, Volume } from '../icons'
import { StageIcon } from '../stage/stageIcons'
import { ForumIcon } from '../forums/icons'
import { DocsIcon } from '../docs/icons'
import { createEncryptedChannel, readersFor } from '../../state/e2eeChannels'
import { MAX_CHANNEL_MEMBERS } from '../../core/channelChain'
import { EncryptedCreateNote, e2eeText } from '../e2ee/E2ee'

export function CreateChannelDialog({ server, categoryId: initialCategory = null, onClose }: { server: ServerState; categoryId?: number | null; onClose: () => void }) {
  const { t } = useTranslation()
  const categories = useCategories(server.key)
  const [categoryId, setCategoryId] = useState<number | null>(initialCategory)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'text' | 'voice' | 'forum' | 'stage' | 'docs'>('text')
  const [readRole, setReadRole] = useState<Role>('member')
  const [writeRole, setWriteRole] = useState<Role>('member')
  const [encrypted, setEncrypted] = useState(false)
  const canEncrypt = kind === 'text' || kind === 'voice'
  const readers = encrypted && canEncrypt ? readersFor(server.key, readRole).length : 0
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const slug = name.trim().toLowerCase().split(/\s+/).filter(Boolean).join('-')

  async function create() {
    if (!slug || busy || readers > MAX_CHANNEL_MEMBERS) return
    setBusy(true)
    try {
      const spec = {
        name: slug, kind, readRole, writeRole: ROLES.indexOf(writeRole) < ROLES.indexOf(readRole) ? readRole : writeRole,
        categoryId: categoryId ?? undefined,
      }
      const channel = encrypted && (kind === 'text' || kind === 'voice')
        ? await createEncryptedChannel(server.key, { ...spec, kind })
        : (await connectionFor(server.key)!.request('channel.create', spec)).channel
      if (channel.kind === 'text' || channel.kind === 'forum' || channel.kind === 'docs') selectChannel(server.key, channel.id)
      onClose()
    } catch (e) {
      setError(e2eeText(errorMessage(e)))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('settings.channel.title')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!slug || busy || readers > MAX_CHANNEL_MEMBERS} onClick={() => void create()}>{t('common.create')}</button>
        </>
      }
    >
      <div className="segmented" role="radiogroup" aria-label={t('settings.channel.type')}>
        <button role="radio" aria-checked={kind === 'text'} className={kind === 'text' ? 'on' : ''} onClick={() => setKind('text')}><Hash size={16} /> {t('settings.channel.text')}</button>
        <button role="radio" aria-checked={kind === 'voice'} className={kind === 'voice' ? 'on' : ''} onClick={() => setKind('voice')}><Volume size={16} /> {t('settings.channel.voice')}</button>
        <button role="radio" aria-checked={kind === 'forum'} className={kind === 'forum' ? 'on' : ''} onClick={() => setKind('forum')}><ForumIcon size={16} /> {t('settings.channel.forum')}</button>
        <button role="radio" aria-checked={kind === 'stage'} className={kind === 'stage' ? 'on' : ''} onClick={() => setKind('stage')}><StageIcon size={16} /> {t('settings.channel.stage')}</button>
        <button role="radio" aria-checked={kind === 'docs'} className={kind === 'docs' ? 'on' : ''} onClick={() => {
          setKind('docs')
          // Docs: everyone reads, trusted and above edit (a starting point the admin can change).
          if (ROLES.indexOf(writeRole) < ROLES.indexOf('trusted')) setWriteRole('trusted')
        }}><DocsIcon size={16} /> {t('docs.channel.kind')}</button>
      </div>
      <label className="field">
        <span>{t('settings.overview.name')}</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} placeholder={t('settings.channel.namePlaceholder')} />
      </label>
      {slug && <p className="muted"><Trans i18nKey="settings.channel.appearsAs" values={{ name: `${kind === 'text' || kind === 'forum' ? '#' : ''}${slug}` }} components={{ b: <strong /> }} /></p>}
      {kind === 'forum' && <p className="muted">{t('settings.channel.forumHint')}</p>}
      {kind === 'stage' && <p className="muted">{t('settings.channel.stageHint')}</p>}
      {kind === 'docs' && <p className="muted">{t('docs.channel.hint')}</p>}
      <div className="options-row">
        <RolePicker label={t('settings.channel.whoCanSee')} value={readRole} onChange={setReadRole} />
        <RolePicker label={kind === 'voice' ? t('settings.channel.whoCanSpeak') : kind === 'stage' ? t('settings.channel.whoCanAsk') : kind === 'docs' ? t('docs.channel.whoCanEdit') : t('settings.channel.whoCanPost')} value={writeRole} onChange={setWriteRole} min={readRole} />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={encrypted && canEncrypt} disabled={!canEncrypt} onChange={(e) => setEncrypted(e.target.checked)} data-testid="e2ee-toggle" />
        {t('e2ee.create.toggle')}
      </label>
      {!canEncrypt && encrypted && <p className="muted small-text">{t('e2ee.create.kinds')}</p>}
      {encrypted && canEncrypt && <EncryptedCreateNote count={readers} />}
      {categories.length > 0 && (
        <label className="field inline">
          <span>{t('settings.channel.category')}</span>
          <select value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('settings.channel.noCategory')}</option>
            {[...categories].sort((a, b) => a.position - b.position).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

export function RolePicker({ label, value, onChange, min = 'guest', max = 'owner' }: {
  label: string; value: Role; onChange: (r: Role) => void; min?: Role; max?: Role
}) {
  const { t } = useTranslation()
  const options = ROLES.filter((r) => ROLES.indexOf(r) >= ROLES.indexOf(min) && ROLES.indexOf(r) <= ROLES.indexOf(max))
  return (
    <label className="field inline">
      <span>{label}</span>
      <select value={options.includes(value) ? value : options[0]} onChange={(e) => onChange(e.target.value as Role)}>
        {options.map((r) => <option key={r} value={r}>{t(`common.roles.${r}`)}+</option>)}
      </select>
    </label>
  )
}

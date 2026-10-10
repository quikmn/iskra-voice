import { useState } from 'react'
import { ROLES, type Role } from '../../core/protocol'
import { connectionFor, selectChannel, type ServerState } from '../../state/store'
import { Modal } from '../bits'
import { Hash, Volume } from '../icons'
import { StageIcon } from '../stage/stageIcons'
import { ForumIcon } from '../forums/icons'

export function CreateChannelDialog({ server, onClose }: { server: ServerState; onClose: () => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'text' | 'voice' | 'forum' | 'stage'>('text')
  const [readRole, setReadRole] = useState<Role>('member')
  const [writeRole, setWriteRole] = useState<Role>('member')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const slug = name.trim().toLowerCase().split(/\s+/).filter(Boolean).join('-')

  async function create() {
    if (!slug || busy) return
    setBusy(true)
    try {
      const { channel } = await connectionFor(server.key)!.request('channel.create', {
        name: slug, kind, readRole, writeRole: ROLES.indexOf(writeRole) < ROLES.indexOf(readRole) ? readRole : writeRole,
      })
      if (channel.kind === 'text' || channel.kind === 'forum') selectChannel(server.key, channel.id)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Create channel"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!slug || busy} onClick={() => void create()}>Create</button>
        </>
      }
    >
      <div className="segmented" role="radiogroup" aria-label="Channel type">
        <button role="radio" aria-checked={kind === 'text'} className={kind === 'text' ? 'on' : ''} onClick={() => setKind('text')}><Hash size={16} /> Text</button>
        <button role="radio" aria-checked={kind === 'voice'} className={kind === 'voice' ? 'on' : ''} onClick={() => setKind('voice')}><Volume size={16} /> Voice</button>
        <button role="radio" aria-checked={kind === 'forum'} className={kind === 'forum' ? 'on' : ''} onClick={() => setKind('forum')}><ForumIcon size={16} /> Forum</button>
        <button role="radio" aria-checked={kind === 'stage'} className={kind === 'stage' ? 'on' : ''} onClick={() => setKind('stage')}><StageIcon size={16} /> Stage</button>
      </div>
      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} placeholder="game-night" />
      </label>
      {slug && <p className="muted">Will appear as <strong>{kind === 'text' || kind === 'forum' ? '#' : ''}{slug}</strong></p>}
      {kind === 'forum' && <p className="muted">A forum holds posts with a title, tags and their own replies: good for questions, ideas and plans.</p>}
      {kind === 'stage' && <p className="muted">For talks and listening parties: everyone joins as a listener, and moderators bring people up to speak.</p>}
      <div className="options-row">
        <RolePicker label="Who can see it" value={readRole} onChange={setReadRole} />
        <RolePicker label={kind === 'voice' ? 'Who can speak' : kind === 'stage' ? 'Who can ask to speak' : 'Who can post'} value={writeRole} onChange={setWriteRole} min={readRole} />
      </div>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

export function RolePicker({ label, value, onChange, min = 'guest', max = 'owner' }: {
  label: string; value: Role; onChange: (r: Role) => void; min?: Role; max?: Role
}) {
  const options = ROLES.filter((r) => ROLES.indexOf(r) >= ROLES.indexOf(min) && ROLES.indexOf(r) <= ROLES.indexOf(max))
  return (
    <label className="field inline">
      <span>{label}</span>
      <select value={options.includes(value) ? value : options[0]} onChange={(e) => onChange(e.target.value as Role)}>
        {options.map((r) => <option key={r} value={r}>{r}+</option>)}
      </select>
    </label>
  )
}

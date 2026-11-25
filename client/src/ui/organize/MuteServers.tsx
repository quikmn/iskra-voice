// Mute or unmute several servers in one go: a checklist of your servers and the usual mute durations. Each server
// keeps its own mute (notify.set on each connection), so this is the same as doing it one by one.
import { useState } from 'react'
import { create } from 'zustand'
import { useTranslation } from 'react-i18next'
import { muteServers, useOrganize } from '../../state/organize'
import { MUTE_CHOICES, muteChoiceLabel, muteLabel, notifyKey } from '../../state/organizeLogic'
import { useRail } from '../../state/rail'
import { visibleRail } from '../../state/railLogic'
import { useApp, type ServerState } from '../../state/store'
import { Modal } from '../bits'
import { ServerTile } from '../settings/ServerTile'

const useMuteServers = create<{ open: { picked: string[] } | null }>(() => ({ open: null }))

/** Opens the dialog, with these servers already ticked. */
export const openMuteServers = (picked: string[] = []) => useMuteServers.setState({ open: { picked } })

/** Rendered once by the Shell. */
export function MuteServersLayer() {
  const open = useMuteServers((s) => s.open)
  if (!open) return null
  return <MuteServersDialog picked={open.picked} onClose={() => useMuteServers.setState({ open: null })} />
}

function MuteServersDialog({ picked: initial, onClose }: { picked: string[]; onClose: () => void }) {
  const { t } = useTranslation()
  const servers = useApp((s) => s.servers)
  const order = useApp((s) => s.order)
  const layout = useRail((s) => s.layout)
  const notify = useOrganize((s) => s.notify)
  const clock = useOrganize((s) => s.clock)
  // In the order of the server list (folders flattened); only servers you are a member of can be muted.
  const mine = visibleRail(layout, order)
    .flatMap((item) => (item.kind === 'server' ? [item.key] : item.servers))
    .map((key) => servers[key])
    .filter((server): server is ServerState => !!server?.me)
  const [picked, setPicked] = useState<string[]>(() => initial.filter((key) => mine.some((s) => s.key === key)))
  const [minutes, setMinutes] = useState<number>(MUTE_CHOICES[2].minutes)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string[]>([])
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]))
  const mutedLabel = (key: string) => muteLabel(notify[key]?.[notifyKey(null)]?.mutedUntil ?? null, clock)

  async function apply(mins: number) {
    setBusy(true)
    setFailed([])
    const result = await muteServers(picked, mins)
    setBusy(false)
    if (result.failed.length === 0) return onClose()
    // What worked is done; the rest stay ticked to try again.
    setFailed(result.failed)
    setPicked(result.failed)
  }

  return (
    <Modal
      title={t('organize.muteServers.title')}
      onClose={onClose}
      className="mute-servers"
      footer={
        <>
          <button className="button" disabled={busy || picked.length === 0} onClick={() => void apply(0)}>{t('organize.muteServers.unmute')}</button>
          <button className="button primary" disabled={busy || picked.length === 0} onClick={() => void apply(minutes)}>{t('organize.muteServers.mute')}</button>
        </>
      }
    >
      {mine.length === 0 ? <p className="muted">{t('organize.muteServers.none')}</p> : (
        <>
          <div className="mute-servers-tools">
            <button className="button small ghost" onClick={() => setPicked(mine.map((s) => s.key))}>{t('organize.muteServers.all')}</button>
            <button className="button small ghost" onClick={() => setPicked([])}>{t('organize.muteServers.clear')}</button>
          </div>
          <ul className="mute-servers-list">
            {mine.map((server) => (
              <li key={server.key}>
                <label className="checkbox mute-servers-row">
                  <input type="checkbox" checked={picked.includes(server.key)} onChange={() => toggle(server.key)} />
                  <ServerTile server={server} size="small" />
                  <span className="mute-servers-name">{server.name}</span>
                  {mutedLabel(server.key) && <span className="muted mute-servers-state">{mutedLabel(server.key)}</span>}
                </label>
              </li>
            ))}
          </ul>
          <label className="field">
            <span>{t('organize.muteServers.howLong')}</span>
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {MUTE_CHOICES.map((choice) => <option key={choice.minutes} value={choice.minutes}>{muteChoiceLabel(choice)}</option>)}
            </select>
          </label>
          {failed.length > 0 && (
            <p className="error-text" role="alert">
              {t('organize.muteServers.failed', { servers: failed.map((key) => servers[key]?.name ?? key).join(', ') })}
            </p>
          )}
        </>
      )}
    </Modal>
  )
}

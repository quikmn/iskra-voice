// Small pieces for teams and LFG elsewhere in the app: the bar while you're in a split, the channel menu items, and the
// server menu's "Notify me for LFG".
import { useTranslation } from 'react-i18next'
import type { Channel } from '../../core/protocol'
import { openLfg, setLfgNotify, useLfg } from '../../state/lfg'
import { useServerRoles } from '../../state/roles'
import type { ServerState } from '../../state/store'
import { canSplit, openTeams, splitOf, useSplits } from '../../state/teams'
import { useVoice } from '../../state/voice'
import { MenuItem } from '../organize/OrgMenu'
import type { Run } from '../organize/Menus'
import './teams.css'

/** "Teams for Valheim: team-1 · team-2" while the voice channel you're in is part of a split. */
export function TeamsBar({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const session = useVoice((s) => s.session)
  const splits = useSplits(server.key)
  const roles = useServerRoles(server.key)
  const split = session?.serverKey === server.key ? splitOf(splits, session.channelId) : null
  if (!split) return null
  const mine = split.teams.find((team) => team.channelId === session?.channelId)
  const teams = split.teams.map((team) => team.name).join(' · ')
  return (
    <div className="teams-bar" role="status" data-testid="teams-bar">
      <span className="teams-bar-text">
        {mine ? t('teams.bar.onTeam', { team: mine.name, teams }) : t('teams.bar.split', { teams })}
      </span>
      {canSplit(server, roles) && (
        <button className="button small" onClick={() => openTeams(server.key, split.channelId)}>{t('teams.bringBack')}</button>
      )}
    </div>
  )
}

/** Channel menu: "Split into teams…" for a voice channel, "Looking for group…" for a text channel. */
export function GameNightItems({ server, channel, onClose }: { server: ServerState; channel: Channel; onClose: () => void }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const splits = useSplits(server.key)
  if (channel.kind === 'voice' && canSplit(server, roles)) {
    const active = splitOf(splits, channel.id)
    const here = server.voice[channel.id]?.length ?? 0
    if (!active && here < 2) return null
    return (
      <MenuItem onClick={() => { openTeams(server.key, active?.channelId ?? channel.id); onClose() }}>
        {active ? t('teams.bringBack') : t('teams.menu')}
      </MenuItem>
    )
  }
  if (channel.kind === 'text' && !channel.e2ee) {
    return <MenuItem onClick={() => { openLfg(server.key, channel.id); onClose() }}>{t('lfg.menu')}</MenuItem>
  }
  return null
}

/** Server menu: "Notify me for LFG" (per server, off by default). */
export function LfgNotifyItem({ server, run }: { server: ServerState; run: Run }) {
  const { t } = useTranslation()
  const on = useLfg((s) => s.notify[server.key])
  if (on === undefined) return null // an older server
  return (
    <MenuItem onClick={run(() => setLfgNotify(server.key, !on))} hint={on ? t('lfg.notifyOn') : t('lfg.notifyOff')}>
      {t('lfg.notifyMe')}
    </MenuItem>
  )
}

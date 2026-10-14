// The menu for a person, the same everywhere (member lists, chat authors, DMs, voice, calls, groups, mentions):
// a popover at the pointer on desktop, a sheet on phones. Rendered once by the Shell; opened through userMenuProps.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { b64u } from '../../core/crypto'
import { errorMessage } from '../../i18n/errors'
import { callServers, startCall } from '../../state/calls'
import { nameOf, openConversation, sharedServers, useDms } from '../../state/dms'
import { acceptFriend, addFriend, blockPerson, cancelFriendRequest, ignoreFriend, removeFriend, useFriends, useRelation } from '../../state/friends'
import { useGroupCalls } from '../../state/groupCalls'
import { removeTimeout, setBlocked, timeoutMember, useIsBlocked } from '../../state/moderation'
import { botMember } from '../../state/botDms'
import { durationLabel, timeoutActive, TIMEOUT_OPTIONS } from '../../state/moderationRules'
import { has, isAbove, outranks } from '../../state/permissions'
import { openProfileCard } from '../../state/profile'
import { moveToChannel, serverMute, setMemberRoles, useServerRoles } from '../../state/roles'
import { connectionFor, useApp, type ServerState } from '../../state/store'
import { closeUserMenu, useUserMenu, type UserMenuTarget } from '../../state/userMenu'
import { useVoice } from '../../state/voice'
import { disconnectFromVoice } from '../../state/voiceBots'
import { openReport } from '../../state/reports'
import { transferOwnership } from '../../state/accountDeletion'
import { MenuItem, MenuTitle, OrgMenu } from '../organize/OrgMenu'
import { VolumeControls } from '../VolumeMenu'
import { openServerSettings } from '../settings/open'
import { canEditNickname, NicknameField } from '../organize/ServerSettings'
import '../organize/organize.css'
import './people.css'

export function UserMenuLayer() {
  const target = useUserMenu((s) => s.target)
  if (!target) return null
  return <UserMenu key={`${target.accountKey}:${target.serverKey}`} target={target} />
}

type View = 'main' | 'nick' | 'block' | 'remove' | 'kick' | 'ban' | 'timeout' | 'move' | 'roles' | 'transfer'

/** Whether you hear this person right now: a DM call, a group call or a voice channel you're both in. */
function useHears(accountKey: string, server: ServerState | undefined): boolean {
  const session = useVoice((s) => s.session)
  const groupCall = useGroupCalls((s) => (session?.group ? s.calls[session.group.key] : undefined))
  if (!session) return false
  if (session.call) return session.call.peer === accountKey
  if (session.group) return !!groupCall?.participants.includes(accountKey)
  return !!server && session.serverKey === server.key && (server.voice[session.channelId] ?? []).some((p) => p.accountKey === accountKey)
}

function UserMenu({ target }: { target: UserMenuTarget }) {
  const { t } = useTranslation()
  const { accountKey } = target
  const identity = useApp((s) => s.identity)
  const servers = useApp((s) => s.servers)
  useDms((s) => s.conversations) // names
  useFriends((s) => s.peers)
  const [view, setView] = useState<View>('main')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const relation = useRelation(accountKey)
  const blocked = useIsBlocked(accountKey)
  const myKey = identity ? b64u(identity.account.publicKey) : ''
  const self = accountKey === myKey
  const server = target.serverKey ? servers[target.serverKey] : undefined
  const member = server?.members[accountKey]
  // Bots (from any server): no calls or friend requests; built-in ones take no DMs either.
  const bot = botMember(accountKey)
  // Profiles live on servers: the one it was opened on, else any server you share.
  const profileServer = member ? server!.key : sharedServers(accountKey).find((k) => servers[k]?.members[accountKey])
  const name = member?.name ?? nameOf(accountKey)
  const hears = useHears(accountKey, server)
  const roles = useServerRoles(server?.key ?? '')
  const me = server?.me
  const below = !!member && !self && outranks(me, member, roles)
  const voiceChannel = member && server ? Object.entries(server.voice).find(([, list]) => list.some((p) => p.accountKey === accountKey))?.[0] : undefined
  const participant = voiceChannel !== undefined ? server!.voice[Number(voiceChannel)].find((p) => p.accountKey === accountKey) : undefined
  const canTimeout = below && has(me, roles, 'timeoutMembers')
  const canKick = below && has(me, roles, 'kickMembers')
  const canBan = below && has(me, roles, 'banMembers')
  // Anyone who manages roles sees the entry; with no roles yet it leads to making the first one.
  const canRoles = !!member && (self || below) && has(me, roles, 'manageRoles')
  const canMute = !!participant && (self || below) && has(me, roles, 'muteMembers')
  const moveTargets = server && participant && (self || below) && has(me, roles, 'moveMembers')
    ? server.channels.filter((c) => c.kind === 'voice' && c.id !== Number(voiceChannel)) : []
  const canDisconnect = !!participant && below && has(me, roles, 'moveMembers')
  const canCall = !self && !blocked && !bot && callServers(accountKey).length > 0
  const canTransfer = !!member && !self && !member.bot && me?.role === 'owner'
  const canMessage = !self && !bot?.builtin && (sharedServers(accountKey).length > 0 || !!useDms.getState().conversations[accountKey])

  const run = (action: () => unknown) => async () => {
    try {
      await action()
      closeUserMenu()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  /** Says it worked for a moment before closing (copying has nothing else to show). */
  const confirm = (label: string, action: () => unknown) => async () => {
    try {
      await action()
      setDone(label)
      setTimeout(closeUserMenu, 700)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const go = (action: () => void) => () => {
    closeUserMenu()
    action()
  }

  let body
  if (view === 'block' || view === 'remove' || view === 'kick' || view === 'ban' || view === 'transfer') {
    const confirm = {
      block: { text: t('moderation.blocked.confirm', { name }), button: t('moderation.blocked.block'), action: () => blockPerson(accountKey) },
      remove: { text: t('friends.removeConfirm', { name }), button: t('friends.removeName'), action: () => removeFriend(accountKey) },
      kick: { text: t('settings.member.kickConfirm', { name }), button: t('settings.member.kick'), action: () => connectionFor(server!.key)?.request('member.kick', { accountKey }) },
      ban: { text: t('settings.member.banConfirm', { name }), button: t('settings.member.ban'), action: () => connectionFor(server!.key)?.request('member.ban', { accountKey }) },
      transfer: { text: t('safety.transfer.menuConfirm', { name, server: server?.name ?? '' }), button: t('safety.transfer.button'), action: () => transferOwnership(server!.key, accountKey) },
    }[view]
    body = (
      <div className="user-menu-confirm">
        <p>{confirm.text}</p>
        <div className="copy-row">
          <button className="button danger small" onClick={run(confirm.action)}>{confirm.button}</button>
          <button className="button small" onClick={() => setView('main')}>{t('common.cancel')}</button>
        </div>
      </div>
    )
  } else if (view === 'nick' && server && member) {
    body = <div className="user-menu-nick"><NicknameField server={server} member={member} onDone={closeUserMenu} /></div>
  } else if (view === 'timeout') {
    body = (
      <div className="org-list" role="menu">
        {TIMEOUT_OPTIONS.map((o) => (
          <MenuItem key={o.ms} onClick={run(() => timeoutMember(server!.key, accountKey, o.ms))}>{durationLabel(o.ms)}</MenuItem>
        ))}
      </div>
    )
  } else if (view === 'move') {
    body = (
      <div className="org-list" role="menu">
        {moveTargets.map((c) => <MenuItem key={c.id} onClick={run(() => moveToChannel(server!.key, accountKey, c.id))}>{c.name}</MenuItem>)}
      </div>
    )
  } else if (view === 'roles') {
    const mine = new Set(member?.roles ?? [])
    body = (
      <div className="org-list user-menu-roles" role="group">
        {roles.map((r) => (
          <label key={r.id} className="org-item">
            <input
              type="checkbox" checked={mine.has(r.id)} disabled={!isAbove(me, r.position, roles)}
              onChange={(e) => {
                const next = e.target.checked ? [...mine, r.id] : [...mine].filter((id) => id !== r.id)
                setMemberRoles(server!.key, accountKey, next).then(() => setError(null), (err) => setError(errorMessage(err)))
              }}
            />
            <span className="role-dot" style={{ background: r.color ?? 'var(--muted)' }} aria-hidden />
            <span className="org-item-text">{r.icon ? `${r.icon} ` : ''}{r.name}</span>
          </label>
        ))}
        <div className="org-sep" role="separator" />
        <MenuItem onClick={go(() => openServerSettings(server!.key, 'roles'))}>{t('friends.menu.manageRoles')}</MenuItem>
      </div>
    )
  } else {
    const moderation = canTimeout || canKick || canBan || canRoles || canMute || moveTargets.length > 0 || canDisconnect
    body = (
      <div className="org-list" role="menu">
        {profileServer && <MenuItem onClick={go(() => openProfileCard(profileServer, accountKey, null))}>{t('friends.menu.profile')}</MenuItem>}
        {canMessage && <MenuItem onClick={go(() => openConversation(accountKey))}>{t('friends.menu.message')}</MenuItem>}
        {canCall && <MenuItem onClick={go(() => void startCall(accountKey, false))}>{t('friends.menu.call')}</MenuItem>}
        {member && canEditNickname(me, member) && (
          <MenuItem onClick={() => setView('nick')}>{self ? t('friends.menu.nickname') : t('friends.menu.nicknameFor', { name: member.profileName ?? member.name })}</MenuItem>
        )}
        {!self && !blocked && !bot && (
          <>
            <div className="org-sep" />
            {relation === 'none' && <MenuItem onClick={run(() => addFriend(accountKey))}>{t('friends.add')}</MenuItem>}
            {relation === 'outgoing' && <MenuItem onClick={run(() => cancelFriendRequest(accountKey))} hint={t('friends.requestSent')}>{t('friends.cancelRequest')}</MenuItem>}
            {relation === 'incoming' && (
              <>
                <MenuItem onClick={run(() => acceptFriend(accountKey))}>{t('friends.acceptRequest')}</MenuItem>
                <MenuItem onClick={run(() => ignoreFriend(accountKey))}>{t('friends.ignoreRequest')}</MenuItem>
              </>
            )}
            {relation === 'friends' && <MenuItem danger onClick={() => setView('remove')}>{t('friends.remove')}</MenuItem>}
          </>
        )}
        {hears && !self && (
          <>
            <div className="org-sep" />
            <div className="user-menu-volume" role="group" aria-label={t('friends.menu.volume')}>
              <VolumeControls accountKey={accountKey} name={name} title={t('friends.menu.volume')} />
            </div>
          </>
        )}
        {moderation && (
          <>
            <div className="org-sep" />
            {canMute && (
              <MenuItem onClick={run(() => serverMute(server!.key, accountKey, !participant?.serverMuted))}>
                {participant?.serverMuted ? t('roles.unmuteAll') : t('roles.muteAll')}
              </MenuItem>
            )}
            {moveTargets.length > 0 && <MenuItem onClick={() => setView('move')}>{t('friends.menu.moveTo')}</MenuItem>}
            {canDisconnect && <MenuItem onClick={run(() => disconnectFromVoice(server!.key, accountKey))}>{t('friends.menu.disconnect')}</MenuItem>}
            {canRoles && (roles.length > 0
              ? <MenuItem onClick={() => setView('roles')}>{t('friends.menu.roles')}</MenuItem>
              : <MenuItem onClick={go(() => openServerSettings(server!.key, 'roles'))}>{t('friends.menu.createRole')}</MenuItem>)}
            {canTimeout && (timeoutActive(member)
              ? <MenuItem onClick={run(() => removeTimeout(server!.key, accountKey))}>{t('moderation.timeout.remove')}</MenuItem>
              : <MenuItem danger onClick={() => setView('timeout')}>{t('friends.menu.timeout')}</MenuItem>)}
            {canKick && <MenuItem danger onClick={() => setView('kick')}>{t('friends.menu.kick')}</MenuItem>}
            {canBan && <MenuItem danger onClick={() => setView('ban')}>{t('friends.menu.ban')}</MenuItem>}
          </>
        )}
        {canTransfer && <MenuItem danger onClick={() => setView('transfer')}>{t('safety.transfer.menu')}</MenuItem>}
        <div className="org-sep" />
        {!self && <MenuItem danger onClick={go(() => openReport({ kind: 'person', accountKey, serverKey: target.serverKey }))}>{t('safety.report.menuPerson')}</MenuItem>}
        {!self && (blocked
          ? <MenuItem onClick={run(() => setBlocked(accountKey, false))}>{t('moderation.blocked.unblock')}</MenuItem>
          : <MenuItem danger onClick={() => setView('block')}>{t('moderation.blocked.block')}</MenuItem>)}
        <MenuItem onClick={confirm(t('friends.menu.copied'), () => navigator.clipboard.writeText(accountKey))}>{t('friends.menu.copyId')}</MenuItem>
      </div>
    )
  }

  const titles: Partial<Record<View, string>> = {
    nick: t('organize.nick.label'), timeout: t('moderation.timeout.title'), move: t('roles.moveLabel'), roles: t('roles.memberRoles'),
  }
  return (
    <OrgMenu anchor={target.anchor} label={t('friends.menu.label', { name })} onClose={closeUserMenu}>
      <MenuTitle onBack={view === 'main' ? undefined : () => setView('main')}>
        {view === 'main' ? (self ? `${name} (${t('friends.menu.you')})` : name) : (titles[view] ?? name)}
      </MenuTitle>
      {body}
      {error && <p className="error-text user-menu-error" role="alert">{error}</p>}
      {done && <p className="success-text user-menu-error" role="status">{done}</p>}
    </OrgMenu>
  )
}

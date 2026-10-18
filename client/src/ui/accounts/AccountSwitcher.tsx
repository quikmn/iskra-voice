// The account switcher at the bottom of the server rail (and so in the phone's drawer): who you are here, your other
// accounts with their unread counts, and adding one (state/accounts.ts).
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t } from '../../i18n'
import type { AccountView } from '../../platform/accountLink'
import {
  accountName, addAccountHere, inHost, maxAccounts, moveAccountInList, switchAccount, thisSlot, useAccounts,
} from '../../state/accounts'
import { refreshDevices } from '../../state/devices'
import { useVoice } from '../../state/voice'
import type { AddMode } from '../../platform/accountSlots'
import { SignOutDialog } from '../dialogs/SignOut'
import { hueFor, initials } from '../format'
import { ChevronDown, Lock, Mic, Plus } from '../icons'
import { MenuItem, MenuTitle, OrgMenu, type MenuAnchor } from '../organize/OrgMenu'
import './accounts.css'

/** An account's picture as an object URL (made from its bytes, so it never leaves this device), or null. */
function useAvatarUrl(avatar: AccountView['avatar']): string | null {
  const url = useMemo(() => (avatar ? URL.createObjectURL(new Blob([avatar.bytes], { type: avatar.type })) : null), [avatar?.hash]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url)
  }, [url])
  return url
}

export function AccountAvatar({ account, size }: { account: AccountView; size: number }) {
  const url = useAvatarUrl(account.avatar)
  return (
    <span className="avatar account-avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hueFor(account.key ?? String(account.slot))} 45% 32%)` }} aria-hidden>
      {url ? <img className="avatar-image" src={url} alt="" draggable={false} /> : initials(account.name || '+')}
    </span>
  )
}

/** What's going on with an account, in a few words. */
function statusOf(account: AccountView): string {
  if (account.adding && !account.ready) return t('accounts.switcher.settingUp')
  if (account.locked) return t('accounts.switcher.locked')
  if (account.ringing) return t('accounts.ringing.title', { caller: account.ringing, account: accountName(account) })
  if (account.inVoice) return t('accounts.switcher.inVoice')
  if (account.unread > 0) return t('accounts.switcher.unread', { count: account.unread })
  return account.slot === thisSlot ? t('accounts.switcher.current') : ''
}

export function AccountSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const accounts = useAccounts((s) => s.accounts)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const me = accounts.find((a) => a.slot === thisSlot)
  if (!me) return null
  const others = accounts.filter((a) => a.slot !== thisSlot)
  const otherUnread = others.reduce((n, a) => n + a.unread, 0)
  const ringing = others.some((a) => a.ringing)
  const label = otherUnread > 0
    ? `${t('accounts.switcher.label', { name: accountName(me) })}. ${t('accounts.switcher.otherUnread', { count: otherUnread })}`
    : t('accounts.switcher.label', { name: accountName(me) })
  return (
    <>
      <button
        className={`server-icon account-switch ${ringing ? 'ringing' : ''}`}
        title={t('accounts.switcher.title')}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        data-testid="account-switcher"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.right + 8, y: rect.bottom })
        }}
      >
        <AccountAvatar account={me} size={40} />
        {otherUnread > 0 && <span className="badge" aria-hidden>{otherUnread > 99 ? '99+' : otherUnread}</span>}
      </button>
      {anchor && (
        <AccountMenu anchor={anchor} accounts={accounts} onClose={() => setAnchor(null)}
          onSwitch={(slot) => {
            setAnchor(null)
            onNavigate?.()
            switchAccount(slot)
          }}
          onSignOut={() => {
            setAnchor(null)
            void refreshDevices()
            setSigningOut(true)
          }} />
      )}
      {signingOut && <SignOutDialog onClose={() => setSigningOut(false)} />}
    </>
  )
}

function AccountMenu({ anchor, accounts, onClose, onSwitch, onSignOut }: {
  anchor: MenuAnchor; accounts: AccountView[]; onClose: () => void; onSwitch: (slot: number) => void; onSignOut: () => void
}) {
  const { t } = useTranslation()
  const [page, setPage] = useState<'list' | 'add'>('list')
  const inVoice = useVoice((s) => !!s.session)
  const me = accounts.find((a) => a.slot === thisSlot)!
  const full = accounts.length >= maxAccounts
  const add = (mode: AddMode) => {
    onClose()
    addAccountHere(mode)
  }
  return (
    <OrgMenu anchor={anchor} label={t('accounts.switcher.title')} onClose={onClose}>
      {page === 'list' ? (
        <>
          <MenuTitle>{t('accounts.switcher.title')}</MenuTitle>
          <div className="org-list account-list" role="menu">
            {accounts.map((account, i) => (
              <div key={account.slot} className={`account-row ${account.slot === thisSlot ? 'current' : ''}`} role="none">
                <button
                  role="menuitemradio"
                  aria-checked={account.slot === thisSlot}
                  className="org-item account-item"
                  data-account={account.slot}
                  onClick={() => (account.slot === thisSlot ? onClose() : onSwitch(account.slot))}
                  aria-label={account.slot === thisSlot ? accountName(account) : t('accounts.switcher.switchTo', { name: accountName(account) })}
                >
                  <AccountAvatar account={account} size={32} />
                  <span className="account-item-text">
                    <strong>{accountName(account)}</strong>
                    <small className={account.unread > 0 && account.slot !== thisSlot ? 'unread' : ''}>{statusOf(account)}</small>
                  </span>
                  {account.inVoice && <Mic size={14} />}
                  {account.locked && <Lock size={14} />}
                  {account.unread > 0 && account.slot !== thisSlot && <span className="badge" aria-hidden>{account.unread > 99 ? '99+' : account.unread}</span>}
                </button>
                {inHost && accounts.length > 1 && (
                  <span className="account-move">
                    <button className="icon-button small" disabled={i === 0} onClick={() => moveAccountInList(account.slot, -1)}
                      aria-label={t('accounts.switcher.moveUp', { name: accountName(account) })}><span className="flip"><ChevronDown size={14} /></span></button>
                    <button className="icon-button small" disabled={i === accounts.length - 1} onClick={() => moveAccountInList(account.slot, 1)}
                      aria-label={t('accounts.switcher.moveDown', { name: accountName(account) })}><ChevronDown size={14} /></button>
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="org-sep" />
          <div className="org-list" role="menu">
            <MenuItem submenu disabled={full} onClick={() => setPage('add')}>
              <span className="account-add-label"><Plus size={16} /> {t('accounts.switcher.add')}</span>
            </MenuItem>
            {me.ready && <MenuItem danger onClick={onSignOut}>{t('accounts.switcher.signOut', { name: accountName(me) })}</MenuItem>}
          </div>
          {full && <p className="muted account-menu-note">{t('accounts.switcher.full', { count: maxAccounts })}</p>}
        </>
      ) : (
        <>
          <MenuTitle onBack={() => setPage('list')}>{t('accounts.switcher.add')}</MenuTitle>
          <div className="org-list" role="menu">
            <button role="menuitem" className="org-item account-add-choice" onClick={() => add('new')}>
              <span className="account-item-text">
                <strong>{t('accounts.switcher.addNew')}</strong>
                <small>{t('accounts.switcher.addNewHint')}</small>
              </span>
            </button>
            <button role="menuitem" className="org-item account-add-choice" onClick={() => add('link')}>
              <span className="account-item-text">
                <strong>{t('accounts.switcher.addExisting')}</strong>
                <small>{t('accounts.switcher.addExistingHint')}</small>
              </span>
            </button>
          </div>
          {!inHost && <p className="muted account-menu-note">{inVoice ? t('accounts.switcher.restartVoiceNote') : t('accounts.switcher.restartNote')}</p>}
        </>
      )}
    </OrgMenu>
  )
}

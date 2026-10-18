// The host page with several accounts signed in: one full-size frame per account, the one on screen visible, and the
// "Which account?" question for links opened from outside (state/accountHost.ts).
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { choose, registerFrame, useHost, views } from '../../state/accountHost'
import { hueFor, initials } from '../format'
import { useEscapeLayer, useFocusTrap } from '../layers'
import './accounts.css'

/** What a frame may use. Same-origin, so the browser lets it have these anyway; listed for clarity and for Firefox. */
const ALLOW = 'microphone; camera; display-capture; autoplay; fullscreen; clipboard-read; clipboard-write; screen-wake-lock; publickey-credentials-get; publickey-credentials-create'

const frameUrl = (slot: number) => `${location.pathname}?account=${slot}`

export function AccountHost() {
  const order = useHost((s) => s.registry.order)
  const active = useHost((s) => s.registry.active)
  const choosing = useHost((s) => !!s.choosing)
  // Frames stay in slot order whatever the switcher's order: moving an iframe in the page would reload it.
  const slots = [...order].sort((a, b) => a - b)
  return (
    <div className="account-host">
      {slots.map((slot) => <AccountFrame key={slot} slot={slot} active={slot === active} />)}
      {choosing && <Chooser />}
    </div>
  )
}

function AccountFrame({ slot, active }: { slot: number; active: boolean }) {
  const { t } = useTranslation()
  const name = useHost((s) => s.summaries[slot]?.name || s.registry.accounts[slot]?.name || '')
  useEffect(() => () => registerFrame(slot, null), [slot])
  return (
    <iframe
      ref={(element) => {
        if (element) registerFrame(slot, element)
      }}
      className={`account-frame ${active ? 'shown' : ''}`}
      data-account={slot}
      src={frameUrl(slot)}
      title={t('accounts.frameTitle', { name: name || t('accounts.switcher.unnamed') })}
      allow={ALLOW}
      // Hidden accounts keep running (connected, notifying) but can't take focus or clicks.
      inert={!active}
      aria-hidden={!active}
    />
  )
}

/** A link from outside (an invite, a notification without its account) and more than one account: which one? */
function Chooser() {
  const { t } = useTranslation()
  const link = useHost((s) => s.choosing)
  useHost((s) => s.summaries) // the names as they come in
  const ref = useRef<HTMLDivElement>(null)
  useEscapeLayer(() => choose(null), true)
  useFocusTrap(ref)
  const accounts = views().filter((a) => !a.adding)
  const invite = link?.kind === 'token' || (link?.kind === 'hash' && link.route.startsWith('#/join/')) || (link?.kind === 'url' && link.value.includes('/join/'))
  const question = invite ? t('accounts.chooser.invite') : t('accounts.chooser.open')
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && choose(null)}>
      <div className="modal account-chooser" role="dialog" aria-modal="true" aria-label={t('accounts.chooser.title')} ref={ref} tabIndex={-1}>
        <div className="modal-header">
          <h2>{t('accounts.chooser.title')}</h2>
        </div>
        <div className="modal-body">
          <p className="muted">{question}</p>
          <div className="account-chooser-list">
            {accounts.map((a) => (
              <button key={a.slot} className="account-chooser-item" onClick={() => choose(a.slot)} autoFocus={a.active}>
                <span className="avatar" style={{ width: 32, height: 32, fontSize: 12, background: `hsl(${hueFor(a.key ?? String(a.slot))} 45% 32%)` }} aria-hidden>
                  {initials(a.name || '?')}
                </span>
                <span className="account-chooser-name">{a.name || t('accounts.switcher.unnamed')}</span>
              </button>
            ))}
          </div>
        </div>
        <footer className="modal-footer">
          <button className="button" onClick={() => choose(null)}>{t('accounts.chooser.cancel')}</button>
        </footer>
      </div>
    </div>
  )
}

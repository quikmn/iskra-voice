// The composer's "+": attach, poll, voice message and send later, so the row itself is "+ · box · GIF · emoji · send"
// on desktop and "+ · box · send" on phones (below 480 px GIF and emoji move in here too). A popover above the button
// on desktop, a sheet on phones; a button and a menu, so it works with the keyboard and screen readers like the
// buttons it stands in for.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart, Clock, Mic, Paperclip, Plus, Smile } from '../icons'
import { MenuGroup, MenuItem, OrgMenu, type MenuAnchor } from '../organize/OrgMenu'
import { GifIcon } from './extraIcons'

export interface ComposerActions {
  attach: () => void
  /** Missing where polls can't be made (encrypted channels, DMs). */
  poll?: () => void
  /** Missing where GIFs can't be sent (encrypted channels, DMs). */
  gifs?: (anchor: HTMLElement) => void
  emoji: (anchor: HTMLElement) => void
  /** Missing when a voice message can't be recorded right now (something is typed, or no microphone support). */
  voice?: () => void
  /** Send later (also: right-click or press and hold the send button). */
  later?: () => void
}

/** Below this the row keeps only "+", the box and send. */
const COMPACT = '(max-width: 480px)'

export function ComposerMenu({ actions, disabled }: { actions: ComposerActions; disabled?: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<{ anchor: MenuAnchor; compact: boolean } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const run = (action: () => void) => () => {
    setOpen(null)
    action()
  }
  return (
    <>
      <button
        ref={button}
        className={`icon-button composer-plus ${open ? 'on' : ''}`}
        onClick={(e) => {
          if (open) return setOpen(null)
          const r = e.currentTarget.getBoundingClientRect()
          setOpen({ anchor: { x: r.left, y: r.top - 6 }, compact: window.matchMedia(COMPACT).matches })
        }}
        aria-label={t('chat.composer.more')}
        title={t('chat.composer.more')}
        aria-haspopup="menu"
        aria-expanded={!!open}
      >
        <Plus />
      </button>
      {open && (
        <OrgMenu anchor={open.anchor} label={t('chat.composer.more')} onClose={() => setOpen(null)}>
          <div className="org-list composer-menu" role="menu" aria-label={t('chat.composer.more')}>
            <MenuGroup>
              <MenuItem icon={<Paperclip />} disabled={disabled} onClick={run(actions.attach)}>{t('chat.composer.attach')}</MenuItem>
              {actions.poll && <MenuItem icon={<BarChart />} disabled={disabled} onClick={run(actions.poll)}>{t('chat.composer.poll')}</MenuItem>}
              {open.compact && actions.gifs && <MenuItem icon={<GifIcon />} disabled={disabled} onClick={run(() => actions.gifs!(button.current!))}>{t('chat.composer.gifs')}</MenuItem>}
              {open.compact && <MenuItem icon={<Smile />} onClick={run(() => actions.emoji(button.current!))}>{t('chat.composer.emoji')}</MenuItem>}
              {actions.voice && <MenuItem icon={<Mic />} disabled={disabled} onClick={run(actions.voice)}>{t('chat.voice.record')}</MenuItem>}
            </MenuGroup>
            {actions.later && (
              <MenuGroup>
                <MenuItem icon={<Clock />} disabled={disabled} onClick={run(actions.later)}>{t('productivity.sendLater.button')}</MenuItem>
              </MenuGroup>
            )}
          </div>
        </OrgMenu>
      )}
    </>
  )
}

// Phones: the composer's attach, poll, GIF, emoji and voice-message buttons fold into one "+" that opens a sheet with
// those actions (styles.css hides the row of buttons below 480 px and shows this instead), so "Message #channel" has
// room. A button and a menu, so it works with the keyboard and screen readers like the buttons it stands in for.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mic, Paperclip, Plus, Smile } from '../icons'
import { PollIcon } from '../expressions/icons'
import { MenuItem, MenuTitle, OrgMenu } from '../organize/OrgMenu'

export interface ComposerActions {
  attach: () => void
  /** Missing where polls can't be made (encrypted channels). */
  poll?: () => void
  /** Missing where GIFs can't be sent (encrypted channels). */
  gifs?: (anchor: HTMLElement) => void
  emoji: (anchor: HTMLElement) => void
  /** Missing when a voice message can't be recorded right now (something is typed, or no microphone support). */
  voice?: () => void
}

export function ComposerMenu({ actions, disabled }: { actions: ComposerActions; disabled?: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const run = (action: () => void) => () => {
    setOpen(false)
    action()
  }
  return (
    <>
      <button
        ref={button}
        className="icon-button attach-button composer-plus"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('chat.composer.more')}
        title={t('chat.composer.more')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus />
      </button>
      {open && (
        <OrgMenu anchor={null} label={t('chat.composer.more')} onClose={() => setOpen(false)}>
          <MenuTitle>{t('chat.composer.more')}</MenuTitle>
          <div className="org-list composer-menu" role="menu">
            <MenuItem disabled={disabled} onClick={run(actions.attach)}><Paperclip size={18} /> {t('chat.composer.attach')}</MenuItem>
            {actions.poll && <MenuItem disabled={disabled} onClick={run(actions.poll)}><PollIcon /> {t('chat.composer.poll')}</MenuItem>}
            {actions.gifs && <MenuItem disabled={disabled} onClick={run(() => actions.gifs!(button.current!))}><span className="composer-menu-gif" aria-hidden>GIF</span> {t('chat.composer.gifs')}</MenuItem>}
            <MenuItem onClick={run(() => actions.emoji(button.current!))}><Smile size={18} /> {t('chat.composer.emoji')}</MenuItem>
            {actions.voice && <MenuItem disabled={disabled} onClick={run(actions.voice)}><Mic size={18} /> {t('chat.voice.record')}</MenuItem>}
          </div>
        </OrgMenu>
      )}
    </>
  )
}

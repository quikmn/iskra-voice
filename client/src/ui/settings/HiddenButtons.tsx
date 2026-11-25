// My settings → Appearance → "Hide buttons I don't use": a switch per optional button, grouped by where it sits.
// Each row says where the feature is still found once its button is hidden.
import { useTranslation } from 'react-i18next'
import { BUTTON_PLACE, HIDEABLE_BUTTONS, setButtonHidden, showAllButtons, useHiddenButtons, type HideableButton } from '../../state/hiddenButtons'
import { SwitchRow } from '../kit'

const PLACES = ['composer', 'header', 'voice'] as const

export function HiddenButtonsSection() {
  const { t } = useTranslation()
  const hidden = useHiddenButtons((s) => s.hidden)
  // The buttons under the names they already have in the app.
  const labels: Record<HideableButton, string> = {
    gif: t('chat.composer.gifs'), emoji: t('chat.composer.emoji'), voiceMessage: t('chat.voice.record'),
    threads: t('chat.header.threads'), pins: t('chat.header.pins'), search: t('chat.search.searchMessages'),
    calls: t('settings.hiddenButtons.calls'), soundboard: t('expressions.soundboard.title'),
  }
  const label = (id: HideableButton) => labels[id]
  const where = (id: HideableButton) => t(`settings.hiddenButtons.where.${id}`)
  return (
    <section className="settings-section hidden-buttons" data-testid="hidden-buttons">
      <h2>{t('settings.hiddenButtons.title')}</h2>
      <p className="muted">{t('settings.hiddenButtons.intro')}</p>
      {PLACES.map((place) => (
        <div key={place} role="group" aria-label={t(`settings.hiddenButtons.places.${place}`)}>
          <h3 className="settings-subhead">{t(`settings.hiddenButtons.places.${place}`)}</h3>
          {HIDEABLE_BUTTONS.filter((id) => BUTTON_PLACE[id] === place).map((id) => (
            <SwitchRow key={id} title={label(id)} help={where(id)} label={t('settings.hiddenButtons.hide', { button: label(id) })}
              checked={hidden.includes(id)} onChange={(on) => setButtonHidden(id, on)} />
          ))}
        </div>
      ))}
      {hidden.length > 0 && <button className="button small" onClick={showAllButtons}>{t('settings.hiddenButtons.showAll')}</button>}
    </section>
  )
}

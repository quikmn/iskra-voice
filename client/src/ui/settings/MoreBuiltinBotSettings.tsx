// Server settings → Bots: the settings of Starboard, Birthdays and Welcome (which channel, and what each does there).
// Admins only; loaded when opened, saved with one button (only what changed goes to the server).
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BirthdayConfig, BuiltinConfigs, MoreBuiltinBotId, StarboardConfig, WelcomeConfig } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { getBotConfig, setBotConfig } from '../../state/moreBuiltinBots'
import { configPatch, configProblem, fillTemplate, MAX_TEMPLATE, MAX_THRESHOLD, MIN_THRESHOLD, timeZones } from '../../state/moreBuiltinBotsLogic'
import type { ServerState } from '../../state/store'
import { renderMarkdown } from '../markdown'
import '../moreBots.css'

const STAR_EMOJI = ['⭐', '🌟', '🔥', '❤️', '👍', '😂', '💯']

export function MoreBuiltinBotSettings({ server, bot }: { server: ServerState; bot: MoreBuiltinBotId }) {
  const { t } = useTranslation()
  const [saved, setSaved] = useState<BuiltinConfigs[MoreBuiltinBotId] | null>(null)
  const [draft, setDraft] = useState<BuiltinConfigs[MoreBuiltinBotId] | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let live = true
    getBotConfig(server.key, bot).then((config) => {
      if (!live || !config) return
      setSaved(config)
      setDraft(config)
    }, (e) => live && setStatus({ kind: 'error', text: errorMessage(e) }))
    return () => { live = false }
  }, [server.key, bot])

  const textChannels = server.channels.filter((c) => c.kind === 'text' && !c.e2ee).sort((a, b) => a.position - b.position)
  if (!draft || !saved) return <p className="muted">{status?.text ?? t('moreBots.settings.loading')}</p>

  const problem = configProblem(bot, draft)
  const patch = configPatch(saved, draft)
  const changed = Object.keys(patch).length > 0
  const update = (more: Partial<StarboardConfig & BirthdayConfig & WelcomeConfig>) => {
    setDraft({ ...draft, ...more } as BuiltinConfigs[MoreBuiltinBotId])
    setStatus(null)
  }

  async function save() {
    setBusy(true)
    setStatus(null)
    try {
      const config = await setBotConfig(server.key, bot, patch)
      if (config) {
        setSaved(config)
        setDraft(config)
      }
      setStatus({ kind: 'saved', text: t('moreBots.settings.saved') })
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  const id = `bot-${bot}-${server.key}`
  return (
    <form className="more-bot-settings" data-testid={`builtin-${bot}-settings`} onSubmit={(e) => { e.preventDefault(); void save() }}>
      <label className="field">
        <span>{t('moreBots.settings.channel')}</span>
        <select value={draft.channelId ?? ''} disabled={busy} onChange={(e) => update({ channelId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t('moreBots.settings.channelNone')}</option>
          {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
      </label>
      <p className="muted small">{t('moreBots.settings.channelHint')}</p>
      {bot === 'starboard' && <StarboardFields draft={draft as StarboardConfig} busy={busy} update={update} />}
      {bot === 'birthdays' && <BirthdayFields draft={draft as BirthdayConfig} busy={busy} update={update} />}
      {bot === 'welcome' && <WelcomeFields server={server} draft={draft as WelcomeConfig} busy={busy} update={update} id={id} />}
      {problem && changed && <p className="error-text">{t(`moreBots.settings.invalid.${problem}` as never)}</p>}
      <div className="more-bot-actions">
        <button type="submit" className="button primary small" disabled={busy || !changed || !!problem}>{t('moreBots.settings.save')}</button>
        {status && <span className={status.kind === 'error' ? 'error-text' : 'muted'} role="status">{status.text}</span>}
      </div>
    </form>
  )
}

type Update = (more: Partial<StarboardConfig & BirthdayConfig & WelcomeConfig>) => void

function StarboardFields({ draft, busy, update }: { draft: StarboardConfig; busy: boolean; update: Update }) {
  const { t } = useTranslation()
  const choices = STAR_EMOJI.includes(draft.emoji) ? STAR_EMOJI : [draft.emoji, ...STAR_EMOJI]
  return (
    <>
      <fieldset className="field star-emoji">
        <legend>{t('moreBots.settings.starboard.emoji')}</legend>
        <div className="star-emoji-choices" role="radiogroup" aria-label={t('moreBots.settings.starboard.emoji')}>
          {choices.map((e) => (
            <button key={e} type="button" role="radio" aria-checked={draft.emoji === e} className={`star-emoji-choice ${draft.emoji === e ? 'on' : ''}`}
              disabled={busy} onClick={() => update({ emoji: e })}>{e}</button>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>{t('moreBots.settings.starboard.threshold')}</span>
        <input type="number" inputMode="numeric" min={MIN_THRESHOLD} max={MAX_THRESHOLD} value={Number.isNaN(draft.threshold) ? '' : draft.threshold} disabled={busy}
          onChange={(e) => update({ threshold: e.target.value === '' ? NaN : Number(e.target.value) })} />
      </label>
      <p className="muted small">{t('moreBots.settings.starboard.hint')}</p>
    </>
  )
}

function BirthdayFields({ draft, busy, update }: { draft: BirthdayConfig; busy: boolean; update: Update }) {
  const { t } = useTranslation()
  const zones = useMemo(() => timeZones(draft.timeZone), [draft.timeZone])
  return (
    <>
      <div className="more-bot-row">
        <label className="field">
          <span>{t('moreBots.settings.birthdays.time')}</span>
          <input type="time" value={draft.time} disabled={busy} required onChange={(e) => update({ time: e.target.value.slice(0, 5) })} />
        </label>
        <label className="field">
          <span>{t('moreBots.settings.birthdays.timeZone')}</span>
          <select value={draft.timeZone ?? ''} disabled={busy} onChange={(e) => update({ timeZone: e.target.value || null })}>
            <option value="">{t('moreBots.settings.birthdays.serverZone', { zone: draft.serverTimeZone })}</option>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
      </div>
      <p className="muted small">{t('moreBots.settings.birthdays.hint')}</p>
    </>
  )
}

function WelcomeFields({ server, draft, busy, update, id }: { server: ServerState; draft: WelcomeConfig; busy: boolean; update: Update; id: string }) {
  const { t } = useTranslation()
  const me = server.me
  const count = Object.values(server.members).filter((m) => !m.bot).length
  const preview = draft.message.trim()
    ? fillTemplate(draft.message, me ? `<@${me.accountKey}>` : '', server.name, count)
    : t('moreBots.reply.welcome', { server: server.name, name: me?.name ?? '' })
  const nameOf = (key: string) => server.members[key]?.name ?? null
  return (
    <>
      <label className="field">
        <span>{t('moreBots.settings.welcome.message')}</span>
        <textarea rows={3} maxLength={MAX_TEMPLATE} value={draft.message} disabled={busy} placeholder={t('moreBots.settings.welcome.messagePlaceholder')}
          aria-describedby={`${id}-hint`} onChange={(e) => update({ message: e.target.value })} />
      </label>
      <p id={`${id}-hint`} className="muted small">{t('moreBots.settings.welcome.messageHint')}</p>
      <div className="welcome-preview" aria-label={t('moreBots.settings.welcome.preview')}>
        <span className="muted small">{t('moreBots.settings.welcome.preview')}</span>
        <div className="message-text">{renderMarkdown(preview, { nameOf, me: me?.accountKey, serverKey: server.key })}</div>
      </div>
      <label className="field">
        <span>{t('moreBots.settings.welcome.privateMessage')}</span>
        <textarea rows={2} maxLength={MAX_TEMPLATE} value={draft.privateMessage} disabled={busy} placeholder={t('moreBots.settings.welcome.privatePlaceholder')}
          onChange={(e) => update({ privateMessage: e.target.value })} />
      </label>
      <p className="muted small">{t('moreBots.settings.welcome.privateHint')} {t('moreBots.settings.welcome.batchHint')}</p>
    </>
  )
}

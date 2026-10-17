// Read aloud and voice message transcripts in the UI: "Read aloud" on a message, "Read new messages aloud" per
// channel (with a header button to stop it while it's on), and Settings → Voice & audio → Speech.
import { useTranslation } from 'react-i18next'
import type { Channel, Message } from '../../core/protocol'
import { formatNumber } from '../../i18n/format'
import { captionsSupported } from '../../state/captions'
import {
  readMessageAloud, setReadAloudHere, speechKey, speechSupported, stopSpeaking, testVoice, updateSpeech, useReadAloudHere, useSpeech,
} from '../../state/speech'
import type { ServerState } from '../../state/store'
import { setAutoTranscribe, useTranscripts } from '../../state/transcripts'
import { Volume } from '../icons'
import { MenuItem } from '../organize/OrgMenu'
import './speech.css'

type Wrap = (doneLabel: string | null, action: () => void | Promise<unknown>) => () => void

/** "Read aloud" / "Stop reading" in a message's menu (nothing without speech synthesis or text). */
export function ReadAloudMenuItem({ server, message, wrap, icon }: { server: ServerState; message: Message; wrap: Wrap; icon?: boolean }) {
  const { t } = useTranslation()
  const reading = useSpeech((s) => s.speaking === speechKey(server.key, message))
  if (!speechSupported() || !message.text?.trim()) return null
  return (
    <button role="menuitem" onClick={wrap(null, () => readMessageAloud(server, message))}>
      {icon && <Volume size={18} />}{reading ? t('speech.read.stop') : t('speech.read.menu')}
    </button>
  )
}

/** Channel menu: "Read new messages aloud" here. */
export function ReadAloudChannelItem({ server, channel }: { server: ServerState; channel: Channel }) {
  const { t } = useTranslation()
  const on = useReadAloudHere(server.key, channel.id)
  if (!speechSupported() || !['text', 'voice', 'stage'].includes(channel.kind)) return null
  return (
    <MenuItem checked={on} onClick={() => setReadAloudHere(server.key, channel.id, !on)} hint={on ? t('speech.channel.on') : undefined}>
      {t('speech.channel.toggle')}
    </MenuItem>
  )
}

/** Header: shows while new messages are read aloud here; pressing it turns that off. */
export function ReadAloudHeaderButton({ serverKey, channelId }: { serverKey: string; channelId: number }) {
  const { t } = useTranslation()
  const on = useReadAloudHere(serverKey, channelId)
  if (!on || !speechSupported()) return null
  return (
    <button className="icon-button on read-aloud-on" onClick={() => setReadAloudHere(serverKey, channelId, false)}
      aria-label={t('speech.channel.turnOff')} title={t('speech.channel.turnOff')} data-testid="read-aloud-on">
      <Volume />
    </button>
  )
}

/** Settings → Voice & audio → Speech. */
export function SpeechSettingsSection() {
  const { t } = useTranslation()
  const settings = useSpeech((s) => s.settings)
  const voices = useSpeech((s) => s.voices)
  const speaking = useSpeech((s) => s.speaking === 'test')
  const auto = useTranscripts((s) => s.auto)
  const slow = useTranscripts((s) => s.slow)
  const speech = speechSupported()
  const transcripts = captionsSupported()
  // The app's languages first, then the rest.
  const sorted = [...voices].sort((a, b) => Number(!/^(en|sv)\b/i.test(a.lang)) - Number(!/^(en|sv)\b/i.test(b.lang)) || a.name.localeCompare(b.name))

  return (
    <section className="settings-section speech-settings">
      <h2>{t('speech.settings.title')}</h2>

      <h3>{t('speech.settings.transcripts')}</h3>
      <label className="checkbox">
        <input type="checkbox" checked={auto} disabled={!transcripts} onChange={(e) => setAutoTranscribe(e.target.checked)} />
        {t('speech.settings.autoTranscribe')}
      </label>
      <p className="muted">{transcripts ? t('speech.settings.transcriptsHint') : t('speech.transcript.unsupported')}</p>
      {auto && slow && <p className="muted" role="status">{t('speech.settings.tooSlow')}</p>}

      <h3>{t('speech.settings.readAloud')}</h3>
      {!speech ? <p className="muted">{t('speech.settings.unsupported')}</p> : (
        <>
          <p className="muted">{t('speech.settings.readAloudHint')}</p>
          <label className="checkbox">
            <input type="checkbox" checked={settings.playTts} onChange={(e) => updateSpeech({ playTts: e.target.checked })} />
            {t('speech.settings.playTts')}
          </label>
          <p className="muted">{t('speech.settings.playTtsHint')}</p>
          <label className="field">
            <span>{t('speech.settings.voice')}</span>
            <select value={settings.voice ?? ''} onChange={(e) => updateSpeech({ voice: e.target.value || null })}>
              <option value="">{t('speech.settings.defaultVoice')}</option>
              {sorted.map((v) => <option key={v.uri} value={v.uri}>{v.name} ({v.lang})</option>)}
            </select>
          </label>
          {voices.length === 0 && <p className="muted">{t('speech.settings.noVoices')}</p>}
          <label className="field">
            <span>{t('speech.settings.rate', { rate: formatNumber(settings.rate, { maximumFractionDigits: 2 }) })}</span>
            <input type="range" min={0.5} max={2} step={0.1} value={settings.rate} aria-label={t('speech.settings.rateLabel')}
              onChange={(e) => updateSpeech({ rate: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>{t('speech.settings.volume', { volume: formatNumber(settings.volume, { style: 'percent', maximumFractionDigits: 0 }) })}</span>
            <input type="range" min={0} max={1} step={0.05} value={settings.volume} aria-label={t('speech.settings.volumeLabel')}
              onChange={(e) => updateSpeech({ volume: Number(e.target.value) })} />
          </label>
          <div className="speech-test">
            <button className="button small" onClick={() => (speaking ? stopSpeaking() : testVoice())}>
              {speaking ? t('speech.read.stop') : t('speech.settings.test')}
            </button>
          </div>
          <p className="muted">{t('speech.settings.screenReader')}</p>
        </>
      )}
    </section>
  )
}

// Before sharing: quality, sound and what you're sharing (motion vs detail). Remembered for next time.
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { t } from '../i18n'
import { createPortal } from 'react-dom'
import { desktop } from '../platform/desktop'
import { QUALITIES, updateShareSettings, useScreenShareSettings } from '../state/screenShare'
import { toggleScreenShare } from '../state/voice'
import { usePopoverPosition } from './expressions/popover'
import { useEscapeLayer } from './layers'
import './desktop.css'

/** Whether "Share audio" can do anything here, and what it shares. */
function audioSupport(): { ok: boolean; note: string } {
  if (desktop) {
    return desktop.platform === 'win32'
      ? { ok: true, note: t('voice.share.audioWindows') }
      : { ok: false, note: t('voice.share.audioUnavailable') }
  }
  return { ok: true, note: t('voice.share.audioBrowser') }
}

export function ScreenShareMenu({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  useTranslation()
  const settings = useScreenShareSettings()
  const panel = useRef<HTMLDivElement>(null)
  const { style, sheet } = usePopoverPosition(anchor, panel)
  useEscapeLayer(onClose)
  const audio = audioSupport()

  return createPortal(
    <div className={`emoji-picker-layer ${sheet ? 'sheet' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className="share-menu" style={style} role="dialog" aria-label={t('voice.share.title')}>
        <strong>{t('voice.share.title')}</strong>
        <div className="field">
          <span>{t('voice.share.quality')}</span>
          <div className="segmented" role="radiogroup" aria-label={t('voice.share.quality')}>
            {QUALITIES.map((q) => (
              <button key={q.id} role="radio" aria-checked={settings.quality === q.id} className={settings.quality === q.id ? 'on' : ''}
                onClick={() => updateShareSettings({ quality: q.id })}>
                {q.id === 'source' ? t('voice.share.source') : q.label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>{t('voice.share.optimiseFor')}</span>
          <div className="segmented" role="radiogroup" aria-label={t('voice.share.optimiseFor')}>
            <button role="radio" aria-checked={settings.hint === 'motion'} className={settings.hint === 'motion' ? 'on' : ''} onClick={() => updateShareSettings({ hint: 'motion' })}>
              {t('voice.share.motion')}
            </button>
            <button role="radio" aria-checked={settings.hint === 'detail'} className={settings.hint === 'detail' ? 'on' : ''} onClick={() => updateShareSettings({ hint: 'detail' })}>
              {t('voice.share.detail')}
            </button>
          </div>
          <small className="muted">{settings.hint === 'motion' ? t('voice.share.motionHint') : t('voice.share.detailHint')}</small>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={settings.audio && audio.ok} disabled={!audio.ok} onChange={(e) => updateShareSettings({ audio: e.target.checked })} />
          <span>
            {t('voice.share.audio')}
            <br /><small className="muted">{audio.note}</small>
          </span>
        </label>
        <button
          className="button primary"
          onClick={() => {
            onClose()
            void toggleScreenShare()
          }}
        >
          {t('voice.share.start')}
        </button>
      </div>
    </div>,
    document.body,
  )
}

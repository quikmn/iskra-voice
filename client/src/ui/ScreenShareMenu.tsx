// Before sharing: quality, sound and what you're sharing (motion vs detail). Remembered for next time.
import { useRef } from 'react'
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
      ? { ok: true, note: "Shares the sound your computer plays, except the call itself." }
      : { ok: false, note: "Sharing sound from the app isn't available on macOS and Linux yet. In Chrome or Edge you can share a tab's sound." }
  }
  return { ok: true, note: "Your browser asks which sound to share: a tab, or on Windows your whole computer (without this call, in up-to-date Chrome and Edge)." }
}

export function ScreenShareMenu({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const settings = useScreenShareSettings()
  const panel = useRef<HTMLDivElement>(null)
  const { style, sheet } = usePopoverPosition(anchor, panel)
  useEscapeLayer(onClose)
  const audio = audioSupport()

  return createPortal(
    <div className={`emoji-picker-layer ${sheet ? 'sheet' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className="share-menu" style={style} role="dialog" aria-label="Share your screen">
        <strong>Share your screen</strong>
        <div className="field">
          <span>Quality</span>
          <div className="segmented" role="radiogroup" aria-label="Quality">
            {QUALITIES.map((q) => (
              <button key={q.id} role="radio" aria-checked={settings.quality === q.id} className={settings.quality === q.id ? 'on' : ''}
                onClick={() => updateShareSettings({ quality: q.id })}>
                {q.label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Optimise for</span>
          <div className="segmented" role="radiogroup" aria-label="Optimise for">
            <button role="radio" aria-checked={settings.hint === 'motion'} className={settings.hint === 'motion' ? 'on' : ''} onClick={() => updateShareSettings({ hint: 'motion' })}>
              Motion
            </button>
            <button role="radio" aria-checked={settings.hint === 'detail'} className={settings.hint === 'detail' ? 'on' : ''} onClick={() => updateShareSettings({ hint: 'detail' })}>
              Detail
            </button>
          </div>
          <small className="muted">{settings.hint === 'motion' ? 'Smooth games and video.' : 'Sharp text and code.'}</small>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={settings.audio && audio.ok} disabled={!audio.ok} onChange={(e) => updateShareSettings({ audio: e.target.checked })} />
          <span>
            Share audio
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
          Share screen
        </button>
      </div>
    </div>,
    document.body,
  )
}

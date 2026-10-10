// The volume popover (a bottom sheet on phones) for one person in voice. Opened by useVolumeMenu.
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { maxVolume, setVolume, useVoice } from '../state/voice'
import { usePopoverPosition } from './expressions/popover'
import { useEscapeLayer } from './layers'
import { Volume } from './icons'

export interface VolumeTarget {
  accountKey: string
  name: string
  anchor: HTMLElement
}

export function VolumeMenu({ target, onClose }: { target: VolumeTarget; onClose: () => void }) {
  const volume = useVoice((s) => s.volumes[target.accountKey] ?? 1)
  const panel = useRef<HTMLDivElement>(null)
  const { style, sheet } = usePopoverPosition(target.anchor, panel)
  useEscapeLayer(onClose)
  const max = maxVolume()
  const shown = Math.min(volume, max)

  return createPortal(
    <div className={`emoji-picker-layer ${sheet ? 'sheet' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className="volume-menu" style={style} role="dialog" aria-label={`Volume for ${target.name}`}>
        <div className="volume-menu-head">
          <strong>{target.name}</strong>
          <span className="muted">{Math.round(shown * 100)}%</span>
        </div>
        <label className="volume-menu-row">
          <Volume size={16} />
          <input
            type="range" min={0} max={max} step={0.05} value={shown} autoFocus
            aria-label={`Volume for ${target.name}`}
            onChange={(e) => setVolume(target.accountKey, Number(e.target.value))}
          />
        </label>
        <div className="volume-menu-actions">
          <button className="button small" onClick={() => setVolume(target.accountKey, 0)} disabled={shown === 0}>Mute for me</button>
          <button className="button small" onClick={() => setVolume(target.accountKey, 1)} disabled={shown === 1}>Reset</button>
        </div>
        <p className="muted volume-menu-note">Only changes what you hear, on this device.</p>
      </div>
    </div>,
    document.body,
  )
}

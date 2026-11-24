// Choosing a microphone, a speaker or a camera from the call's own buttons: the small arrow next to a button, the list
// it opens (a menu on desktop, a sheet on phones; state/callDevices.ts), and a call's microphone or camera problem with
// its two ways out.
import { useEffect, useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAudio } from '../../state/audio'
import { useBackground } from '../../state/background'
import { openBugReport } from '../../state/bugReport/bugReport'
import { choicesFor, closeDevicePicker, openDevicePicker, pickDevice, useCallDevices, type PickerKind } from '../../state/callDevices'
import { useSpeaker } from '../../state/nativeVoice'
import { clearVoiceError, useVoice } from '../../state/voice'
import { ChevronUp, Close, Settings } from '../icons'
import { Menu, MenuGroup, MenuItem, type MenuAnchor } from '../kit'
import { openMySettings } from '../settings/open'
import './devices.css'

/** The list of one kind, kept current: devices coming and going, the choice changing, the language. */
export function useDeviceChoices(kind: PickerKind) {
  useTranslation()
  useCallDevices((s) => s.devices)
  useAudio((s) => (kind === 'mic' ? s.inputDevice : s.outputDevice))
  useBackground((s) => s.settings.camera)
  useSpeaker()
  return choicesFor(kind)
}

/** Opens upward from a button at the bottom of the window, downward where there is room below. */
function anchorAt(el: Element): MenuAnchor {
  const box = el.getBoundingClientRect()
  return { x: box.left, y: box.bottom + 6, above: box.top - 6 }
}

const LABEL = { mic: 'voice.devices.mic', speaker: 'voice.devices.speaker', camera: 'voice.devices.camera' } as const

/** The arrow next to a call button. Not shown where there is nothing to choose (an iPhone's speaker, Safari's). */
export function DeviceCaret({ kind, className = 'call-caret' }: { kind: PickerKind; className?: string }) {
  const { t } = useTranslation()
  const open = useCallDevices((s) => s.picker?.kind === kind)
  const choices = useDeviceChoices(kind)
  if (choices.length === 0) return null
  return (
    <button
      className={className} aria-label={t(LABEL[kind])} title={t(LABEL[kind])} aria-haspopup="dialog" aria-expanded={open} data-testid={`pick-${kind}`}
      onClick={(e) => void openDevicePicker(kind, anchorAt(e.currentTarget))}
    >
      <ChevronUp size={14} />
    </button>
  )
}

/**
 * A call button with its arrow: one pill on desktop, a badge on the button's corner on phones. Just the button where
 * there is nothing to choose.
 */
export function DeviceSplit({ kind, phone, children }: { kind: PickerKind; phone?: boolean; children: ReactNode }) {
  const any = useDeviceChoices(kind).length > 0
  if (!any) return <>{children}</>
  return <span className={phone ? 'call-pick' : 'call-split'}>{children}<DeviceCaret kind={kind} /></span>
}

const HOLD_MS = 450

/**
 * Touch: pressing and holding a call button opens its list too (the arrow is small). Spread on the button; the tap
 * that ends the hold does not also mute.
 */
export function useHoldToPick(kind: PickerKind) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      held.current = false
      if (e.pointerType !== 'touch') return
      const el = e.currentTarget
      timer.current = setTimeout(() => {
        timer.current = null
        if (choicesFor(kind).length === 0) return
        held.current = true
        navigator.vibrate?.(10)
        void openDevicePicker(kind, anchorAt(el))
      }, HOLD_MS)
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: MouseEvent) => {
      if (!held.current) return
      held.current = false
      e.preventDefault()
      e.stopPropagation()
    },
    onContextMenu: (e: MouseEvent) => {
      if (held.current || timer.current) e.preventDefault()
    },
  }
}

/** Mounted once in the shell: the list that is open. */
export function DevicePickerLayer() {
  const { t } = useTranslation()
  const picker = useCallDevices((s) => s.picker)
  const choices = useDeviceChoices(picker?.kind ?? 'mic')
  if (!picker) return null
  const { kind, anchor } = picker
  const title = kind === 'mic' ? t('voice.devices.input') : kind === 'speaker' ? t('voice.devices.output') : t('voice.devices.cameras')
  return (
    <Menu anchor={anchor} label={t(LABEL[kind])} onClose={closeDevicePicker}>
      <MenuGroup label={title}>
        {choices.map((choice) => (
          <MenuItem
            key={choice.id} checked={choice.current}
            onClick={() => {
              closeDevicePicker()
              if (!choice.current) pickDevice(kind, choice.id)
            }}
          >
            {choice.label}
          </MenuItem>
        ))}
      </MenuGroup>
      <MenuGroup>
        <MenuItem
          icon={<Settings size={16} />}
          onClick={() => {
            closeDevicePicker()
            openMySettings(kind === 'camera' ? 'video' : 'voice')
          }}
        >
          {kind === 'camera' ? t('settings.sections.video') : t('voice.devices.settings')}
        </MenuItem>
      </MenuGroup>
    </Menu>
  )
}

/**
 * The call's error, in its own row above the buttons (it never covers them). One about your microphone or camera
 * comes with "Choose microphone" (the list, or Voice & audio where there is no list) and "Report a bug".
 * `inCall`: on a call screen; while one is on show the voice bar leaves the error to it.
 */
export function VoiceError({ inCall = false }: { inCall?: boolean }) {
  const { t } = useTranslation()
  const error = useVoice((s) => s.error)
  const device = useVoice((s) => s.errorDevice)
  const elsewhere = useCallDevices((s) => !inCall && s.errorPlaces > 0)
  useEffect(() => {
    if (!inCall) return
    useCallDevices.setState((s) => ({ errorPlaces: s.errorPlaces + 1 }))
    return () => useCallDevices.setState((s) => ({ errorPlaces: s.errorPlaces - 1 }))
  }, [inCall])
  if (!error || elsewhere) return null
  return (
    <div className={`call-problem ${inCall ? 'in-call' : ''}`} role="alert" data-testid="voice-error">
      <span className="call-problem-text">{error}</span>
      {device && (
        <span className="call-problem-actions">
          <button className="link" onClick={(e) => void openDevicePicker(device, anchorAt(e.currentTarget))}>
            {t(device === 'mic' ? 'voice.errors.chooseMic' : 'voice.errors.chooseCamera')}
          </button>
          <button className="link" onClick={openBugReport}>{t('bugReport.open')}</button>
        </span>
      )}
      <button className="icon-button small call-problem-close" onClick={clearVoiceError} aria-label={t('app.dismiss')}><Close size={14} /></button>
    </div>
  )
}

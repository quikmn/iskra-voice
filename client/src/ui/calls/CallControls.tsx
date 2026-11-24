// The call's control bar, used by voice channels, stages, DM calls and group calls. Three groups on one row:
// you (mic, deafen, camera, screen), together (watch, whiteboard, activities, soundboard: one popover) and the call
// (captions, more, hang up). Phones get five big buttons and a sheet for the rest. The mic, the speaker and the camera
// carry a small arrow for choosing the device (DevicePicker.tsx).
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { t as translate } from '../../i18n'
import {
  canFlipCamera, canShareScreen, flipCamera, leaveVoice, toggleCamera, toggleDeafen, toggleMute, toggleScreenShare, useVoice,
} from '../../state/voice'
import { toggleSpeaker, useSpeaker } from '../../state/nativeVoice'
import {
  Camera, CameraOff, Headphones, HeadphonesOff, Mic, MicOff, MoreHorizontal, Phone, PhoneOff, ScreenShare, ScreenShareOff, Sparkles,
  SwitchCamera, Volume,
} from '../icons'
import { useEscapeLayer } from '../layers'
import { ScreenShareMenu } from '../ScreenShareMenu'
import { SoundboardButton } from '../expressions/Soundboard'
import { ClipButton, ClipsStrip } from '../clips/ClipControls'
import { RecordButton, RecordingStrip } from '../recording/Recording'
import { BackgroundNotice, CaptionsButton, CaptionsOverlay } from '../media/CallMedia'
import { ResumeOffer } from '../ResumeOffer'
import { DeviceSplit, useHoldToPick, VoiceError } from './DevicePicker'
import { trayAnchor } from './tray'
import './controls.css'
import { PHONE_LAYOUT } from '../../phoneLayout'

const PHONE = PHONE_LAYOUT

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof matchMedia === 'function' && matchMedia(PHONE).matches)
  useEffect(() => {
    const query = matchMedia(PHONE)
    const update = () => setPhone(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return phone
}

/**
 * The bar. `onLeave`: DM and group calls hang up their own way. `me`: more of your own controls (a stage's raise hand).
 * `together`: what the channel offers to do together (watch, whiteboard, activities); with it, the soundboard joins
 * them in one popover. `nameOf` names the people in the captions.
 */
export function CallControls({ onLeave, me, together, nameOf }: {
  onLeave?: () => void
  me?: ReactNode
  together?: ReactNode
  nameOf?: (accountKey: string) => string
}) {
  const { t } = useTranslation()
  const session = useVoice((s) => s.session)!
  const { muted, deafened, camera, screen, localSpeaking } = useVoice()
  const [shareMenu, setShareMenu] = useState<HTMLElement | null>(null)
  const speaker = useSpeaker()
  const phone = usePhone()
  const bar = useRef<HTMLDivElement>(null)
  const speak = session.canSpeak
  useNotesLane(bar, phone)
  // Touch: holding the mic or the speaker button opens its list, like the arrow on it.
  const holdMic = useHoldToPick('mic')
  const holdSpeaker = useHoldToPick('speaker')

  const mic = speak && (
    <button {...holdMic} className={`call-button ${muted ? 'off' : ''} ${localSpeaking && !muted ? 'talking' : ''}`} onClick={() => void toggleMute()} aria-pressed={muted} aria-label={muted ? t('voice.unmute') : t('voice.mute')} title={muted ? t('voice.unmute') : t('voice.mute')}>
      {muted ? <MicOff /> : <Mic />}
    </button>
  )
  // The speaker's arrow sits on the speaker button where there is one (the Android app, no headset in), else on deafen.
  const deafen = (hold: boolean) => session.afk ? (
    <button className="call-button off" disabled aria-label={t('afk.forced')} title={t('afk.forcedHint')}><HeadphonesOff /></button>
  ) : (
    <button {...(hold ? holdSpeaker : {})} className={`call-button ${deafened ? 'off' : ''}`} onClick={() => void toggleDeafen()} aria-pressed={deafened} aria-label={deafened ? t('voice.undeafen') : t('voice.deafen')} title={deafened ? t('voice.undeafen') : t('voice.deafen')}>
      {deafened ? <HeadphonesOff /> : <Headphones />}
    </button>
  )
  const speakerButton = speaker.shown && (
    <button {...holdSpeaker} className={`call-button ${speaker.on ? 'on' : ''}`} onClick={toggleSpeaker} aria-pressed={speaker.on} aria-label={t('voice.speaker')} title={speaker.on ? t('voice.speakerOn') : t('voice.earpieceOn')} data-testid="speaker-button">
      {speaker.on ? <Volume /> : <Phone />}
    </button>
  )
  const cameraButton = speak && (
    <button className={`call-button ${camera ? 'on' : ''}`} onClick={() => void toggleCamera()} aria-pressed={camera} aria-label={camera ? t('voice.cameraOff') : t('voice.cameraOn')} title={camera ? t('voice.cameraOff') : t('voice.cameraOn')}>
      {camera ? <Camera /> : <CameraOff />}
    </button>
  )
  const flip = speak && camera && canFlipCamera() && (
    <button className="call-button" onClick={() => void flipCamera()} aria-label={t('voice.flipCamera')} title={t('voice.flipCamera')} data-short={t('voice.flipShort')} data-testid="flip-camera">
      <SwitchCamera />
    </button>
  )
  const share = speak && canShareScreen() && (
    <button
      className={`call-button ${screen ? 'on' : ''}`}
      onClick={(e) => (screen ? void toggleScreenShare() : setShareMenu(shareMenu ? null : trayAnchor(e.currentTarget)))}
      aria-pressed={screen} aria-expanded={screen ? undefined : !!shareMenu} aria-label={screen ? t('voice.stopSharing') : t('voice.share.title')} title={screen ? t('voice.stopSharing') : t('voice.share.title')}>
      {screen ? <ScreenShareOff /> : <ScreenShare />}
    </button>
  )
  const soundboard = <SoundboardButton variant="call" />
  const hangUp = (
    <button className="call-button hang-up" onClick={() => (onLeave ? onLeave() : void leaveVoice())} aria-label={onLeave ? t('voice.hangUp') : t('voice.leaveCall')} title={onLeave ? t('voice.hangUp') : t('voice.leaveCall')}>
      <PhoneOff />
    </button>
  )

  return (
    <>
      <BackgroundNotice />
      <CaptionsOverlay nameOf={nameOf ?? (() => translate('common.someone'))} />
      <ClipsStrip />
      <RecordingStrip />
      <ResumeOffer />
      <VoiceError inCall />
      {session.afk && (
        <p className="afk-forced-banner" role="status" data-testid="afk-forced-banner"><HeadphonesOff size={16} /><strong>{t('afk.forced')}</strong> <span>{t('afk.forcedHint')}</span></p>
      )}
      {phone ? (
        // Phones: mic, camera (and flip while it's on), speaker (or deafen), more, hang up. The rest is in the sheet.
        <div ref={bar} className="call-controls phone" role="toolbar" aria-label={t('voice.stage.controls')}>
          {mic && <DeviceSplit kind="mic" phone>{mic}</DeviceSplit>}
          {cameraButton}
          {flip}
          <DeviceSplit kind="speaker" phone>{speakerButton || deafen(true)}</DeviceSplit>
          {me}
          <CallTray label={t('voice.tray.more')} icon={<MoreHorizontal />} sheet testId="call-more">
            <TraySection label={t('voice.tray.you')}>{speakerButton && deafen(false)}{share}</TraySection>
            <TraySection label={t('voice.tray.together')}>{together}{soundboard}</TraySection>
            <TraySection label={t('voice.tray.call')}><CaptionsButton /><ClipButton /><RecordButton /></TraySection>
          </CallTray>
          {hangUp}
        </div>
      ) : (
        <div ref={bar} className="call-controls" role="toolbar" aria-label={t('voice.stage.controls')}>
          <div className="call-group" role="group" aria-label={t('voice.tray.you')}>
            {mic && <DeviceSplit kind="mic">{mic}</DeviceSplit>}
            {speakerButton ? deafen(false) : <DeviceSplit kind="speaker">{deafen(false)}</DeviceSplit>}
            {speakerButton && <DeviceSplit kind="speaker">{speakerButton}</DeviceSplit>}
            {cameraButton && <DeviceSplit kind="camera">{cameraButton}</DeviceSplit>}
            {flip}
            {share}
            {me}
          </div>
          {together && (
            <div className="call-group" role="group" aria-label={t('voice.tray.together')}>
              <CallTray label={t('voice.tray.together')} hint={t('voice.tray.togetherHint')} icon={<Sparkles />} grid testId="call-together">
                {together}{soundboard}
              </CallTray>
            </div>
          )}
          <div className="call-group" role="group" aria-label={t('voice.tray.call')}>
            {!together && soundboard}
            <CaptionsButton />
            <CallTray label={t('voice.tray.more')} icon={<MoreHorizontal />} testId="call-more">
              <ClipButton />
              <RecordButton />
            </CallTray>
            {hangUp}
          </div>
        </div>
      )}
      {shareMenu && <ScreenShareMenu anchor={shareMenu} onClose={() => setShareMenu(null)} />}
    </>
  )
}

/**
 * The passing notes ("Alice played airhorn") sit just above the call controls when they're at the bottom of the
 * window, whatever their height (ui/kit/kit.css reads --notes-lane-bottom).
 */
function useNotesLane(bar: RefObject<HTMLDivElement | null>, phone: boolean) {
  useLayoutEffect(() => {
    const el = bar.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const place = () => {
      const box = el.getBoundingClientRect()
      // Only a bar along the bottom (the DM call's bar sits above the chat, whose message box the default clears).
      if (box.height > 0 && window.innerHeight - box.bottom < 120) root.style.setProperty('--notes-lane-bottom', `${Math.round(window.innerHeight - box.top + 8)}px`)
      else root.style.removeProperty('--notes-lane-bottom')
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      root.style.removeProperty('--notes-lane-bottom')
    }
  }, [bar, phone])
}

/**
 * A call button that opens a small panel of more call buttons (a sheet on phones). The panel stays mounted while
 * closed, so a dialog one of them opened stays open after the panel closes; picking one closes it and hands focus
 * back to this button, which is where that dialog returns focus to.
 */
function CallTray({ label, hint, icon, sheet, grid, testId, children }: {
  label: string; hint?: string; icon: ReactNode; sheet?: boolean; grid?: boolean; testId?: string; children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = () => {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  useEscapeLayer(close, open)

  useEffect(() => {
    if (!open) return
    if (!matchMedia('(pointer: coarse)').matches) items(panel.current)[0]?.focus({ preventScroll: true })
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items(panel.current)
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? at - 1
      : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null
    if (next === null || list.length === 0) return
    e.preventDefault()
    list[(next + list.length) % list.length].focus()
  }

  return (
    <div ref={wrap} className={`call-tray ${sheet ? 'sheet' : ''} ${open ? 'open' : ''}`}>
      <button
        ref={trigger} className="call-button call-tray-trigger" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={id}
        aria-label={label} title={hint ?? label} data-testid={testId}
      >
        {icon}
      </button>
      {sheet && open && <div className="call-tray-scrim" onClick={close} aria-hidden />}
      <div
        id={id} ref={panel} className={`call-tray-panel ${grid ? 'grid' : ''}`} role="group" aria-label={label} hidden={!open} onKeyDown={keys}
        onClick={(e) => {
          const button = (e.target as Element).closest('button')
          if (button && !button.disabled && panel.current?.contains(button)) close()
        }}
      >
        {sheet && <span className="sheet-grabber" aria-hidden />}
        {children}
      </div>
    </div>
  )
}

const items = (panel: HTMLElement | null) => [...(panel?.querySelectorAll<HTMLButtonElement>('.call-button:not(:disabled)') ?? [])]

function TraySection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="call-tray-section" role="group" aria-label={label}>
      <div className="call-tray-label" aria-hidden>{label}</div>
      <div className="call-tray-items">{children}</div>
    </div>
  )
}

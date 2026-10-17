// "Report a bug": where it's open (its own window, or in the page), the draft (it stays until it's sent, so going
// offline or closing the window loses nothing) and gathering what goes with it: the environment, allowlisted
// settings, voice stats and the diagnostics buffer.
import { create } from 'zustand'
import { BUILD_COMMIT } from '../../buildInfo'
import { currentLanguage, useLanguageChoice } from '../../i18n'
import { RELEASE_VERSION } from '../../links'
import { desktop, osName } from '../../platform/desktop'
import { nativePlatform } from '../../platform/native'
import { useAudio } from '../audio'
import { findPopout, focusPopout, popIn, popOut, popoutModeFor, type PopoutTarget } from '../popouts'
import { reportOpenAction } from './reportWindow'
import { activeRoom, useVoice } from '../voice'
import { parseLine } from '../../core/log'
import { APP_STARTED_AT, diagnostics } from './diagnostics'
import { buildPayload, emptyDraft, platformInfo, renderLogs, type Device, type ReportDraft, type ReportEnv, type ReportPayload, type SettingsSnapshot, type VoiceSnapshot } from './payload'

interface BugReportState {
  /** Shown in the page (where there's no window for it: phones, Firefox, Safari). */
  open: boolean
  /** In the page, tucked into a small chip while you keep using the app ("Keep using Iskra"). */
  tucked: boolean
  draft: ReportDraft
}

export const useBugReport = create<BugReportState>(() => ({ open: false, tucked: false, draft: emptyDraft() }))

const REPORT: PopoutTarget = { kind: 'report' }

/**
 * "Report a bug" (call it from a click or key press: browsers only open picture-in-picture for one). A window of its
 * own where there can be one, so the app stays usable and can be photographed; else in the page. Again: brings it up.
 */
export function openBugReport(): void {
  const shown = findPopout(REPORT)
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const action = reportOpenAction({ windowOpen: !!shown, dialogOpen: useBugReport.getState().open, mode: popoutModeFor('report'), touch })
  if (action === 'focus' && shown) return focusPopout(shown.id)
  if (action === 'dialog') return useBugReport.setState({ open: true, tucked: false })
  if (action !== 'window') return
  useBugReport.setState({ tucked: false })
  void popOut(REPORT).then((ok) => {
    if (!ok) return useBugReport.setState({ open: true, tucked: false })
    // Pop-outs open without taking focus; this one is for typing in straight away. (Not there yet: still opening.)
    const opened = findPopout(REPORT)
    if (opened) focusPopout(opened.id)
  })
}

/** Closes the report wherever it is; the draft stays until it's sent. */
export function closeBugReport(): void {
  const shown = findPopout(REPORT)
  if (shown) popIn(shown.id)
  useBugReport.setState({ open: false, tucked: false })
}

/** "Keep using Iskra": the report in the page steps aside into a chip. */
export const tuckBugReport = () => useBugReport.setState({ open: false, tucked: true })
/** The chip: back to the report. */
export const untuckBugReport = () => useBugReport.setState({ open: true, tucked: false })
export const updateDraft = (patch: Partial<ReportDraft>) => useBugReport.setState((s) => ({ draft: { ...s.draft, ...patch } }))
/** After sending: a fresh form next time. */
export const resetDraft = () => useBugReport.setState({ draft: emptyDraft() })

export function deviceKind(): Device {
  if (desktop) return 'desktop'
  return nativePlatform() ?? 'web'
}

export function collectEnv(): ReportEnv {
  const { os, browser } = platformInfo(typeof navigator === 'undefined' ? '' : navigator.userAgent)
  return {
    version: RELEASE_VERSION,
    commit: BUILD_COMMIT,
    // The desktop app knows its OS for sure (a user agent can be changed, or say Windows on a Mac).
    os: desktop && typeof desktop.platform === 'string' ? osName(desktop.platform).slice(0, 20) : os,
    ...(browser ? { browser } : {}),
    device: deviceKind(),
    language: currentLanguage(),
  }
}

/** Only switches and fixed choices: never device ids, names, keys or anything typed. */
export async function collectSettings(): Promise<SettingsSnapshot> {
  const a = useAudio.getState()
  const voice = useVoice.getState()
  const settings: SettingsSnapshot = {
    language: useLanguageChoice.getState().choice,
    noise: a.noise,
    aiStrength: a.aiStrength,
    echoCancellation: a.echoCancellation,
    autoGainControl: a.autoGainControl,
    inputDevice: a.inputDevice ? 'chosen' : 'default',
    outputDevice: a.outputDevice ? 'chosen' : 'default',
    inputVolume: Math.round(a.inputVolume * 100) / 100,
    outputVolume: Math.round(a.outputVolume * 100) / 100,
    threshold: a.threshold,
    cleanIncoming: a.cleanIncoming,
    leveling: a.leveling,
    hifi: a.hifi,
    voiceMode: voice.settings.mode,
    notifications: typeof Notification === 'undefined' ? 'none' : Notification.permission,
  }
  if (desktop) {
    const d = await desktop.settings.get().catch(() => null)
    if (d) {
      settings.openAtLogin = d.openAtLogin
      settings.closeToTray = d.closeToTray
      settings.hardwareAcceleration = d.hardwareAcceleration
      settings.activity = d.activity
      if (typeof d.updateChecks === 'boolean') settings.updateChecks = d.updateChecks
    }
  }
  return settings
}

const percent = (lost?: number, total?: number) =>
  typeof lost === 'number' && typeof total === 'number' && lost + total > 0 ? (100 * lost) / (lost + total) : undefined

/** The call you're in: its state, the noise engines, and what WebRTC says about the connection. */
export async function collectVoice(): Promise<VoiceSnapshot> {
  const v = useVoice.getState()
  if (!v.session) return { state: 'none' }
  const snapshot: VoiceSnapshot = {
    state: v.session.state,
    call: v.session.call ? 'dm' : v.session.group ? 'group' : 'channel',
    micEngine: v.micEngine,
    cleanEngine: v.cleanEngine,
    hifi: v.hifi,
  }
  const room = activeRoom()
  if (!room) return snapshot
  try {
    for (const publication of room.localParticipant.audioTrackPublications.values()) {
      const track = publication.audioTrack as (typeof publication.audioTrack & { getSenderStats?: () => Promise<{ packetsLost?: number; packetsSent?: number; jitter?: number; roundTripTime?: number } | undefined> }) | undefined
      const stats = await track?.getSenderStats?.()
      const codec = track?.sender?.getParameters().codecs?.[0]?.mimeType
      if (codec && /^audio\/[a-z0-9]{1,12}$/i.test(codec)) snapshot.codec = codec.slice(6).toLowerCase()
      if (stats) {
        snapshot.lossOut = percent(stats.packetsLost, stats.packetsSent)
        if (typeof stats.roundTripTime === 'number') snapshot.rttMs = stats.roundTripTime * 1000
      }
      break
    }
    let lost = 0, received = 0, jitter = 0, count = 0
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        const track = publication.audioTrack as { getReceiverStats?: () => Promise<{ packetsLost?: number; packetsReceived?: number; jitter?: number } | undefined> } | undefined
        const stats = await track?.getReceiverStats?.().catch(() => undefined)
        if (!stats) continue
        lost += stats.packetsLost ?? 0
        received += stats.packetsReceived ?? 0
        if (typeof stats.jitter === 'number') { jitter += stats.jitter; count++ }
      }
    }
    if (received > 0) snapshot.lossIn = percent(lost, received)
    if (count > 0) snapshot.jitterMs = (jitter / count) * 1000
  } catch { /* stats are a bonus */ }
  return snapshot
}

/** The desktop app's own lines (main process, updater, and this page's from before a reload); none elsewhere. */
async function desktopLines(): Promise<string[]> {
  const lines = await desktop?.logs?.tail().catch(() => null)
  if (!Array.isArray(lines)) return []
  // This page's lines are already in its own buffer: from the file only the ones from before it started.
  const started = new Date(APP_STARTED_AT).toISOString()
  return lines.filter((l): l is string => typeof l === 'string' && (parseLine(l)?.src !== 'app' || l.slice(0, 24) < started)).slice(-2000)
}

/** The logs that go with a report, if the reporter keeps "Include logs" on. */
export async function collectLogs(env: ReportEnv, now = Date.now()): Promise<string> {
  const [settings, voice, extra] = await Promise.all([collectSettings(), collectVoice(), desktopLines()])
  return renderLogs({ now, env, settings, voice, entries: diagnostics.entries(now), startedAt: APP_STARTED_AT, extra })
}

/** The payload exactly as it will be sent. */
export async function preparePayload(draft: ReportDraft): Promise<ReportPayload> {
  const env = collectEnv()
  return buildPayload(draft, env, draft.includeLogs ? await collectLogs(env) : null)
}

/** The shortcut as this device writes it; null on phones and tablets (no keyboard to speak of). */
export function bugShortcut(): string | null {
  if (typeof navigator === 'undefined' || nativePlatform() || /Android|iPhone|iPad|iPod/.test(navigator.userAgent)) return null
  return /Mac/.test(navigator.platform) ? '⌘⇧B' : 'Ctrl+Shift+B'
}

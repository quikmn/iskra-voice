// Choosing the microphone, the speaker and the camera from the call's own controls: the devices the browser lists
// (kept current while they come and go), which picker is open, and what picking does. The lists themselves are built
// in deviceChoices.ts; the Android app's outputs come from nativeVoice.ts.
import { create } from 'zustand'
import { t } from '../i18n'
import { native } from '../platform/native'
import type { MenuAnchor } from '../ui/organize/menuPlacement'
import { openMySettings } from '../ui/settings/open'
import { outputSelectable, updateAudio, useAudio } from './audio'
import { switchCamera, useBackground } from './background'
import { deviceChoices, outputSource, routeChoices, type DeviceChoice, type DeviceLike } from './deviceChoices'
import { pickRoute, refreshRoutes, useSpeaker } from './nativeVoice'
import { useVoice } from './voice'

export type PickerKind = 'mic' | 'speaker' | 'camera'

interface CallDevices {
  devices: DeviceLike[]
  /** The picker that is open. No anchor: a sheet (phones always show one). */
  picker: { kind: PickerKind; anchor: MenuAnchor | null } | null
  /** Call screens on show that carry the call's error: the voice bar then leaves it to them. */
  errorPlaces: number
}

export const useCallDevices = create<CallDevices>(() => ({ devices: [], picker: null, errorPlaces: 0 }))

/** Asks the browser for its devices again. Names come once the microphone or camera has been allowed. */
export async function refreshCallDevices(): Promise<void> {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!media?.enumerateDevices) return
  try {
    const list = await media.enumerateDevices()
    useCallDevices.setState({ devices: list.map((d) => ({ kind: d.kind, deviceId: d.deviceId, label: d.label })) })
  } catch {
    /* the list stays as it was */
  }
}

const speakerSource = () =>
  outputSource({ platform: native?.platform ?? null, nativeRoutes: useSpeaker.getState().routes.length > 0, sinkId: outputSelectable() })

/** What the picker of one kind lists, the current one marked. Empty: nothing to choose here (no arrow is shown). */
export function choicesFor(kind: PickerKind): DeviceChoice[] {
  const { devices } = useCallDevices.getState()
  const fallback = t('settings.audio.systemDefault')
  if (kind === 'mic') return deviceChoices('audioinput', devices, useAudio.getState().inputDevice, { default: fallback, numbered: (n) => t('settings.audio.micN', { n }) })
  if (kind === 'camera') return deviceChoices('videoinput', devices, useBackground.getState().settings.camera, { default: fallback, numbered: (n) => t('media.background.cameraN', { n }) })
  const source = speakerSource()
  if (source === 'routes') {
    const { routes, route } = useSpeaker.getState()
    return routeChoices(routes, route, (k) => t(`voice.devices.route.${k}`))
  }
  if (source === 'browser') return deviceChoices('audiooutput', devices, useAudio.getState().outputDevice, { default: fallback, numbered: (n) => t('settings.audio.speakerN', { n }) })
  return []
}

/** Switches the running call to it and keeps it as the setting. (An Android route lasts for the call.) */
export function pickDevice(kind: PickerKind, id: string): void {
  if (kind === 'mic') updateAudio({ inputDevice: id })
  else if (kind === 'camera') void switchCamera(id)
  else if (speakerSource() === 'routes') pickRoute(Number(id))
  else updateAudio({ outputDevice: id })
}

/** Opens the list of one kind; where there is nothing to list, its page in My settings instead. */
export async function openDevicePicker(kind: PickerKind, anchor: MenuAnchor | null): Promise<void> {
  if (kind === 'speaker') refreshRoutes()
  await refreshCallDevices()
  if (choicesFor(kind).length === 0) return openMySettings(kind === 'camera' ? 'video' : 'voice')
  useCallDevices.setState({ picker: { kind, anchor } })
}

export function closeDevicePicker(): void {
  useCallDevices.setState({ picker: null })
}

if (typeof navigator !== 'undefined') navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshCallDevices())
useVoice.subscribe((s, prev) => {
  // Joining, the microphone starting and the camera starting are when the browser begins to name devices.
  if (s.session?.state !== prev.session?.state || s.micEngine !== prev.micEngine || s.camera !== prev.camera || s.error !== prev.error) void refreshCallDevices()
})

// The lists the call's device pickers show: microphones, speakers and cameras from the browser, and on the Android
// app what a call can play on (speaker, phone, headset). Pure: state/callDevices.ts feeds them.

export interface DeviceChoice {
  /** '' = the system default. */
  id: string
  label: string
  current: boolean
}

export interface DeviceLike {
  kind: string
  deviceId: string
  label: string
}

/** Chrome ends a USB device's name with its vendor and product numbers: "Webcam C920 (046d:082d)". */
export const cleanDeviceLabel = (label: string) => label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim()

/** The real devices of one kind: no entries without an id (before permission), none of the browser's "default" aliases. */
export function listedDevices(kind: MediaDeviceKind, devices: readonly DeviceLike[]): DeviceLike[] {
  const seen = new Set<string>()
  return devices.filter((d) => {
    if (d.kind !== kind || !d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications' || seen.has(d.deviceId)) return false
    seen.add(d.deviceId)
    return true
  })
}

/**
 * "Default" first, then each device by name. A device without a name (no permission yet) is numbered; two with the
 * same name are told apart by a number. Empty when the browser lists none: there is nothing to choose.
 * `chosen` that is not in the list (unplugged, or a phone's new ids) shows as the default, which is what plays.
 */
export function deviceChoices(
  kind: MediaDeviceKind, devices: readonly DeviceLike[], chosen: string,
  text: { default: string; numbered: (n: number) => string },
): DeviceChoice[] {
  const list = listedDevices(kind, devices)
  if (list.length === 0) return []
  const known = list.some((d) => d.deviceId === chosen)
  const used = new Map<string, number>()
  const named = list.map((d, i) => {
    const base = cleanDeviceLabel(d.label) || text.numbered(i + 1)
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    return { id: d.deviceId, label: n > 1 ? `${base} (${n})` : base, current: known && d.deviceId === chosen }
  })
  return [{ id: '', label: text.default, current: !known }, ...named]
}

// ── The Android app: where a call plays ──────────────────────────────────

export const ROUTE_KINDS = ['speaker', 'earpiece', 'wired', 'usb', 'bluetooth', 'hearingAid'] as const
export type RouteKind = (typeof ROUTE_KINDS)[number]

export interface NativeRoute {
  id: number
  kind: RouteKind
  /** The device's own name, as Android has it (a Bluetooth headset's). */
  name: string
}

/** The plugin's answer (voiceRoutes, voiceRoute), checked: anything malformed is left out. */
export function parseRoutes(raw: unknown): { routes: NativeRoute[]; current: number | null } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { routes?: unknown; current?: unknown }
  const routes: NativeRoute[] = []
  for (const item of Array.isArray(r.routes) ? r.routes.slice(0, 20) : []) {
    const { id, kind, name } = (item && typeof item === 'object' ? item : {}) as { id?: unknown; kind?: unknown; name?: unknown }
    if (typeof id !== 'number' || !Number.isInteger(id) || !ROUTE_KINDS.includes(kind as RouteKind) || routes.some((x) => x.id === id)) continue
    routes.push({ id, kind: kind as RouteKind, name: typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 60) : '' })
  }
  routes.sort((a, b) => ROUTE_KINDS.indexOf(a.kind) - ROUTE_KINDS.indexOf(b.kind))
  const current = typeof r.current === 'number' && routes.some((x) => x.id === r.current) ? r.current : null
  return { routes, current }
}

/**
 * Speaker, Phone, then headsets. A Bluetooth headset or hearing aid goes by its own name; the others by what they are
 * (Android names a wired headset after the phone). Two with the same words are numbered.
 */
export function routeChoices(routes: readonly NativeRoute[], current: number | null, kindText: (kind: RouteKind) => string): DeviceChoice[] {
  const used = new Map<string, number>()
  return routes.map((route) => {
    const base = ((route.kind === 'bluetooth' || route.kind === 'hearingAid') && route.name) || kindText(route.kind)
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    return { id: String(route.id), label: n > 1 ? `${base} (${n})` : base, current: route.id === current }
  })
}

/**
 * Where the list of outputs comes from. The Android app: the phone's own routes (its web view can't choose one). The
 * iPhone app and browsers without setSinkId (Safari): the system chooses, so there is no list.
 */
export function outputSource(env: { platform: 'android' | 'ios' | null; nativeRoutes: boolean; sinkId: boolean }): 'routes' | 'browser' | 'none' {
  if (env.platform === 'android') return env.nativeRoutes ? 'routes' : 'none'
  if (env.platform === 'ios') return 'none'
  return env.sinkId ? 'browser' : 'none'
}

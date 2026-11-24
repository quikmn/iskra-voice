// The app's own Capacitor plugin (mobile/ios/App/App/IskraNative.swift, mobile/android/…/IskraNativePlugin.java).
//
// A Capacitor plugin object answers every property with a native method, `then` included. A promise resolved with the
// plugin itself (returned from an async function or a `.then`) therefore calls the native "then", which doesn't exist,
// and never settles. So the plugin is only ever handed to a callback, never returned through a promise.

export interface PluginListener {
  remove(): Promise<void>
}

export interface IskraNativePlugin {
  voiceStart(options: { title: string; call: boolean; video: boolean }): Promise<void>
  voiceUpdate(options: { title: string }): Promise<void>
  voiceStop(): Promise<void>
  voiceSpeaker(options: { on: boolean }): Promise<{ headset?: unknown }>
  /** Android: what a call can play on and which one it plays on (`{ routes: [{ id, kind, name }], current }`). */
  voiceRoutes(): Promise<unknown>
  /** Android: plays the call on this one; answers like voiceRoutes. */
  voiceRoute(options: { id: number }): Promise<unknown>
  keepAwake(options: { on: boolean }): Promise<void>
  addListener(event: string, callback: (data: never) => void): Promise<PluginListener>
  /** The newest share from another app, once (none when there's none). */
  takeShare(): Promise<{ share?: unknown }>
  shareDone(options: { id: string }): Promise<void>
}

let loaded: Promise<{ plugin: IskraNativePlugin }> | null = null

// Android only for now. Until 2.0.0-alpha.46 the plugin was never reached on either platform; Android has been tried
// in the emulator, the iOS side (CallKit, audio session, shares) has not run on a device yet. On iOS calls stay pending,
// exactly as before, until it has been tried there.
let enabled = false

/** Turns the plugin on for this platform (native.ts, at start). */
export function enablePlugin(on: boolean): void {
  enabled = on
}

/** Runs `use` with the plugin and answers with its result. Never settles while the plugin is off. */
export function withPlugin<T>(use: (plugin: IskraNativePlugin) => Promise<T> | T): Promise<T> {
  if (!enabled) return new Promise<T>(() => undefined)
  loaded ??= import('@capacitor/core').then(({ registerPlugin }) => ({ plugin: registerPlugin<IskraNativePlugin>('IskraNative') }))
  return loaded.then(({ plugin }) => use(plugin))
}

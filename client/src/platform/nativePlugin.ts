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
  keepAwake(options: { on: boolean }): Promise<void>
  addListener(event: string, callback: (data: never) => void): Promise<PluginListener>
  /** The newest share from another app, once (none when there's none). */
  takeShare(): Promise<{ share?: unknown }>
  shareDone(options: { id: string }): Promise<void>
}

let loaded: Promise<{ plugin: IskraNativePlugin }> | null = null

/** Runs `use` with the plugin and answers with its result. */
export function withPlugin<T>(use: (plugin: IskraNativePlugin) => Promise<T> | T): Promise<T> {
  loaded ??= import('@capacitor/core').then(({ registerPlugin }) => ({ plugin: registerPlugin<IskraNativePlugin>('IskraNative') }))
  return loaded.then(({ plugin }) => use(plugin))
}

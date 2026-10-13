// What the page tells the mic's worklet (micGate.worklet.ts) for your settings. Shared with the listening kit
// (listeningKit.ts), so it renders exactly what calls send.
import { AUTO_SPEAKING_DB, type AudioSettings } from '../audio'
import type { MicParams } from '../micGate.worklet'

export const gateParams = (s: AudioSettings, ptt: boolean): MicParams => ({
  gain: s.inputVolume,
  threshold: s.threshold ?? AUTO_SPEAKING_DB,
  gating: s.threshold !== null,
  vad: s.threshold === null,
  ptt,
})

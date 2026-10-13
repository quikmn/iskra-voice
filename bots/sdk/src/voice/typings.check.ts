// Type-checked by `npm run typecheck` in bots/ only (nothing imports it): the shapes modules.ts declares must match
// the real packages, so an upgrade that changes them fails here instead of at run time.
import type * as RtcNode from '@livekit/rtc-node'
import type { FLACDecoder } from '@wasm-audio-decoders/flac'
import type { OggVorbisDecoder } from '@wasm-audio-decoders/ogg-vorbis'
import type { MPEGDecoder } from 'mpg123-decoder'
import type { OggOpusDecoder } from 'ogg-opus-decoder'
import type { Rtc, RtcRoom, WasmDecoder } from './modules'

export type RtcFits = typeof RtcNode extends Rtc ? true : never
export type RoomFits = RtcNode.Room extends RtcRoom ? true : never
export type DecodersFit = [MPEGDecoder, OggOpusDecoder, OggVorbisDecoder, FLACDecoder] extends WasmDecoder[] ? true : never

export const checks: [RtcFits, RoomFits, DecodersFit] = [true, true, true]

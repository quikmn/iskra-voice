// Speech to text with OpenAI's Whisper (the ONNX export from onnx-community), run by ONNX Runtime Web. Greedy
// decoding without timestamps, English or Swedish (or whichever of the two it hears), with Whisper's own checks for
// "that wasn't speech". No DOM: runs in the captions worker and in Node (tests, benchmark).
import type * as Ort from 'onnxruntime-web'
import { logMel, N_MELS, FRAMES, WHISPER_RATE } from './mel.ts'

export type CaptionLanguage = 'en' | 'sv'

export const TOKENS = {
  endOfText: 50257,
  startOfTranscript: 50258,
  transcribe: 50359,
  noSpeech: 50362,
  noTimestamps: 50363,
  /** Timestamps and other specials start here: never part of the text. */
  firstSpecial: 50257,
  language: { en: 50259, sv: 50273 } as Record<CaptionLanguage, number>,
}

// From the model's generation_config.json (the same for tiny, base and small).
const SUPPRESS = [
  1, 2, 7, 8, 9, 10, 14, 25, 26, 27, 28, 29, 31, 58, 59, 60, 61, 62, 63, 90, 91, 92, 93, 359, 503, 522, 542, 873, 893, 902, 918, 922, 931, 1350,
  1853, 1982, 2460, 2627, 3246, 3253, 3268, 3536, 3846, 3961, 4183, 4667, 6585, 6647, 7273, 9061, 9383, 10428, 10929, 11938, 12033, 12331, 12562,
  13793, 14157, 14635, 15265, 15618, 16553, 16604, 18362, 18956, 20075, 21675, 22520, 26130, 26161, 26435, 28279, 29464, 31650, 32302, 32470,
  36865, 42863, 47425, 49870, 50254,
]
const BEGIN_SUPPRESS = [220, TOKENS.endOfText]

// ── Tokens to text ───────────────────────────────────────────────────────

/** GPT-2's byte-level BPE: every byte is a printable character in vocab.json. This maps them back. */
function byteDecoder(): Map<string, number> {
  const bytes: number[] = []
  for (let b = 33; b <= 126; b++) bytes.push(b)
  for (let b = 161; b <= 172; b++) bytes.push(b)
  for (let b = 174; b <= 255; b++) bytes.push(b)
  const chars = [...bytes]
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!bytes.includes(b)) {
      bytes.push(b)
      chars.push(256 + n++)
    }
  }
  return new Map(bytes.map((b, i) => [String.fromCharCode(chars[i]), b]))
}

export class Vocabulary {
  private readonly pieces: string[] = []
  private readonly bytes = byteDecoder()
  private readonly utf8 = new TextDecoder()

  /** `vocab` is the model's vocab.json (token → id). */
  constructor(vocab: Record<string, number>) {
    for (const [piece, id] of Object.entries(vocab)) this.pieces[id] = piece
  }

  decode(ids: number[]): string {
    const out: number[] = []
    for (const id of ids) {
      if (id >= TOKENS.firstSpecial) continue
      for (const ch of this.pieces[id] ?? '') {
        const b = this.bytes.get(ch)
        if (b !== undefined) out.push(b)
      }
    }
    return this.utf8.decode(new Uint8Array(out)).trim()
  }
}

// ── The model ────────────────────────────────────────────────────────────

export interface Transcript {
  text: string
  language: CaptionLanguage
  /** Whisper's own estimate that this wasn't speech at all. */
  noSpeech: number
  /** Mean log-probability of the chosen tokens (confidence). */
  avgLogProb: number
  /** Milliseconds spent: features, encoder, decoder. */
  ms: { features: number; encoder: number; decoder: number }
}

export interface WhisperOptions {
  /** Most tokens per transcript (a few seconds of speech is 10–40). */
  maxTokens?: number
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export class Whisper {
  private readonly heads: number
  private readonly headDim: number
  private readonly layers: number
  private readonly features = new Float32Array(N_MELS * FRAMES)
  private readonly suppress: Uint8Array
  private readonly ort: typeof Ort
  private readonly encoder: Ort.InferenceSession
  private readonly decoder: Ort.InferenceSession
  private readonly vocab: Vocabulary

  private constructor(
    ort: typeof Ort, encoder: Ort.InferenceSession, decoder: Ort.InferenceSession, vocab: Vocabulary,
    config: { decoder_attention_heads: number; d_model: number; decoder_layers: number; vocab_size: number },
  ) {
    this.ort = ort
    this.encoder = encoder
    this.decoder = decoder
    this.vocab = vocab
    this.heads = config.decoder_attention_heads
    this.headDim = config.d_model / config.decoder_attention_heads
    this.layers = config.decoder_layers
    this.suppress = new Uint8Array(config.vocab_size)
    for (const id of SUPPRESS) this.suppress[id] = 1
    // Text only: no timestamps, no other specials (the end of text is allowed, and handled on its own).
    for (let id = TOKENS.firstSpecial + 1; id < config.vocab_size; id++) this.suppress[id] = 1
  }

  static async create(
    ort: typeof Ort,
    model: { encoder: Uint8Array; decoder: Uint8Array; vocab: Record<string, number>; config: Record<string, unknown> },
    providers: Ort.InferenceSession.SessionOptions['executionProviders'] = ['wasm'],
  ): Promise<Whisper> {
    const options: Ort.InferenceSession.SessionOptions = { executionProviders: providers, graphOptimizationLevel: 'all' }
    const encoder = await ort.InferenceSession.create(model.encoder, options)
    const decoder = await ort.InferenceSession.create(model.decoder, options)
    return new Whisper(ort, encoder, decoder, new Vocabulary(model.vocab), model.config as never)
  }

  async release(): Promise<void> {
    await Promise.all([this.encoder.release(), this.decoder.release()])
  }

  /** Transcribes up to 30 s of 16 kHz mono audio. `language` 'auto' picks English or Swedish by what it hears. */
  async transcribe(audio: Float32Array, language: CaptionLanguage | 'auto', options: WhisperOptions = {}): Promise<Transcript> {
    const { ort } = this
    const t0 = now()
    logMel(audio, this.features)
    const t1 = now()
    const encoded = await this.encoder.run({ input_features: new ort.Tensor('float32', this.features, [1, N_MELS, FRAMES]) })
    const hidden = encoded.last_hidden_state
    const t2 = now()

    // Step 1: just the start token. Gives "no speech" and the language.
    let past = this.emptyPast()
    let out = await this.step([TOKENS.startOfTranscript], hidden, past, false)
    let logits = lastLogits(out.logits)
    const noSpeech = softmaxAt(logits, TOKENS.noSpeech)
    const lang: CaptionLanguage = language !== 'auto' ? language
      : logits[TOKENS.language.sv] > logits[TOKENS.language.en] ? 'sv' : 'en'
    past = this.presents(out)

    // Step 2: the rest of the prompt. Then one token at a time.
    out = await this.step([TOKENS.language[lang], TOKENS.transcribe, TOKENS.noTimestamps], hidden, past, true)
    const maxTokens = options.maxTokens ?? Math.min(160, Math.ceil((audio.length / WHISPER_RATE) * 8) + 12)
    const tokens: number[] = []
    let logProbSum = 0
    for (;;) {
      logits = lastLogits(out.logits)
      const { id, logProb } = this.pick(logits, tokens.length === 0)
      if (id === TOKENS.endOfText) break
      tokens.push(id)
      logProbSum += logProb
      if (tokens.length >= maxTokens || repeating(tokens)) break
      past = this.presents(out, past)
      out = await this.step([id], hidden, past, true)
    }
    const t3 = now()
    return {
      text: this.vocab.decode(tokens),
      language: lang,
      noSpeech,
      avgLogProb: tokens.length ? logProbSum / tokens.length : 0,
      ms: { features: t1 - t0, encoder: t2 - t1, decoder: t3 - t2 },
    }
  }

  private emptyPast(): Record<string, Ort.Tensor> {
    const past: Record<string, Ort.Tensor> = {}
    const empty = new Float32Array(0)
    for (let l = 0; l < this.layers; l++) {
      for (const kind of ['decoder', 'encoder']) {
        for (const kv of ['key', 'value']) past[`past_key_values.${l}.${kind}.${kv}`] = new this.ort.Tensor('float32', empty, [1, this.heads, 0, this.headDim])
      }
    }
    return past
  }

  /** The decoder's caches for the next step (the cross-attention ones are computed once, on the first step). */
  private presents(out: Ort.InferenceSession.OnnxValueMapType, previous?: Record<string, Ort.Tensor>): Record<string, Ort.Tensor> {
    const past: Record<string, Ort.Tensor> = {}
    for (let l = 0; l < this.layers; l++) {
      for (const kind of ['decoder', 'encoder']) {
        for (const kv of ['key', 'value']) {
          const name = `${l}.${kind}.${kv}`
          const fresh = out[`present.${name}`] as Ort.Tensor
          // With the cache branch the encoder's present outputs are empty placeholders: keep the first ones.
          past[`past_key_values.${name}`] = kind === 'encoder' && previous && fresh.size === 0 ? previous[`past_key_values.${name}`] : fresh
        }
      }
    }
    return past
  }

  private step(ids: number[], hidden: Ort.OnnxValue, past: Record<string, Ort.Tensor>, cached: boolean) {
    const { ort } = this
    return this.decoder.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      encoder_hidden_states: hidden as Ort.Tensor,
      use_cache_branch: new ort.Tensor('bool', [cached], [1]),
      ...past,
    })
  }

  private pick(logits: Float32Array, first: boolean): { id: number; logProb: number } {
    let best = -1
    let bestValue = -Infinity
    for (let i = 0; i < logits.length; i++) {
      if (this.suppress[i] && i !== TOKENS.endOfText) continue
      if (first && BEGIN_SUPPRESS.includes(i)) continue
      if (logits[i] > bestValue) {
        bestValue = logits[i]
        best = i
      }
    }
    let sum = 0
    for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i] - bestValue)
    return { id: best, logProb: -Math.log(sum) }
  }
}

function lastLogits(tensor: Ort.OnnxValue): Float32Array {
  const t = tensor as Ort.Tensor
  const vocab = t.dims[2]
  const seq = t.dims[1]
  return (t.data as Float32Array).subarray((seq - 1) * vocab, seq * vocab)
}

function softmaxAt(logits: Float32Array, index: number): number {
  let max = -Infinity
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i]
  let sum = 0
  for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i] - max)
  return Math.exp(logits[index] - max) / sum
}

/** Whisper's classic failure: the same few tokens over and over. Stop when the last 2–6 tokens repeat 3 times. */
export function repeating(tokens: number[]): boolean {
  const end = tokens.length
  for (let n = 1; n <= 6; n++) {
    // A single word may honestly come three times ("no, no, no"): only five in a row counts.
    const times = n === 1 ? 5 : 3
    if (end < n * times) break
    let same = true
    for (let i = 0; i < n && same; i++) {
      for (let r = 1; r < times && same; r++) same = tokens[end - 1 - i] === tokens[end - 1 - i - r * n]
    }
    if (same) return true
  }
  return false
}

/** Whisper's own rule for "this was silence or noise, not speech" (plus a floor for very unsure results). */
export function looksLikeSpeech(t: Pick<Transcript, 'noSpeech' | 'avgLogProb' | 'text'>): boolean {
  if (!t.text) return false
  if (t.noSpeech > 0.6 && t.avgLogProb < -1) return false
  return t.avgLogProb > -1.6
}

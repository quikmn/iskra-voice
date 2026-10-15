// Bergamot (Firefox Translations' engine, WebAssembly, bundled with the app) running Mozilla's translation models.
// Plain text in, plain text out: no HTML mode, so nothing it returns is ever markup. No DOM: runs in the translate
// worker and in Node (tests).
import loadBergamot, { type BergamotModel, type BergamotModule, type BergamotService } from '../../../vendor/bergamot/bergamot-translator.js'

export interface PairFiles {
  model: Uint8Array
  lex: Uint8Array
  vocab: Uint8Array
}

/** What the translate worker needs from an engine (tests use a fake). */
export interface Engine {
  has(pair: string): boolean
  load(pair: string, files: PairFiles): void
  /** `texts` through each model of `route` in turn (one, or two through English). */
  translate(texts: string[], route: string[]): string[]
}

// The integer matrix routines Bergamot expects from Firefox, taken from the copies inside the WebAssembly itself.
const GEMM: Record<string, string> = {
  int8_prepare_a: 'int8PrepareAFallback',
  int8_prepare_b: 'int8PrepareBFallback',
  int8_prepare_b_from_transposed: 'int8PrepareBFromTransposedFallback',
  int8_prepare_b_from_quantized_transposed: 'int8PrepareBFromQuantizedTransposedFallback',
  int8_prepare_bias: 'int8PrepareBiasFallback',
  int8_multiply_and_add_bias: 'int8MultiplyAndAddBiasFallback',
  int8_select_columns_of_b: 'int8SelectColumnsOfBFallback',
}

// Greedy decoding with the int8 models Mozilla ships (as Firefox runs them).
const CONFIG = [
  'beam-size: 1', 'normalize: 1.0', 'word-penalty: 0', 'cpu-threads: 0', 'gemm-precision: int8shiftAlphaAll', 'skip-cost: true',
  'alignment: soft', 'quiet: true', 'quiet-translation: true', 'max-length-break: 128', 'mini-batch-words: 1024', 'workspace: 128',
  'max-length-factor: 2.0',
].join('\n') + '\n'

/** At most this many models in memory (each 20-50 MB); the least recently used goes first. */
export const MAX_LOADED = 4

export class Bergamot implements Engine {
  private readonly models = new Map<string, BergamotModel>()

  private readonly M: BergamotModule
  private readonly service: BergamotService

  private constructor(M: BergamotModule, service: BergamotService) {
    this.M = M
    this.service = service
  }

  static async create(wasm: ArrayBuffer): Promise<Bergamot> {
    const M = await new Promise<BergamotModule>((resolve, reject) => {
      let module: BergamotModule | null = null
      module = loadBergamot({
        print: () => undefined,
        printErr: () => undefined,
        onAbort: (what) => reject(new Error(`Bergamot: ${String(what)}`)),
        instantiateWasm(imports, accept) {
          const gemm = Object.fromEntries(Object.entries(GEMM).map(([name, fallback]) => [name, (...args: number[]) => module!.asm[fallback](...args)]))
          WebAssembly.instantiate(wasm, { ...imports, wasm_gemm: gemm }).then(({ instance }) => accept(instance), reject)
          return {}
        },
        onRuntimeInitialized: () => resolve(module!),
      })
    })
    return new Bergamot(M, new M.BlockingService({ cacheSize: 0 }))
  }

  has(pair: string): boolean {
    return this.models.has(pair)
  }

  load(pair: string, files: PairFiles): void {
    if (this.models.has(pair)) return
    while (this.models.size >= MAX_LOADED) {
      const [oldest, model] = this.models.entries().next().value!
      model.delete()
      this.models.delete(oldest)
    }
    const vocabs = new this.M.AlignedMemoryList()
    vocabs.push_back(this.memory(files.vocab, 64))
    this.models.set(pair, new this.M.TranslationModel(CONFIG, this.memory(files.model, 256), this.memory(files.lex, 64), vocabs, null))
  }

  translate(texts: string[], route: string[]): string[] {
    const models = route.map((pair) => {
      const model = this.models.get(pair)
      if (!model) throw new Error(`not loaded: ${pair}`)
      // Most recently used last.
      this.models.delete(pair)
      this.models.set(pair, model)
      return model
    })
    if (!texts.length || !models.length) return texts
    const input = new this.M.VectorString()
    const options = new this.M.VectorResponseOptions()
    for (const text of texts) {
      input.push_back(text)
      options.push_back({ alignment: false, html: false, qualityScores: false })
    }
    const responses = models.length === 2
      ? this.service.translateViaPivoting(models[0], models[1], input, options)
      : this.service.translate(models[0], input, options)
    try {
      return texts.map((_, i) => responses.get(i).getTranslatedText())
    } finally {
      input.delete()
      options.delete()
      responses.delete()
    }
  }

  private memory(data: Uint8Array, alignment: number) {
    const memory = new this.M.AlignedMemory(data.byteLength, alignment)
    memory.getByteArrayView().set(new Int8Array(data.buffer, data.byteOffset, data.byteLength))
    return memory
  }
}

/**
 * The message as lines to translate: blank lines stay, so paragraphs and lists keep their shape. Long messages are cut
 * at `max` characters (the rest stays as it is).
 */
export function splitForTranslation(text: string, max = 4000): { lines: string[]; rest: string } {
  const head = text.slice(0, max)
  return { lines: head.split('\n'), rest: text.slice(max) }
}

/** Translates the non-blank lines of `text` with `engine`, keeping blank lines and the untranslated tail. */
export function translateText(engine: Engine, text: string, route: string[]): string {
  const { lines, rest } = splitForTranslation(text)
  const todo = lines.map((line, i) => [i, line.trim()] as const).filter(([, line]) => line)
  const done = engine.translate(todo.map(([, line]) => line), route)
  const out = [...lines]
  todo.forEach(([i], n) => {
    const indent = lines[i].match(/^\s*/)?.[0] ?? ''
    out[i] = indent + done[n]
  })
  return out.join('\n') + rest
}

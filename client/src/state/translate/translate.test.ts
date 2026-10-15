import { describe, expect, it } from 'vitest'
import { detectableText, detectLanguage, detectWith, MIN_LETTERS, pickLanguage } from './detect'
import { Bergamot, splitForTranslation, translateText, type Engine, type PairFiles } from './engine'
import { languageBytes, modelBytes, PINS, route, TRANSLATE_LANGUAGES } from './languages'
import pins from './models.json'
import { createWorkerCore, MAX_TEXT, type WorkerReply } from './workerCore'
import { TranslatorClient, type WorkerPort } from './workerClient'
import { gunzip } from './modelFiles'
import { joinParts } from '../models'

// Node's fs, without pulling Node's types into the app's type check.
const fs = 'node:fs'
const { readFileSync, existsSync } = (await import(/* @vite-ignore */ fs)) as { readFileSync(path: URL): Uint8Array; existsSync(path: URL): boolean }

describe('which language a message is in', () => {
  it('ignores links, mentions, emoji, code and numbers', () => {
    expect(detectableText('kolla https://example.com/x?y=1 @Anna :tada: 123 `npm ci` 🎉 nu')).toBe('kolla nu')
    expect(detectableText('```\nconst a = 1\n``` hej då')).toBe('hej då')
  })

  it('leans toward the reader’s language on a close call, not otherwise', () => {
    expect(pickLanguage({ da: 0.713, sv: 0.709, no: 0.64 }, true, ['sv'])).toEqual({ language: 'sv', reliable: true })
    expect(pickLanguage({ da: 0.713, sv: 0.709 }, true, ['en'])).toEqual({ language: 'da', reliable: true })
    expect(pickLanguage({ de: 0.8, sv: 0.6 }, true, ['sv'])).toEqual({ language: 'de', reliable: true })
    // ELD calls Norwegian "no"; the models call it "nb".
    expect(pickLanguage({ no: 0.83, da: 0.79 }, false, ['en'])).toEqual({ language: 'nb', reliable: false })
    expect(pickLanguage({}, true, ['en'])).toEqual({ language: null, reliable: false })
  })

  it('says it can’t tell for a few letters, and isn’t sure of one word', () => {
    const eld = { detect: () => ({ language: 'sv', getScores: () => ({ sv: 0.8 }), isReliable: () => true }) }
    expect(detectWith(eld, 'lol', ['en']).language).toBeNull()
    expect(detectWith(eld, 'x'.repeat(MIN_LETTERS - 1), ['en']).language).toBeNull()
    expect(detectWith(eld, 'tackar', ['en'])).toEqual({ language: 'sv', reliable: false })
    expect(detectWith(eld, 'tack så mycket', ['en'])).toEqual({ language: 'sv', reliable: true })
  })

  it('tells real chat messages apart with the bundled ELD data', async () => {
    const cases: [string, string][] = [
      ['Hej! Kommer du på spelkvällen ikväll?', 'sv'],
      ['Servern ligger nere igen', 'sv'],
      ['Hey, are you coming tonight?', 'en'],
      ['Ich komme später, fangt ohne mich an', 'de'],
      ['On joue ce soir avec les autres ?', 'fr'],
      ['¿Vamos a jugar esta noche?', 'es'],
      ['Gramy dziś wieczorem?', 'pl'],
    ]
    for (const [text, language] of cases) expect((await detectLanguage(text, ['sv'])).language, text).toBe(language)
    expect((await detectLanguage('gg', ['sv'])).language).toBeNull()
  })
})

describe('the languages and models', () => {
  it('covers English to and from every language, each way pinned', () => {
    expect(TRANSLATE_LANGUAGES[0]).toBe('en')
    for (const l of ['sv', 'de', 'fr', 'es', 'pl']) expect(TRANSLATE_LANGUAGES).toContain(l)
    for (const l of TRANSLATE_LANGUAGES.slice(1)) {
      expect(route('en', l)).toEqual([`en-${l}`])
      expect(route(l, 'en')).toEqual([`${l}-en`])
      expect(languageBytes(l)).toBeGreaterThan(20_000_000)
    }
  })

  it('goes through English between two other languages', () => {
    expect(route('sv', 'de')).toEqual(['sv-en', 'en-de'])
    expect(route('sv', 'sv')).toEqual([])
    expect(route('xx', 'en')).toBeNull()
    expect(route('sv', 'xx')).toBeNull()
    expect(modelBytes(['sv-en', 'en-de'])).toBe(modelBytes(['sv-en']) + modelBytes(['en-de']))
  })

  it('pins every file by SHA-256, gzipped and unpacked, in parts of at most 20 MiB', () => {
    expect(pins.models.length).toBe(PINS.length)
    expect(new Set(PINS.map((p) => p.dir)).size).toBe(PINS.length)
    for (const pin of PINS) {
      expect(pin.source).toMatch(/^https:\/\/storage\.googleapis\.com\/moz-fx-translations-data/)
      expect(pin.files.map((f) => f.name)).toEqual(['model.bin.gz', 'lex.bin.gz', 'vocab.spm.gz'])
      for (const f of pin.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(f.unpacked.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(f.parts.reduce((n, p) => n + p.bytes, 0)).toBe(f.bytes)
        for (const p of f.parts) expect(p.bytes).toBeLessThanOrEqual(20 * 1024 * 1024)
      }
    }
  })
})

describe('translating a message line by line', () => {
  const upper: Engine = { has: () => true, load: () => undefined, translate: (texts) => texts.map((t) => t.toUpperCase()) }

  it('keeps blank lines and indents, and leaves the tail of a very long message as it is', () => {
    expect(translateText(upper, 'hej\n\n  då\n', ['sv-en'])).toBe('HEJ\n\n  DÅ\n')
    const long = 'a'.repeat(4000) + 'tail'
    expect(splitForTranslation(long).rest).toBe('tail')
    expect(translateText(upper, long, ['sv-en']).endsWith('Atail')).toBe(true)
  })
})

describe('the translate worker', () => {
  function fakeEngine() {
    const loaded = new Set<string>()
    const engine: Engine = {
      has: (p) => loaded.has(p),
      load: (p) => void loaded.add(p),
      translate: (texts, routeTaken) => {
        for (const p of routeTaken) if (!loaded.has(p)) throw new Error(`not loaded: ${p}`)
        return texts.map((t) => `[${routeTaken.join('>')}] ${t}`)
      },
    }
    return engine
  }
  const files = (): PairFiles => ({ model: new Uint8Array(1), lex: new Uint8Array(1), vocab: new Uint8Array(1) })

  it('answers every request with its id, in order, and errors as errors', async () => {
    let engines = 0
    const handle = createWorkerCore({
      createEngine: async () => {
        engines++
        return fakeEngine()
      },
      detect: async (text) => ({ language: text.startsWith('hej') ? 'sv' : null, reliable: true }),
    })
    expect(await handle({ id: 1, type: 'detect', text: 'hej hej', prefer: [] })).toEqual({ id: 1, ok: true, result: { language: 'sv', reliable: true } })
    // Nothing to translate with before init.
    expect(await handle({ id: 2, type: 'translate', text: 'hej', route: ['sv-en'] })).toEqual({ id: 2, ok: false, error: 'not started' })
    expect(await handle({ id: 3, type: 'init', wasm: new ArrayBuffer(1) })).toEqual({ id: 3, ok: true, result: true })
    await handle({ id: 4, type: 'init', wasm: new ArrayBuffer(1) })
    expect(engines).toBe(1)
    expect((await handle({ id: 5, type: 'translate', text: 'hej', route: ['sv-en'] })).ok).toBe(false)
    await handle({ id: 6, type: 'load', pair: 'sv-en', files: files() })
    expect(await handle({ id: 7, type: 'has', pairs: ['sv-en', 'en-de'] })).toEqual({ id: 7, ok: true, result: ['sv-en'] })
    expect(await handle({ id: 8, type: 'translate', text: 'hej\n\ndå', route: ['sv-en'] })).toEqual({ id: 8, ok: true, result: '[sv-en] hej\n\n[sv-en] då' })
    expect((await handle({ id: 9, type: 'detect', text: 'x'.repeat(MAX_TEXT + 1), prefer: [] })).ok).toBe(false)
    expect((await handle({ id: 10, type: 'nope' } as never)).ok).toBe(false)
  })

  it('can start again after the engine failed to', async () => {
    let fail = true
    const handle = createWorkerCore({
      createEngine: async () => {
        if (fail) throw new Error('no wasm')
        return fakeEngine()
      },
      detect: async () => ({ language: null, reliable: false }),
    })
    expect(await handle({ id: 1, type: 'init', wasm: new ArrayBuffer(1) })).toEqual({ id: 1, ok: false, error: 'no wasm' })
    fail = false
    expect((await handle({ id: 2, type: 'init', wasm: new ArrayBuffer(1) })).ok).toBe(true)
  })

  it('the page’s side matches replies to requests and fails what’s waiting when the worker dies', async () => {
    const handle = createWorkerCore({ createEngine: async () => fakeEngine(), detect: async () => ({ language: 'de', reliable: true }) })
    const sent: unknown[] = []
    const port: WorkerPort = {
      onmessage: null,
      onerror: null,
      terminate: () => undefined,
      postMessage(message, transfer) {
        sent.push(transfer)
        // Replies arrive out of order: the client still matches them.
        void handle(message as never).then((reply: WorkerReply) => setTimeout(() => port.onmessage?.({ data: reply } as MessageEvent<WorkerReply>), reply.id === 1 ? 20 : 0))
      },
    }
    const client = new TranslatorClient(port)
    const [detected, started] = await Promise.all([client.detect('Guten Tag', []), client.init(new ArrayBuffer(4))])
    expect(detected).toEqual({ language: 'de', reliable: true })
    expect(started).toBe(true)
    const f = files()
    await client.load('de-en', f)
    expect(sent.at(-1)).toEqual([f.model.buffer, f.lex.buffer, f.vocab.buffer])
    expect(await client.translate('Hallo', ['de-en'])).toBe('[de-en] Hallo')
    await expect(client.translate('x', ['en-de'])).rejects.toThrow('not loaded: en-de')

    const stuck = new TranslatorClient({ onmessage: null, onerror: null, terminate: () => undefined, postMessage: () => undefined })
    const waiting = stuck.detect('x', [])
    stuck.terminate()
    await expect(waiting).rejects.toThrow('stopped')
  })
})

// The real models aren't in git: `node scripts/get-models.mjs --translate` puts English and Swedish here.
const MODELS = new URL('../../../.models/models/translate/', import.meta.url)
const pinOf = (name: string) => PINS.find((p) => p.name === name)!
const haveModels = ['en-sv', 'sv-en'].every((name) => existsSync(new URL(`${pinOf(name).dir}/vocab.spm.gz.part0.bin`, MODELS)))

async function modelFiles(name: string): Promise<PairFiles> {
  const pin = pinOf(name)
  const read = async (file: string) => {
    const f = pin.files.find((x) => x.name === file)!
    return gunzip(joinParts(f.parts.map((_, i) => readFileSync(new URL(`${pin.dir}/${file}.part${i}.bin`, MODELS)))))
  }
  return { model: await read('model.bin.gz'), lex: await read('lex.bin.gz'), vocab: await read('vocab.spm.gz') }
}

describe.skipIf(!haveModels)('Bergamot with the real models', () => {
  it('translates Swedish and English both ways, and through English', async () => {
    const wasm = readFileSync(new URL('../../../vendor/bergamot/bergamot-translator.wasm', import.meta.url))
    const engine = await Bergamot.create(wasm.slice().buffer as ArrayBuffer)
    engine.load('sv-en', await modelFiles('sv-en'))
    engine.load('en-sv', await modelFiles('en-sv'))
    const [english] = engine.translate(['Servern ligger nere igen, kan någon starta om den?'], ['sv-en'])
    expect(english.toLowerCase()).toContain('server')
    expect(english.toLowerCase()).toContain('restart')
    const [swedish] = engine.translate(['See you tomorrow!'], ['en-sv'])
    expect(swedish.toLowerCase()).toMatch(/i ?morgon/)
    // Pivoting through English with the same two models: Swedish back to Swedish.
    expect(engine.translate(['Hej, hur mår du?'], ['sv-en', 'en-sv'])[0].toLowerCase()).toContain('hur')
    expect(() => engine.translate(['x'], ['de-en'])).toThrow('not loaded')
  }, 60_000)
})

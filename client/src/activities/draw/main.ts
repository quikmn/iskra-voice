// Draw & guess: a shared canvas the drawer paints on (sent in small pieces), the word's shape and a guess box for
// everyone else, a timer, and scores. The drawer's app holds the word and ends the round.
import { fill, fmt, h, run, type Ctx } from '../kit'
import {
  COLORS, drawerOf, hashOf, HEIGHT, initialDraw, isRight, maskOf, MAX_GUESS, MAX_POINTS, MAX_STROKE_POINTS, parseDraw, reduceDraw,
  ROUND_SECONDS, SIZES, WIDTH, type DrawState, type Stroke,
} from './logic'
import { WORDS, threeWords } from './words'

const COLOR_NAMES = ['black', 'red', 'orange', 'green', 'blue', 'purple', 'pink', 'eraser'] as const

const CSS = `
#app { gap: 6px; padding: 8px; height: 100%; }
.status { margin: 0; }
.top { display: flex; gap: 8px; align-items: center; justify-content: space-between; width: 100%; flex-wrap: wrap; }
/* Tools on the left, the board in the middle, guesses and scores on the right: the board takes the height that's left,
   so nothing sits under it and the frame never scrolls. */
.layout { flex: 1; min-height: 0; display: grid; grid-template-columns: auto minmax(0, 1fr) min(220px, 28vw); grid-template-rows: minmax(0, 1fr); gap: 12px; width: 100%; }
.main { display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 0; }
.board { flex: 1; min-height: 160px; container-type: size; display: grid; place-items: start center; }
canvas { width: min(100cqw, calc(100cqh * 4 / 3)); aspect-ratio: 4 / 3; background: #fff; border-radius: 12px; touch-action: none; display: block; }
canvas.mine { cursor: crosshair; }
.mask { margin: 0; font: 600 1.4rem/1.2 ui-monospace, monospace; letter-spacing: .35em; text-align: center; overflow-wrap: anywhere; }
.tools { display: grid; grid-template-columns: repeat(3, 36px); gap: 6px; align-content: start; overflow: auto; padding: 4px; }
.tools > :not(.swatch, .size) { grid-column: 1 / -1; padding: 6px 4px; min-height: 36px; }
.size { min-height: 36px; padding: 0; } .swatch + .size { grid-column-start: 1; }
.swatch { width: 36px; height: 36px; min-height: 36px; padding: 0; border-radius: 50%; border: 2px solid var(--border); }
.swatch[aria-pressed="true"], .size[aria-pressed="true"] { outline: 3px solid var(--accent); outline-offset: 2px; }
.side { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow: auto; }
.timer { margin: 0; font-variant-numeric: tabular-nums; }
.guesses { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; max-height: 220px; overflow: auto; }
.guesses li { overflow-wrap: anywhere; }
.guesses .ok { color: var(--green); font-weight: 600; }
.words { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.words button { font-size: 1.1rem; min-width: 120px; }
.guess { display: flex; gap: 6px; } .guess input { flex: 1; min-width: 0; }
/* Taller than wide (a phone): one column that scrolls, the tools in a row under the board. */
@media (max-width: 480px), (max-aspect-ratio: 1/1) {
  #app { height: auto; }
  .layout { grid-template-columns: 1fr; grid-template-rows: none; }
  .tools { order: 1; display: flex; flex-wrap: wrap; align-items: center; overflow: visible; }
  .tools > :not(.swatch, .size) { padding: 8px 14px; }
  .size { min-width: 44px; } .swatch + .size { grid-column-start: auto; }
  .side { order: 2; overflow: visible; }
  .board { flex: none; container-type: normal; }
  canvas { width: 100%; min-width: 240px; }
}
`

interface Local {
  /** The word, on the drawer's device only, while they draw it. */
  word: string | null
  choices: string[]
  /** When this round's drawing started here (for the timer). */
  startedAt: number
  round: number
  ended: boolean
  nexted: number
  /** Stroke pieces sent but not back from the server yet. */
  sent: Stroke[]
  color: number
  size: number
  group: number
  got: boolean
}

function mount(ctx: Ctx<DrawState>) {
  const s = ctx.strings.draw
  const local: Local = { word: null, choices: [], startedAt: 0, round: 0, ended: false, nexted: 0, sent: [], color: 0, size: 1, group: 0, got: false }
  const top = h('div', { className: 'top' })
  const status = h('p', { className: 'status', role: 'status', 'aria-live': 'polite' })
  const canvas = h('canvas', { width: WIDTH, height: HEIGHT, role: 'img' })
  const g = canvas.getContext('2d')!
  const mainCol = h('div', { className: 'main' })
  const side = h('div', { className: 'side' })
  const layout = h('div', { className: 'layout' })
  fill(ctx.root, h('h1', { className: 'sr-only' }, s.title), top, status, layout)
  const present = (id: string | null) => !!id && ctx.players().some((p) => p.id === id)

  // ── Drawing ──────────────────────────────────────────────────────────────
  let current: number[] = []
  let drawing = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function paint(stroke: Stroke) {
    const p = stroke.p
    g.strokeStyle = COLORS[stroke.c]
    g.lineWidth = SIZES[stroke.w]
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.beginPath()
    g.moveTo(p[0], p[1])
    if (p.length === 2) g.lineTo(p[0] + 0.1, p[1])
    for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1])
    g.stroke()
  }

  function redraw() {
    const state = ctx.state()
    g.clearRect(0, 0, WIDTH, HEIGHT)
    // What came back from the server, then what we sent since, then the piece being drawn.
    const confirmed = new Set(state.strokes.map((st) => `${st.g}:${st.p.slice(0, 4).join(',')}:${st.p.length}`))
    local.sent = local.sent.filter((st) => !confirmed.has(`${st.g}:${st.p.slice(0, 4).join(',')}:${st.p.length}`))
    for (const stroke of state.strokes) paint(stroke)
    for (const stroke of local.sent) paint(stroke)
    if (current.length) paint({ g: local.group, c: local.color, w: local.size, p: current })
  }

  function flush() {
    flushTimer = null
    if (current.length < 2) return
    const stroke: Stroke = { g: local.group, c: local.color, w: local.size, p: current }
    const state = ctx.state()
    if (state.points + local.sent.reduce((n, st) => n + st.p.length / 2, 0) + current.length / 2 > MAX_POINTS) {
      status.textContent = s.inkLow
      current = []
      drawing = false
      redraw()
      return
    }
    local.sent.push(stroke)
    ctx.send({ t: 's', ...stroke })
    // The next piece starts where this one ended, so the line stays joined.
    current = drawing ? current.slice(-2) : []
  }

  function pointAt(e: PointerEvent): [number, number] {
    const box = canvas.getBoundingClientRect()
    const x = Math.round(((e.clientX - box.left) / box.width) * WIDTH)
    const y = Math.round(((e.clientY - box.top) / box.height) * HEIGHT)
    return [Math.min(WIDTH, Math.max(0, x)), Math.min(HEIGHT, Math.max(0, y))]
  }

  const canDraw = () => {
    const state = ctx.state()
    return state.phase === 'drawing' && drawerOf(state) === ctx.me.id
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!canDraw()) return
    canvas.setPointerCapture(e.pointerId)
    drawing = true
    local.group++
    current = pointAt(e)
    redraw()
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return
    const [x, y] = pointAt(e)
    const lx = current[current.length - 2]
    const ly = current[current.length - 1]
    if (Math.hypot(x - lx, y - ly) < 5) return
    current.push(x, y)
    redraw()
    if (current.length >= MAX_STROKE_POINTS * 2) flush()
    // Batched: about 6 pieces a second, well under what an activity may send.
    else if (!flushTimer) flushTimer = setTimeout(flush, 160)
  })
  const stop = () => {
    if (!drawing) return
    drawing = false
    if (flushTimer) clearTimeout(flushTimer)
    flush()
  }
  canvas.addEventListener('pointerup', stop)
  canvas.addEventListener('pointercancel', stop)

  // ── The round ────────────────────────────────────────────────────────────

  function pick(word: string) {
    const salt = Math.random().toString(36).slice(2, 10).padEnd(4, '0')
    local.word = word
    ctx.send({ t: 'pick', mask: maskOf(word), hash: hashOf(salt, word), salt })
  }

  function endRound() {
    if (local.ended) return
    local.ended = true
    ctx.send({ t: 'end', word: local.word })
    local.word = null
  }

  // Sandboxed frames can't submit forms (no allow-forms): Enter and the button send the guess.
  function guess() {
    const text = guessInput.value.trim().slice(0, MAX_GUESS)
    guessInput.value = ''
    if (!text) return
    const state = ctx.state()
    if (isRight(state, text)) {
      local.got = true
      ctx.send({ t: 'got' })
    } else ctx.send({ t: 'g', text })
  }

  // The parts that stay put (a canvas mid-stroke or a guess being typed must not be rebuilt); update() fills the rest.
  const words = h('div', { className: 'words' })
  const mask = h('p', { className: 'mask' })
  const swatches = COLORS.map((color, i) => h('button', {
    className: 'swatch', style: `background:${color}`, 'aria-label': s.colors[COLOR_NAMES[i]],
    onclick: () => { local.color = i; update(ctx.state()) },
  }))
  const sizes = SIZES.map((_, i) => h('button', {
    className: 'size', 'aria-label': [s.small, s.medium, s.large][i],
    onclick: () => { local.size = i; update(ctx.state()) },
  }, ['S', 'M', 'L'][i]))
  const tools = h('div', { className: 'tools', role: 'toolbar', 'aria-label': s.tools }, ...swatches, ...sizes,
    h('button', { onclick: () => ctx.send({ t: 'undo' }) }, s.undo),
    h('button', { onclick: () => ctx.send({ t: 'clear' }) }, s.clear))
  const timer = h('p', { className: 'muted timer' })
  const actions = h('div', { className: 'row' })
  fill(mainCol, words, mask, h('div', { className: 'board' }, canvas))
  const guessInput = h('input', { maxlength: MAX_GUESS, 'aria-label': s.guessHere, placeholder: s.guessHere, autocomplete: 'off',
    onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') guess() } })
  const guessForm = h('div', { className: 'guess' }, guessInput, h('button', { className: 'primary', onclick: () => guess() }, s.guess))
  const guessList = h('ul', { className: 'guesses', 'aria-live': 'polite' })
  const guessBox = h('div', {}, h('h2', {}, s.guesses), guessList)
  const playerList = h('ul', { className: 'scores' })
  fill(layout, tools, mainCol, side)
  fill(side, timer, actions, guessForm, guessBox, h('div', {}, h('h2', {}, s.players), playerList))
  const show = (el: HTMLElement, on: boolean) => (el.hidden = !on)

  function update(state: DrawState) {
    const drawer = drawerOf(state)
    const iDraw = drawer === ctx.me.id
    const inGame = state.roster.includes(ctx.me.id)
    const playing = state.phase === 'picking' || state.phase === 'drawing' || state.phase === 'between'

    // A new round: reset what this device keeps about it.
    if (state.round !== local.round) {
      local.round = state.round
      local.ended = false
      local.got = false
      local.sent = []
      local.choices = []
      local.nexted = 0
    }
    if (state.phase === 'picking' && iDraw && !local.choices.length) {
      local.choices = threeWords(WORDS[ctx.locale === 'sv' ? 'sv' : 'en'])
      local.ended = false
    }
    if (state.phase === 'drawing' && !local.startedAt) local.startedAt = Date.now()
    if (state.phase !== 'drawing') local.startedAt = 0
    // The drawer's app lost the word (it reloaded): end the round rather than leave everyone waiting.
    if (iDraw && state.phase === 'drawing' && !local.word && !local.ended) endRound()
    // Everyone else got it: the round's done.
    const guessers = state.roster.filter((id) => id !== drawer)
    if (iDraw && state.phase === 'drawing' && guessers.length && guessers.every((id) => state.guessed.includes(id))) endRound()
    // The drawer's app moves on after a short pause.
    if (state.phase === 'between' && iDraw && local.nexted !== state.round) {
      local.nexted = state.round
      const round = state.round
      setTimeout(() => {
        const now = ctx.state()
        if (now.phase === 'between' && now.round === round) ctx.send({ t: 'next' })
      }, 4000)
    }

    fill(top,
      h('span', { className: 'muted' }, state.rounds ? fmt(s.round, { n: state.round, total: state.rounds }) : s.lobby),
      h('span', { className: 'row' },
        !inGame ? h('button', { className: 'primary', onclick: () => ctx.send({ t: 'join' }) }, s.join) : null,
        inGame ? h('button', { onclick: () => ctx.send({ t: 'leave' }) }, s.leave) : null,
        inGame && !playing && state.roster.length >= 2 ? h('button', { className: 'primary', onclick: () => ctx.send({ t: 'start' }) }, state.phase === 'over' ? s.again : s.start) : null))

    const winners = Object.entries(state.scores).sort((a, b) => b[1] - a[1])
    status.textContent = state.phase === 'lobby' ? (state.roster.length < 2 ? s.needTwo : s.ready)
      : state.phase === 'picking' ? (iDraw ? s.choose : fmt(s.choosing, { name: ctx.nameOf(drawer) }))
      : state.phase === 'drawing' ? (iDraw ? fmt(s.youDraw, { word: local.word ?? '' }) : local.got || state.guessed.includes(ctx.me.id) ? s.gotIt : fmt(s.drawing, { name: ctx.nameOf(drawer) }))
      : state.phase === 'between' ? (state.word ? fmt(s.theWord, { word: state.word }) : s.roundOver)
      : winners.length && winners[0][1] > 0 ? (winners[1]?.[1] === winners[0][1] ? s.tie : fmt(s.winner, { name: ctx.nameOf(winners[0][0]) })) : s.over

    canvas.className = iDraw && state.phase === 'drawing' ? 'mine' : ''
    canvas.setAttribute('aria-label', fmt(s.canvas, { name: ctx.nameOf(drawer) }))

    show(words, state.phase === 'picking' && iDraw)
    if (state.phase === 'picking' && iDraw && words.childElementCount !== local.choices.length)
      fill(words, ...local.choices.map((word) => h('button', { className: 'primary', onclick: () => pick(word) }, word)))
    show(mask, state.phase === 'drawing' && !iDraw)
    mask.textContent = state.mask
    mask.setAttribute('aria-label', fmt(s.letters, { count: state.mask.replace(/[\s-]/g, '').length }))
    show(tools, state.phase === 'drawing' && iDraw)
    swatches.forEach((b, i) => b.setAttribute('aria-pressed', String(local.color === i)))
    sizes.forEach((b, i) => b.setAttribute('aria-pressed', String(local.size === i)))
    show(timer, state.phase === 'drawing' && !!local.startedAt)
    if (local.startedAt) timer.textContent = fmt(s.timeLeft, { seconds: Math.max(0, ROUND_SECONDS - Math.floor((Date.now() - local.startedAt) / 1000)) })
    fill(actions,
      (state.phase === 'drawing' || state.phase === 'picking') && drawer && !present(drawer) && inGame ? h('button', { onclick: () => ctx.send({ t: 'skip' }) }, s.skip) : null,
      state.phase === 'between' && inGame && !iDraw ? h('button', { onclick: () => ctx.send({ t: 'next' }) }, s.next) : null)

    const canGuess = state.phase === 'drawing' && inGame && !iDraw && !state.guessed.includes(ctx.me.id) && !local.got
    show(guessForm, canGuess)
    show(guessBox, state.phase === 'drawing' || state.phase === 'between')
    fill(guessList,
      ...state.guessed.map((id) => h('li', { className: 'ok' }, fmt(s.gotItOther, { name: ctx.nameOf(id) }))),
      ...state.guesses.map((x) => h('li', {}, h('strong', {}, ctx.nameOf(x.from)), ': ', x.text)))
    fill(playerList, ...state.roster.map((id) => h('li', { className: id === ctx.me.id ? 'me' : '' },
      h('span', {}, ctx.nameOf(id), id === drawer && playing ? ` (${s.drawer})` : ''), h('strong', {}, String(state.scores[id] ?? 0)))))
    redraw()
  }

  // The drawer's app ends the round when time's up; everyone's timer ticks.
  setInterval(() => {
    const state = ctx.state()
    if (state.phase !== 'drawing' || !local.startedAt) return
    const elapsed = (Date.now() - local.startedAt) / 1000
    if (drawerOf(state) === ctx.me.id && elapsed >= ROUND_SECONDS) endRound()
    timer.textContent = fmt(s.timeLeft, { seconds: Math.max(0, ROUND_SECONDS - Math.floor(elapsed)) })
  }, 500)

  return { update }
}

void run({ initial: initialDraw, parse: parseDraw, reduce: reduceDraw, mount }, CSS)

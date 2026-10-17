// Quiz: the quizmaster's screen picks or writes questions and runs the round; everyone else answers with big buttons.
import { fill, fmt, h, run, type Ctx } from '../kit'
import { initialQuiz, MAX_OPTION, MAX_QUESTION, MAX_QUESTIONS, parseQuiz, ranking, reduceQuiz, shuffled, shuffleOptions, type QuizState } from './logic'
import { QUESTIONS, type BankQuestion } from './questions'

const SECONDS = 20
const LETTERS = ['A', 'B', 'C', 'D']

const CSS = `
#app { gap: 8px; padding: 8px; }
.status { margin: 0; }
.options { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; }
@media (max-width: 420px) { .options { grid-template-columns: 1fr; } }
.option { text-align: left; min-height: 56px; display: flex; gap: 10px; align-items: center; }
.option .letter { font-weight: 700; color: var(--accent); }
.option.picked { outline: 2px solid var(--accent); }
.option.right { background: color-mix(in srgb, var(--green) 30%, var(--surface2)); }
.option.wrong { opacity: .6; }
.question { font-size: 1.2rem; font-weight: 600; margin: 4px 0 8px; overflow-wrap: anywhere; }
.form { display: grid; gap: 8px; }
.form label { display: grid; gap: 4px; }
.form .answer { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: center; }
.list { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
.list li { overflow-wrap: anywhere; }
.list button { min-height: 32px; padding: 2px 10px; margin-left: 8px; }
.timer { font-variant-numeric: tabular-nums; }
`

interface Local {
  /** The quizmaster's questions with their answers (only on the quizmaster's device). */
  queue: BankQuestion[]
  answers: Record<number, number>
  own: BankQuestion[]
  count: number
  revealed: Set<number>
  /** When each question arrived here (for the countdown). */
  askedAt: Record<number, number>
}

function mount(ctx: Ctx<QuizState>) {
  const s = ctx.strings.trivia
  const local: Local = { queue: [], answers: {}, own: [], count: 5, revealed: new Set(), askedAt: {} }
  const head = h('div', { className: 'row' })
  const status = h('p', { className: 'status', role: 'status', 'aria-live': 'polite' })
  const body = h('div', { className: 'panel' })
  const scores = h('div', { className: 'panel' })
  fill(ctx.root, h('h1', { className: 'sr-only' }, s.title), head, status, body, scores)
  const present = (id: string | null) => !!id && ctx.players().some((p) => p.id === id)
  let timer: ReturnType<typeof setInterval> | null = null

  function ask(n: number) {
    const q = local.queue[n - 1]
    if (!q) return
    const shuffledQ = shuffleOptions(q)
    local.answers[n] = shuffledQ.correct
    ctx.send({ t: 'q', n, total: local.queue.length, text: shuffledQ.text, options: shuffledQ.options })
  }

  function startWith(questions: BankQuestion[]) {
    local.queue = questions.slice(0, MAX_QUESTIONS)
    local.answers = {}
    local.revealed = new Set()
    if (ctx.state().phase === 'over') ctx.send({ t: 'reset' })
    ask(1)
  }

  function reveal(state: QuizState) {
    if (local.revealed.has(state.n) || local.answers[state.n] === undefined) return
    local.revealed.add(state.n)
    ctx.send({ t: 'reveal', n: state.n, correct: local.answers[state.n] })
  }

  // The quizmaster's lobby stays put (questions being typed must survive other players' messages).
  const waitText = h('p', { className: 'muted' })
  const ownList = h('ol', { className: 'list' })
  const ownStart = h('div', { className: 'row' })
  // Sandboxed frames can't submit forms (no allow-forms): the button and Enter add the question.
  const qInput = h('input', { maxlength: MAX_QUESTION, onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') addOwn() } })
  const optionInputs = [0, 1, 2, 3].map((i) => h('input', {
    maxlength: MAX_OPTION, 'aria-label': fmt(s.optionLabel, { n: i + 1 }), placeholder: fmt(s.optionLabel, { n: i + 1 }),
    onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') addOwn() },
  }))
  const radios = [0, 1, 2, 3].map((i) => h('input', { type: 'radio', name: 'correct', value: i, checked: i === 0, 'aria-label': fmt(s.markRight, { n: i + 1 }) }))
  const ownError = h('p', { className: 'error', role: 'alert' })
  function addOwn() {
    const text = qInput.value.trim()
    const options = optionInputs.map((input) => input.value.trim())
    const correct = Math.max(0, radios.findIndex((r) => r.checked))
    const kept = options.map((o, i) => ({ o, i })).filter((x) => x.o)
    if (!text || kept.length < 2 || !options[correct]) {
      ownError.textContent = s.needTwo
      return
    }
    ownError.textContent = ''
    local.own.push({ text, options: kept.map((x) => x.o), correct: kept.findIndex((x) => x.i === correct) })
    qInput.value = ''
    optionInputs.forEach((input) => (input.value = ''))
    radios.forEach((r, i) => (r.checked = i === 0))
    qInput.focus()
    update(ctx.state())
  }
  const ownForm = h('div', { className: 'form' },
    h('label', {}, s.questionLabel, qInput),
    ...[0, 1, 2, 3].map((i) => h('div', { className: 'answer' }, radios[i], optionInputs[i])),
    h('p', { className: 'muted' }, s.markHint),
    ownError,
    h('div', { className: 'row' }, h('button', { onclick: addOwn }, s.add)))
  const select = h('select', { 'aria-label': s.count, onchange: (e: Event) => (local.count = Number((e.target as HTMLSelectElement).value)) },
    ...[5, 10].map((n) => h('option', { value: n, selected: n === local.count }, String(n))))
  const masterLobby = h('div', {},
    h('h2', {}, s.quick), h('p', { className: 'muted' }, s.quickHint),
    h('div', { className: 'row' }, h('label', {}, s.count, ' ', select),
      h('button', { className: 'primary', onclick: () => startWith(shuffled(QUESTIONS[ctx.locale === 'sv' ? 'sv' : 'en']).slice(0, local.count)) }, s.startQuick)),
    h('h2', {}, s.own), ownForm, ownList, ownStart)
  const lobbyBox = h('div', {}, waitText, masterLobby)
  const playBox = h('div', {})
  const endBox = h('div', { className: 'row' })
  fill(body, lobbyBox, playBox, endBox)

  function lobby(state: QuizState, isMaster: boolean) {
    waitText.hidden = isMaster
    masterLobby.hidden = !isMaster
    waitText.textContent = state.master ? s.waitStart : s.noMaster
    fill(ownList, ...local.own.map((q, i) => h('li', {}, q.text,
      h('button', { 'aria-label': fmt(s.removeQuestion, { n: i + 1 }), onclick: () => { local.own.splice(i, 1); update(ctx.state()) } }, s.remove))))
    fill(ownStart, local.own.length ? h('button', { className: 'primary', onclick: () => startWith(local.own) }, fmt(s.startOwn, { count: local.own.length })) : null)
  }

  function questionView(state: QuizState, isMaster: boolean) {
    const q = state.question!
    const mine = state.answers[ctx.me.id]
    const revealing = state.phase === 'reveal' || state.phase === 'over'
    const others = ctx.players().filter((p) => p.id !== state.master).length
    const left = Math.max(0, SECONDS - Math.floor((Date.now() - (local.askedAt[state.n] ?? Date.now())) / 1000))
    const options = h('div', { className: 'options' }, ...q.options.map((text, i) => h('button', {
      className: `option ${mine === i ? 'picked' : ''} ${revealing ? (state.correct === i ? 'right' : 'wrong') : ''}`,
      disabled: isMaster || revealing || mine !== undefined,
      'aria-pressed': mine === i ? 'true' : null,
      onclick: () => ctx.send({ t: 'a', n: state.n, choice: i }),
    }, h('span', { className: 'letter', 'aria-hidden': 'true' }, LETTERS[i]), text)))
    const after = revealing
      ? isMaster ? null : h('p', { className: 'status' }, mine === undefined ? s.noAnswer : state.gained[ctx.me.id] ? fmt(s.right, { points: state.gained[ctx.me.id] }) : s.wrong)
      : isMaster ? h('p', { className: 'muted' }, fmt(s.answered, { count: state.order.length, total: others }))
      : mine !== undefined ? h('p', { className: 'muted' }, s.locked) : null
    const master = isMaster && state.phase !== 'over'
      ? h('div', { className: 'row' },
        state.phase === 'question' ? h('button', { className: 'primary', onclick: () => reveal(state) }, s.revealNow) : null,
        state.phase === 'reveal' && state.n < state.total && local.queue.length ? h('button', { className: 'primary', onclick: () => ask(state.n + 1) }, s.next) : null,
        state.phase === 'reveal' && (state.n >= state.total || !local.queue.length) ? h('button', { className: 'primary', onclick: () => ctx.send({ t: 'over' }) }, s.finish) : null)
      : null
    return [
      h('p', { className: 'muted' }, fmt(s.progress, { n: state.n, total: state.total }),
        state.phase === 'question' ? h('span', { className: 'timer' }, ' · ', fmt(s.timeLeft, { seconds: left })) : null),
      h('p', { className: 'question' }, q.text),
      options,
      after,
      master,
    ]
  }

  function update(state: QuizState) {
    const isMaster = state.master === ctx.me.id
    if (state.phase === 'question' && local.askedAt[state.n] === undefined) local.askedAt[state.n] = Date.now()

    fill(head,
      h('span', { className: 'muted' }, isMaster ? s.youMaster : state.master ? fmt(s.master, { name: ctx.nameOf(state.master) }) : s.noMaster),
      !state.master ? h('button', { className: 'primary', onclick: () => ctx.send({ t: 'host' }) }, s.beMaster) : null,
      state.master && !isMaster && !present(state.master) ? h('button', { onclick: () => ctx.send({ t: 'takeover' }) }, s.takeOver) : null,
      isMaster && (state.phase === 'lobby' || state.phase === 'over') ? h('button', { onclick: () => ctx.send({ t: 'resign' }) }, s.stepDown) : null)

    const winners = ranking(state.scores)
    status.textContent = state.phase === 'over'
      ? winners.length && winners[0].score > 0
        ? winners.length > 1 && winners[1].score === winners[0].score ? s.tie : fmt(s.winner, { name: ctx.nameOf(winners[0].id) })
        : s.over
      : state.phase === 'reveal' ? fmt(s.theAnswer, { answer: state.question?.options[state.correct ?? 0] ?? '' })
      : ''

    lobbyBox.hidden = state.phase !== 'lobby'
    playBox.hidden = state.phase === 'lobby'
    if (state.phase === 'lobby') lobby(state, isMaster)
    else fill(playBox, ...questionView(state, isMaster))
    fill(endBox, state.phase === 'over' && isMaster ? h('button', { className: 'primary', onclick: () => ctx.send({ t: 'reset' }) }, s.newQuiz) : null)

    fill(scores, h('h2', {}, s.scores), winners.length
      ? h('ul', { className: 'scores' }, ...winners.map((w) => h('li', { className: w.id === ctx.me.id ? 'me' : '' }, h('span', {}, ctx.nameOf(w.id)), h('strong', {}, String(w.score)))))
      : h('p', { className: 'muted' }, s.noScores))

    // The quizmaster's app reveals once everyone answered, or when time is up.
    if (isMaster && state.phase === 'question') {
      const others = ctx.players().filter((p) => p.id !== state.master)
      if (others.length > 0 && others.every((p) => p.id in state.answers)) reveal(state)
    }
    if (state.phase === 'question' && !timer) {
      timer = setInterval(() => {
        const now = ctx.state()
        if (now.phase !== 'question') {
          if (timer) clearInterval(timer)
          timer = null
          return
        }
        const elapsed = (Date.now() - (local.askedAt[now.n] ?? Date.now())) / 1000
        if (now.master === ctx.me.id && elapsed >= SECONDS) reveal(now)
        const t = ctx.root.querySelector('.timer')
        if (t) t.textContent = ` · ${fmt(s.timeLeft, { seconds: Math.max(0, SECONDS - Math.floor(elapsed)) })}`
      }, 500)
    }
  }

  return { update }
}

void run({ initial: initialQuiz, parse: parseQuiz, reduce: reduceQuiz, mount }, CSS)

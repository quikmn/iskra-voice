// Four in a row: the board is seven column buttons (tap or Enter drops a disc), with seats and a spoken status.
import { fill, fmt, h, run, type Ctx } from '../kit'
import { COLS, initialFour, landingRow, parseFour, reduceFour, ROWS, seatOf, type FourState } from './logic'

const CSS = `
#app { gap: 8px; padding: 8px; }
h1 { font-size: 1rem; }
.seats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; max-width: 460px; }
.seat { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; padding: 6px 10px; border-radius: 10px; background: var(--surface); border: 2px solid transparent; min-width: 0; }
.seat.turn { border-color: var(--accent); }
.seat strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.seat button { min-height: 32px; padding: 4px 10px; }
.disc { display: inline-block; width: 14px; height: 14px; border-radius: 50%; vertical-align: -2px; margin-right: 6px; }
.disc.p1 { background: #ef4444; } .disc.p2 { background: #facc15; }
.status { margin: 0; }
/* As big as fits: the frame can be short (a call) or narrow (a phone). */
.board { display: grid; grid-template-columns: repeat(${COLS}, 1fr); gap: 4px; padding: 6px; border-radius: 14px; background: #1d4ed8;
  width: min(100%, 460px, calc((100vh - 150px) * ${COLS} / ${ROWS})); min-width: 210px; }
.col { display: grid; grid-template-rows: repeat(${ROWS}, 1fr); gap: 4px; padding: 0; background: transparent; border: 0; border-radius: 8px; min-height: 0; }
.col:hover:not(:disabled) { background: rgba(255,255,255,.12); filter: none; }
.col:disabled { opacity: 1; }
.cell { aspect-ratio: 1; border-radius: 50%; background: var(--bg); }
.cell.p1 { background: #ef4444; } .cell.p2 { background: #facc15; }
.cell.win { box-shadow: 0 0 0 3px #fff inset; }
.cell.last { outline: 2px dashed rgba(255,255,255,.7); outline-offset: -5px; }
`

function mount(ctx: Ctx<FourState>) {
  const s = ctx.strings.four
  const color = (seat: 0 | 1) => (seat === 0 ? s.red : s.yellow)
  const status = h('p', { className: 'status', role: 'status', 'aria-live': 'polite' })
  const seats = h('div', { className: 'seats' })
  const board = h('div', { className: 'board', role: 'group', 'aria-label': s.board })
  const actions = h('div', { className: 'row' })
  fill(ctx.root, h('h1', { className: 'sr-only' }, s.title), seats, status, board, actions)

  const present = (id: string | null) => !!id && ctx.players().some((p) => p.id === id)

  function update(state: FourState) {
    const mine = seatOf(state, ctx.me.id)
    const ready = !state.seats.includes(null)
    const winner = state.result === 1 || state.result === 2 ? state.seats[state.result - 1] : null

    fill(seats, ...([0, 1] as const).map((seat) => {
      const id = state.seats[seat]
      const turn = ready && state.result === 0 && state.turn === seat
      return h('div', { className: `seat ${turn ? 'turn' : ''}`, 'data-testid': `four-seat-${seat}` },
        h('span', {}, h('span', { className: `disc p${seat + 1}`, 'aria-hidden': 'true' }), color(seat)),
        id ? h('strong', {}, ctx.nameOf(id), id === ctx.me.id ? ` (${s.you})` : '') : h('span', { className: 'muted' }, s.empty),
        !id && mine === null ? h('button', { className: 'primary', onclick: () => ctx.send({ t: 'sit', seat }) }, fmt(s.sit, { color: color(seat) })) : null,
        id && id === ctx.me.id ? h('button', { onclick: () => ctx.send({ t: 'stand' }) }, s.stand) : null,
        id && id !== ctx.me.id && !present(id) ? h('button', { onclick: () => ctx.send({ t: 'free', seat }) }, s.free) : null,
      )
    }))

    status.textContent = state.result === 3 ? s.draw
      : winner ? (winner === ctx.me.id ? s.youWon : fmt(s.won, { name: ctx.nameOf(winner) }))
      : !ready ? s.waiting
      : state.turn === mine ? fmt(s.yourTurn, { color: color(state.turn) })
      : fmt(s.theirTurn, { name: ctx.nameOf(state.seats[state.turn]), color: color(state.turn) })

    const myTurn = ready && state.result === 0 && mine === state.turn
    const focused = board.contains(document.activeElement) ? [...board.children].indexOf(document.activeElement as Element) : -1
    fill(board, ...Array.from({ length: COLS }, (_, col) => {
      const full = landingRow(state.board, col) < 0
      const button = h('button', {
        className: 'col', 'data-col': col, 'aria-label': full ? fmt(s.full, { n: col + 1 }) : fmt(s.drop, { n: col + 1 }),
        disabled: !myTurn || full, onclick: () => ctx.send({ t: 'drop', col }),
      }, ...Array.from({ length: ROWS }, (_, row) => {
        const cell = row * COLS + col
        const v = state.board[cell]
        return h('span', { className: `cell ${v ? `p${v}` : ''} ${state.line.includes(cell) ? 'win' : ''} ${state.last === cell ? 'last' : ''}`, 'aria-hidden': 'true' })
      }))
      return button
    }))
    if (focused >= 0) (board.children[focused] as HTMLElement | undefined)?.focus()

    fill(actions, mine !== null && state.result !== 0 ? h('button', { className: 'primary', onclick: () => ctx.send({ t: 'again' }) }, s.again) : null)
  }

  return { update }
}

void run({ initial: initialFour, parse: parseFour, reduce: reduceFour, mount }, CSS)

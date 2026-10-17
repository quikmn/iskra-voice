// Four in a row: two seats, a 7×6 board, discs drop to the lowest free row. Anyone else watches.
// Messages: sit, stand, free (someone left), drop, again. Pure: every player applies the same ones in the same order.
import { isId, isInt, isObject } from '../util'

export const COLS = 7
export const ROWS = 6

export interface FourState {
  /** Player ids in the red (0) and yellow (1) seats. */
  seats: [string | null, string | null]
  /** Row by row from the top: 0 empty, 1 red, 2 yellow. */
  board: number[]
  /** Whose turn: seat 0 or 1. */
  turn: 0 | 1
  /** Who starts the next game (it alternates). */
  starts: 0 | 1
  /** 1 or 2: that seat won; 3: a draw; 0: playing. */
  result: 0 | 1 | 2 | 3
  /** The winning cells. */
  line: number[]
  moves: number
  /** The last move's cell, for screen readers and the highlight. */
  last: number | null
}

export const initialFour = (): FourState => ({ seats: [null, null], board: Array(COLS * ROWS).fill(0), turn: 0, starts: 0, result: 0, line: [], moves: 0, last: null })

/** The row a disc dropped in this column lands in, or -1 when the column is full. */
export function landingRow(board: number[], col: number): number {
  for (let row = ROWS - 1; row >= 0; row--) if (board[row * COLS + col] === 0) return row
  return -1
}

/** The four (or more) cells in a row through `cell`, or [] when that move didn't win. */
export function winningLine(board: number[], cell: number): number[] {
  const who = board[cell]
  if (!who) return []
  const row = Math.floor(cell / COLS)
  const col = cell % COLS
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line = [cell]
    for (const sign of [1, -1]) {
      let r = row + dr * sign
      let c = col + dc * sign
      while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r * COLS + c] === who) {
        line.push(r * COLS + c)
        r += dr * sign
        c += dc * sign
      }
    }
    if (line.length >= 4) return line.sort((a, b) => a - b)
  }
  return []
}

export const seatOf = (state: FourState, id: string): 0 | 1 | null => (state.seats[0] === id ? 0 : state.seats[1] === id ? 1 : null)

export function reduceFour(state: FourState, data: unknown, from: string): FourState {
  if (!isObject(data)) return state
  switch (data.t) {
    case 'sit': {
      if (!isInt(data.seat, 0, 1) || state.seats[data.seat] !== null || seatOf(state, from) !== null) return state
      const seats: FourState['seats'] = [...state.seats]
      seats[data.seat] = from
      return { ...state, seats }
    }
    case 'stand':
    case 'free': {
      // stand: your own seat. free: a seat whose player left (the app only offers it then).
      const seat = data.t === 'stand' ? seatOf(state, from) : isInt(data.seat, 0, 1) ? data.seat : null
      if (seat === null || state.seats[seat] === null) return state
      const seats: FourState['seats'] = [...state.seats]
      seats[seat] = null
      return { ...state, seats }
    }
    case 'drop': {
      const seat = seatOf(state, from)
      if (!isInt(data.col, 0, COLS - 1) || seat === null || seat !== state.turn || state.result !== 0 || state.seats.includes(null)) return state
      const row = landingRow(state.board, data.col)
      if (row < 0) return state
      const cell = row * COLS + data.col
      const board = [...state.board]
      board[cell] = seat + 1
      const line = winningLine(board, cell)
      const moves = state.moves + 1
      const result = line.length ? ((seat + 1) as 1 | 2) : moves === COLS * ROWS ? 3 : 0
      return { ...state, board, line, moves, result, last: cell, turn: result ? state.turn : seat === 0 ? 1 : 0 }
    }
    case 'again': {
      // A seated player, once the game is over (or before anyone moved).
      if (seatOf(state, from) === null || (state.result === 0 && state.moves > 0)) return state
      const starts: 0 | 1 = state.moves > 0 ? (state.starts === 0 ? 1 : 0) : state.starts
      return { ...initialFour(), seats: state.seats, starts, turn: starts }
    }
    default:
      return state
  }
}

/** A snapshot from another player, checked field by field. */
export function parseFour(raw: unknown): FourState | null {
  if (!isObject(raw)) return null
  const { seats, board, turn, starts, result, line, moves, last } = raw
  if (!Array.isArray(seats) || seats.length !== 2 || !seats.every((s) => s === null || isId(s))) return null
  if (!Array.isArray(board) || board.length !== COLS * ROWS || !board.every((c) => isInt(c, 0, 2))) return null
  if (!isInt(turn, 0, 1) || !isInt(starts, 0, 1) || !isInt(result, 0, 3) || !isInt(moves, 0, COLS * ROWS)) return null
  if (!Array.isArray(line) || line.length > 7 || !line.every((c) => isInt(c, 0, COLS * ROWS - 1))) return null
  if (!(last === null || isInt(last, 0, COLS * ROWS - 1))) return null
  return { seats: seats as FourState['seats'], board: board as number[], turn, starts, result, line: line as number[], moves, last } as FourState
}

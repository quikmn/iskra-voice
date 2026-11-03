// What every built-in activity shares: the SDK (the same file server-added activities get), a tiny DOM helper, the
// strings in the player's language, the app's colours, and a loop that applies every message in the server's order.
// Games are a reducer: (state, message, sender) → state, pure, so every player ends up with the same state.
import '../../../protocol/activity-sdk.js'
import { activities as en } from '../i18n/en/activities'
import { activities as sv } from '../i18n/sv/activities'
import { fnv1a } from './util'
export { fmt, fnv1a, isId, isInt, isObject, isText, normalizeGuess } from './util'

export interface Player {
  id: string
  name: string
}

interface Init {
  me: Player
  players: Player[]
  state: unknown
  locale: string
  theme: { scheme?: string; colors?: Record<string, string> }
  activity: { id: string; name: string } | null
}

interface Sdk {
  ready(): Promise<Init>
  on(event: 'players', fn: (players: Player[]) => void): () => void
  on(event: 'message', fn: (data: unknown, from: string, seq: number) => void): () => void
  on(event: 'end', fn: () => void): () => void
  send(data: unknown): void
  setState(state: unknown): void
  end(): void
  readonly players: Player[]
  readonly host: string | null
}

const sdk = (globalThis as unknown as { iskra: Sdk }).iskra

export type Games = typeof en.games

export interface Ctx<S> {
  root: HTMLElement
  me: Player
  players: () => Player[]
  /** A player's name (someone who left: "Someone"). */
  nameOf: (id: string | null | undefined) => string
  send: (data: unknown) => void
  state: () => S
  strings: Games
  locale: string
  /** Ends the activity for everyone (if you may), or closes it for you. */
  end: () => void
}

export interface Game<S> {
  initial(): S
  /** A snapshot from someone else, checked; null starts fresh. */
  parse(raw: unknown): S | null
  /** One message from player `from`, applied. Pure and deterministic: return `state` unchanged to ignore it. */
  reduce(state: S, data: unknown, from: string): S
  mount(ctx: Ctx<S>): { update(state: S): void; players?(players: Player[]): void }
}

type Child = Node | string | number | null | undefined | false
type Props = Record<string, string | number | boolean | EventListener | null | undefined>

/** A DOM element. `on*` props are listeners; text children become text nodes (never HTML). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'className') el.className = String(value)
    else if (value === true) el.setAttribute(key, '')
    else el.setAttribute(key, String(value))
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child))
  return el
}

/** A row of a scoreboard: the player's initials in a colour of their own, their name, an optional badge and points. */
export function scoreRow(id: string, name: string, points: number, me: boolean, badge?: string | null): HTMLLIElement {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase() || '?'
  const hue = parseInt(fnv1a(id).slice(0, 4), 16) % 360
  return h('li', { className: me ? 'me' : '' },
    h('span', { className: 'av', style: `--h:${hue}`, 'aria-hidden': 'true' }, initials),
    h('span', { className: 'nm' }, name),
    badge ? h('span', { className: 'badge' }, badge) : null,
    h('strong', { className: 'pts' }, String(points)))
}

/** Replaces an element's children. */
export const fill = (el: Element, ...children: Child[]) => el.replaceChildren(...children.filter((c): c is Node | string | number => c !== null && c !== undefined && c !== false).map((c) => (c instanceof Node ? c : String(c))))

const BASE_CSS = `
:root { color-scheme: dark; --bg: #07070d; --surface: #141424; --surface2: #1b1b30; --border: rgba(120,100,255,.14); --text: #e2e2f0;
  --muted: #8484a8; --accent: #695bff; --green: #4ade80; --red: #f87171; --amber: #fbbf24; }
:root.light { color-scheme: light; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
#app { min-height: 100%; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px; }
button, input, select, textarea { font: inherit; color: inherit; }
button { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; cursor: pointer; min-height: 40px; }
button:hover:not(:disabled) { filter: brightness(1.15); }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); border-color: transparent; color: #fff; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input, textarea, select { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; min-height: 40px; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; width: 100%; max-width: 640px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.muted { color: var(--muted); }
.status { font-weight: 600; text-align: center; min-height: 1.4em; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
h1, h2 { margin: 0; font-size: 1.1rem; }
/* A card of its own (the scoreboard, the guesses): a small uppercase heading, then the list. */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px; display: grid; gap: 8px; align-content: start; min-height: 0; }
.card > h2 { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); padding: 0 2px; }
/* The scoreboard: avatar · name · badge … score. */
ul.scores { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
ul.scores li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; min-width: 0; }
ul.scores li.me { background: color-mix(in srgb, var(--accent) 14%, transparent); }
ul.scores .av {
  flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700;
  color: #fff; background: hsl(var(--h, 250) 45% 38%);
}
ul.scores .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
ul.scores .pts { font-variant-numeric: tabular-nums; }
.badge { flex: none; font-size: 11px; font-weight: 600; line-height: 1; padding: 4px 7px; border-radius: 99px; color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
/* The round's header strip: where we are · what's happening · the buttons. */
.strip {
  display: flex; align-items: center; gap: 8px 12px; width: 100%; flex-wrap: wrap; padding: 6px 6px 6px 12px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px; min-height: 52px;
}
.strip > .status { flex: 1; min-width: 12ch; }
.narrow { width: 100%; max-width: 640px; }
.chip { flex: none; font-size: 12px; font-weight: 600; color: var(--muted); padding: 4px 9px; border-radius: 99px; background: var(--surface2); font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`

function applyTheme(theme: Init['theme'], css: string) {
  const root = document.documentElement
  if (theme?.scheme === 'light') root.classList.add('light')
  for (const [name, value] of Object.entries(theme?.colors ?? {})) {
    if (/^[a-z0-9]+$/i.test(name) && /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,\s%]+\))$/.test(value)) root.style.setProperty(`--${name}`, value)
  }
  const style = document.createElement('style')
  style.textContent = BASE_CSS + css
  document.head.append(style)
}

/** Runs a game: waits for the app, applies the snapshot and every message in order, and keeps a snapshot for late joiners. */
export async function run<S>(game: Game<S>, css: string): Promise<void> {
  const init = await sdk.ready()
  const locale = init.locale?.toLowerCase().startsWith('sv') ? 'sv' : 'en'
  document.documentElement.lang = locale
  applyTheme(init.theme, css)
  const strings = (locale === 'sv' ? sv : en).games as Games
  let players = init.players
  let state = (init.state !== null && init.state !== undefined ? game.parse(init.state) : null) ?? game.initial()
  const known = new Map(players.map((p) => [p.id, p.name]))

  const ctx: Ctx<S> = {
    root: document.getElementById('app')!,
    me: init.me,
    players: () => players,
    nameOf: (id) => (id ? (known.get(id) ?? strings.someone) : strings.someone),
    send: (data) => sdk.send(data),
    state: () => state,
    strings,
    locale,
    end: () => sdk.end(),
  }
  const view = game.mount(ctx)
  view.update(state)

  // The player in longest keeps the snapshot up to date (after changes settle).
  let timer: ReturnType<typeof setTimeout> | null = null
  const snapshot = () => {
    if (sdk.host !== init.me.id || timer) return
    timer = setTimeout(() => {
      timer = null
      sdk.setState(state)
    }, 700)
  }

  sdk.on('players', (list) => {
    players = list
    for (const p of list) known.set(p.id, p.name)
    view.players?.(list)
    view.update(state)
  })
  sdk.on('message', (data, from) => {
    const next = game.reduce(state, data, from)
    if (next === state) return
    state = next
    view.update(state)
    snapshot()
  })
}


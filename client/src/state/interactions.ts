// Bot interactions on this device: commands and clicks waiting for the bot ("Dice is thinking…"), private answers
// (only you see them; the server never stores them, so they live here until dismissed or the app reloads), and the
// form a bot asked you to fill in. The pure parts are in interactionsLogic.ts.
import { create } from 'zustand'
import { errorMessage } from '../i18n/errors'
import type { Events, InteractionInvoke, InteractionResponse, Modal } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook } from './store'
import { addAnswer, ANSWER_TIMEOUT_MS, channelKey, settle, type PendingInteraction } from './interactionsLogic'

export interface OpenForm {
  serverKey: string
  modalId: string
  bot: string
  channelId: number
  modal: Modal
}

interface InteractionsState {
  /** interaction id → what we're waiting for. */
  pending: Record<string, PendingInteraction>
  /** "serverKey:channelId" → private answers, oldest first. */
  answers: Record<string, InteractionResponse[]>
  form: OpenForm | null
}

export const useInteractions = create<InteractionsState>(() => ({ pending: {}, answers: {}, form: null }))

const timers = new Map<string, ReturnType<typeof setTimeout>>()

function track(id: string, entry: PendingInteraction): void {
  useInteractions.setState((s) => ({ pending: { ...s.pending, [id]: entry } }))
  timers.set(id, setTimeout(() => expire(id), ANSWER_TIMEOUT_MS))
}

/** No answer in time: say so (a deferred interaction waits until its token runs out). */
function expire(id: string): void {
  timers.delete(id)
  useInteractions.setState((s) => {
    const entry = s.pending[id]
    if (!entry) return s
    if (entry.state === 'deferred' && Date.now() < entry.expiresAt) {
      timers.set(id, setTimeout(() => expire(id), Math.max(1000, entry.expiresAt - Date.now())))
      return s
    }
    return { pending: { ...s.pending, [id]: { ...entry, state: 'failed', error: null } } }
  })
}

function finish(id: string): void {
  clearTimeout(timers.get(id))
  timers.delete(id)
  useInteractions.setState((s) => ({ pending: settle(s.pending, id) }))
}

/** Sends a command, click or form to the server; the bot's answer arrives as an event. Throws the server's refusal. */
export async function invoke(serverKey: string, channelId: number, bot: string, label: string, body: InteractionInvoke): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection) throw new Error('offline')
  const { id, expiresAt } = await connection.request('interaction.invoke', body)
  track(id, { serverKey, channelId, bot, label, state: 'thinking', startedAt: Date.now(), expiresAt, error: null })
}

/** Like invoke, but a refusal shows in the tray instead of throwing (clicks on buttons and menus). */
export async function click(serverKey: string, channelId: number, bot: string, label: string, body: InteractionInvoke): Promise<void> {
  try {
    await invoke(serverKey, channelId, bot, label, body)
  } catch (e) {
    const id = `local-${Date.now()}-${Math.random()}`
    useInteractions.setState((s) => ({
      pending: { ...s.pending, [id]: { serverKey, channelId, bot, label, state: 'failed', startedAt: Date.now(), expiresAt: 0, error: errorMessage(e) } },
    }))
  }
}

export function dismissPending(id: string): void {
  finish(id)
}

export function dismissAnswer(serverKey: string, channelId: number, responseId: string): void {
  const key = channelKey(serverKey, channelId)
  useInteractions.setState((s) => ({ answers: { ...s.answers, [key]: (s.answers[key] ?? []).filter((a) => a.responseId !== responseId) } }))
}

export function closeForm(): void {
  useInteractions.setState({ form: null })
}

/** Sends the form; on a refusal (a required field, too long) it stays open and the error is thrown. */
export async function submitForm(form: OpenForm, fields: Record<string, string>): Promise<void> {
  await invoke(form.serverKey, form.channelId, form.bot, form.modal.title, { modalId: form.modalId, fields })
  useInteractions.setState((s) => (s.form?.modalId === form.modalId ? { form: null } : s))
}

onServerEvent((serverKey, type, body) => {
  switch (type) {
    case 'interaction.response': {
      const answer = body as Events['interaction.response']
      finish(answer.interaction)
      const key = channelKey(serverKey, answer.channelId)
      useInteractions.setState((s) => ({ answers: { ...s.answers, [key]: addAnswer(s.answers[key] ?? [], answer) } }))
      return
    }
    case 'interaction.state': {
      const { id, state } = body as Events['interaction.state']
      if (state === 'done') finish(id)
      else useInteractions.setState((s) => (s.pending[id] ? { pending: { ...s.pending, [id]: { ...s.pending[id], state: 'deferred' } } } : s))
      return
    }
    case 'interaction.modal': {
      const open = body as Events['interaction.modal']
      finish(open.interaction)
      useInteractions.setState({ form: { serverKey, modalId: open.modalId, bot: open.bot, channelId: open.channelId, modal: open.modal } })
      return
    }
    case 'chat.message': {
      const id = (body as Events['chat.message']).message.interaction?.id
      if (id) finish(id)
      return
    }
  }
})

// A new connection: answers in flight are gone with the old one (tokens live in the server's memory).
onWelcomeHook((serverKey) => {
  useInteractions.setState((s) => {
    const pending = Object.fromEntries(Object.entries(s.pending).filter(([, p]) => p.serverKey !== serverKey))
    return { pending, form: s.form?.serverKey === serverKey ? null : s.form }
  })
})

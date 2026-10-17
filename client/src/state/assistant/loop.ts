// One "send": the user's message goes to the provider; while the model asks for tools, they run (writes wait for the
// user's approval) and their results go back, up to a fixed number of steps.
import { complete, type Transport } from './providers'
import type { AssistantConfig, ToolResult, Turn } from './types'
import type { ToolRunner } from './tools/registry'

export const MAX_STEPS = 12

export interface LoopOptions {
  config: AssistantConfig
  system: string
  /** The conversation so far, ending with the user's new message. */
  turns: Turn[]
  runner: ToolRunner
  transport: Transport
  browser: boolean
  signal?: AbortSignal
  /** Each new turn (assistant message or tool results), as it happens. */
  onTurn(turn: Turn): void
}

export type LoopEnd = 'done' | 'steps' | 'refusal' | 'length' | 'cancelled'

export async function runLoop(options: LoopOptions): Promise<LoopEnd> {
  const turns = [...options.turns]
  for (let step = 0; step < MAX_STEPS; step++) {
    if (options.signal?.aborted) return 'cancelled'
    const reply = await complete(options.config, options.system, turns, options.runner.specs(), options.transport, options.browser, options.signal)
    const assistant: Turn = { role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw }
    turns.push(assistant)
    options.onTurn(assistant)
    if (reply.stop === 'refusal' || reply.stop === 'length') {
      // A tool call can't be left unanswered in the history: answer any with a note.
      if (reply.toolCalls.length) {
        const results: ToolResult[] = reply.toolCalls.map((c) => ({ id: c.id, name: c.name, content: 'Not run.', isError: true }))
        const tool: Turn = { role: 'tool', results }
        turns.push(tool)
        options.onTurn(tool)
      }
      return reply.stop
    }
    if (!reply.toolCalls.length) return 'done'
    const results: ToolResult[] = []
    // One at a time, so approval cards come in order.
    for (const call of reply.toolCalls) {
      if (options.signal?.aborted) {
        results.push({ id: call.id, name: call.name, content: 'Cancelled by the user.', isError: true })
        continue
      }
      const result = await options.runner.call(call.name, call.args, 'chat')
      results.push({ id: call.id, name: call.name, content: result.content, isError: result.isError })
    }
    const tool: Turn = { role: 'tool', results }
    turns.push(tool)
    options.onTurn(tool)
    if (options.signal?.aborted) return 'cancelled'
  }
  return 'steps'
}

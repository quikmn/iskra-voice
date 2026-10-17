// Talking to the AI provider the user chose, straight from this device: the Anthropic Messages API, or any
// OpenAI-compatible chat completions API (OpenAI, Mistral, Groq, OpenRouter, Gemini's compatible API, Ollama, LM Studio).
// Never through Iskra or a server. The desktop app sends the requests from its main process (no browser CORS); the web
// and phone apps use fetch. Not streamed: a reply arrives whole, then any tool calls run.
import { checkBaseUrl, originOf, type Endpoint } from './url'
import type { AssistantConfig, ProviderReply, ToolCall, ToolSpec, Turn } from './types'

export interface HttpRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

export interface HttpResponse {
  status: number
  body: string
}

export type Transport = (request: HttpRequest, signal?: AbortSignal) => Promise<HttpResponse>

export type ProviderErrorCode = 'auth' | 'rate' | 'network' | 'http' | 'bad_response' | 'blocked' | 'timeout' | 'not_configured' | 'cancelled'

export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly status?: number
  readonly detail?: string
  constructor(code: ProviderErrorCode, status?: number, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ProviderError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

export const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOKENS = 8192
const TIMEOUT_MS = 120_000

/** fetch, for the web and phone apps. No cookies, no referrer, no redirects (a redirect could lead somewhere else). */
export const fetchTransport: Transport = async (request, signal) => {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: combined,
    })
  } catch (e) {
    if (signal?.aborted) throw new ProviderError('cancelled')
    if (timeout.aborted) throw new ProviderError('timeout')
    throw new ProviderError('network', undefined, e instanceof Error ? e.message : undefined)
  }
  return { status: response.status, body: await response.text() }
}

function endpoint(config: Pick<AssistantConfig, 'baseUrl'>, path: Endpoint): string {
  const base = checkBaseUrl(config.baseUrl)
  if (!base.ok) throw new ProviderError('blocked', undefined, base.problem)
  // Anthropic's base is the host; "…/v1" pasted as the base works too.
  const url = base.url.endsWith('/v1') && path.startsWith('/v1/') ? base.url + path.slice(3) : base.url + path
  return url
}

function headers(config: Pick<AssistantConfig, 'kind' | 'key' | 'keyOrigin' | 'baseUrl'>, browser: boolean): Record<string, string> {
  // A key goes only to the origin it was saved for, never to another address.
  if (config.key && config.keyOrigin !== originOf(config.baseUrl)) throw new ProviderError('blocked', undefined, 'key-origin')
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (config.kind === 'anthropic') {
    h['x-api-key'] = config.key
    h['anthropic-version'] = ANTHROPIC_VERSION
    // Anthropic refuses requests from a web page without this; the key is the user's own and stays on this device.
    if (browser) h['anthropic-dangerous-direct-browser-access'] = 'true'
  } else if (config.key) {
    h.authorization = `Bearer ${config.key}`
  }
  return h
}

function providerMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
    return typeof message === 'string' ? message.slice(0, 300) : undefined
  } catch {
    return undefined
  }
}

function check(response: HttpResponse): unknown {
  if (response.status === 401 || response.status === 403) throw new ProviderError('auth', response.status, providerMessage(response.body))
  if (response.status === 429) throw new ProviderError('rate', 429, providerMessage(response.body))
  if (response.status < 200 || response.status >= 300) throw new ProviderError('http', response.status, providerMessage(response.body))
  try {
    return JSON.parse(response.body)
  } catch {
    throw new ProviderError('bad_response', response.status)
  }
}

const parseArgs = (text: unknown): unknown => {
  if (typeof text !== 'string') return text ?? {}
  try {
    return text.trim() ? JSON.parse(text) : {}
  } catch {
    return text
  }
}

// ── Anthropic Messages API ───────────────────────────────────────────────────

interface AnthropicBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

function anthropicMessages(turns: Turn[]): unknown[] {
  const out: { role: 'user' | 'assistant'; content: unknown }[] = []
  for (const turn of turns) {
    if (turn.role === 'user') out.push({ role: 'user', content: [{ type: 'text', text: turn.text }] })
    // The provider's own content blocks, unchanged (thinking blocks must come back exactly as they were).
    else if (turn.role === 'assistant') out.push({ role: 'assistant', content: turn.raw ?? [{ type: 'text', text: turn.text }] })
    else {
      out.push({
        role: 'user',
        content: turn.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      })
    }
  }
  return out
}

export function anthropicRequest(config: AssistantConfig, system: string, turns: Turn[], tools: ToolSpec[], browser: boolean): HttpRequest {
  return {
    url: endpoint(config, '/v1/messages'),
    method: 'POST',
    headers: headers(config, browser),
    body: JSON.stringify({
      model: config.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: anthropicMessages(turns),
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) } : {}),
    }),
  }
}

export function anthropicReply(json: unknown): ProviderReply {
  const reply = json as { content?: AnthropicBlock[]; stop_reason?: string }
  if (!reply || !Array.isArray(reply.content)) throw new ProviderError('bad_response')
  const text = reply.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
  const toolCalls: ToolCall[] = reply.content
    .filter((b) => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
    .map((b) => ({ id: b.id!, name: b.name!, args: b.input ?? {} }))
  const stop = reply.stop_reason === 'refusal' ? 'refusal' : reply.stop_reason === 'max_tokens' ? 'length' : toolCalls.length ? 'tools' : 'end'
  return { text, toolCalls, raw: reply.content, stop }
}

// ── OpenAI-compatible chat completions ───────────────────────────────────────

interface OpenAiToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

function openAiMessages(system: string, turns: Turn[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }]
  for (const turn of turns) {
    if (turn.role === 'user') out.push({ role: 'user', content: turn.text })
    else if (turn.role === 'assistant') out.push(turn.raw ?? { role: 'assistant', content: turn.text })
    else for (const r of turn.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content })
  }
  return out
}

export function openAiRequest(config: AssistantConfig, system: string, turns: Turn[], tools: ToolSpec[]): HttpRequest {
  return {
    url: endpoint(config, '/chat/completions'),
    method: 'POST',
    headers: headers(config, false),
    body: JSON.stringify({
      model: config.model,
      max_tokens: MAX_TOKENS,
      messages: openAiMessages(system, turns),
      ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}),
    }),
  }
}

export function openAiReply(json: unknown): ProviderReply {
  const choice = (json as { choices?: { message?: { content?: unknown; tool_calls?: OpenAiToolCall[]; refusal?: unknown }; finish_reason?: string }[] })?.choices?.[0]
  const message = choice?.message
  if (!message) throw new ProviderError('bad_response')
  const text = typeof message.content === 'string' ? message.content.trim() : ''
  const toolCalls: ToolCall[] = (message.tool_calls ?? [])
    .filter((c) => typeof c.id === 'string' && typeof c.function?.name === 'string')
    .map((c) => ({ id: c.id!, name: c.function!.name!, args: parseArgs(c.function!.arguments) }))
  // Replayed as sent back; only the fields chat completions take.
  const raw = { role: 'assistant', content: typeof message.content === 'string' ? message.content : null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) }
  const stop = typeof message.refusal === 'string' && message.refusal ? 'refusal' : choice.finish_reason === 'length' ? 'length' : toolCalls.length ? 'tools' : 'end'
  return { text: text || (typeof message.refusal === 'string' ? message.refusal : ''), toolCalls, raw, stop }
}

// ── Both ─────────────────────────────────────────────────────────────────────

export function isConfigured(config: AssistantConfig): boolean {
  return config.enabled && checkBaseUrl(config.baseUrl).ok && !!config.model.trim() && (config.kind === 'openai' || !!config.key)
}

/** One round trip: the conversation so far in, the model's next message out. */
export async function complete(config: AssistantConfig, system: string, turns: Turn[], tools: ToolSpec[], transport: Transport, browser: boolean, signal?: AbortSignal): Promise<ProviderReply> {
  if (!isConfigured(config)) throw new ProviderError('not_configured')
  if (config.kind === 'anthropic') return anthropicReply(check(await transport(anthropicRequest(config, system, turns, tools, browser), signal)))
  return openAiReply(check(await transport(openAiRequest(config, system, turns, tools), signal)))
}

/** "Test connection": lists the models the key can use (no tokens spent). */
export async function listModels(config: AssistantConfig, transport: Transport, browser: boolean): Promise<string[]> {
  const url = endpoint(config, config.kind === 'anthropic' ? '/v1/models' : '/models')
  const json = check(await transport({ url, method: 'GET', headers: headers(config, browser) })) as { data?: { id?: unknown }[]; models?: { name?: unknown }[] }
  const ids = (json.data ?? []).map((m) => m.id).concat((json.models ?? []).map((m) => m.name))
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 200))].slice(0, 200)
}

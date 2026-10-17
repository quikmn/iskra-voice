// Shared types for the personal assistant (bring your own AI): settings, the conversation and tool calls.

export type ProviderKind = 'anthropic' | 'openai'

/** Presets fill in the base URL; "custom" is any OpenAI-compatible address. */
export type ProviderPreset = 'anthropic' | 'openai' | 'mistral' | 'groq' | 'openrouter' | 'gemini' | 'ollama' | 'lmstudio' | 'custom'

export interface AssistantConfig {
  v: 1
  enabled: boolean
  preset: ProviderPreset
  kind: ProviderKind
  baseUrl: string
  model: string
  /** The provider's API key; empty for local models. Kept sealed at rest (core/storage.ts), never in localStorage. */
  key: string
  /** The origin (scheme://host:port) the key was saved for. A key is only ever sent there; another address drops it. */
  keyOrigin: string
  /** Moderation and Server admin tools stay off until the user turns them on. */
  moderation: boolean
  admin: boolean
  /** Desktop app: expose the same tools to a local MCP client over stdio. */
  mcp: boolean
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'

export const PRESETS: Record<ProviderPreset, { kind: ProviderKind; baseUrl: string; model: string }> = {
  anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: DEFAULT_ANTHROPIC_MODEL },
  openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
  mistral: { kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', model: '' },
  groq: { kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: '' },
  openrouter: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  gemini: { kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '' },
  ollama: { kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: '' },
  lmstudio: { kind: 'openai', baseUrl: 'http://localhost:1234/v1', model: '' },
  custom: { kind: 'openai', baseUrl: '', model: '' },
}

export const DEFAULT_CONFIG: AssistantConfig = {
  v: 1,
  enabled: false,
  preset: 'anthropic',
  kind: 'anthropic',
  baseUrl: PRESETS.anthropic.baseUrl,
  model: DEFAULT_ANTHROPIC_MODEL,
  key: '',
  keyOrigin: '',
  moderation: false,
  admin: false,
  mcp: false,
}

export interface ToolCall {
  id: string
  name: string
  /** Parsed arguments (an object), or the raw text when the model sent invalid JSON. */
  args: unknown
}

export interface ToolResult {
  id: string
  name: string
  content: string
  isError: boolean
}

/** One step of the conversation, provider-neutral. `raw` replays the provider's own assistant message unchanged. */
export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw: unknown }
  | { role: 'tool'; results: ToolResult[] }

/** What a provider is told about a tool. */
export interface ToolSpec {
  name: string
  description: string
  schema: Record<string, unknown>
}

export interface ProviderReply {
  text: string
  toolCalls: ToolCall[]
  raw: unknown
  /** 'refusal': the model declined; 'length': it ran out of room. */
  stop: 'end' | 'tools' | 'length' | 'refusal'
}

// AutoMod settings: the defaults, the suggested preset and the form <-> settings conversion (no React, no socket).
// The server checks everything again; these limits only let the form say what's wrong before saving.
import type { AutoModAction, AutoModConfig, AutoModRule } from '../core/protocol'
import { t } from '../i18n'

export const AUTOMOD_LIMITS = { blocked: 500, allowed: 100, wordLength: 50, wildcards: 4, domains: 50 } as const

const none = (): AutoModAction => ({ timeoutMs: 0, alert: false })

/** What a server starts with: everything off. */
export function defaultAutoMod(): AutoModConfig {
  return {
    enabled: false,
    words: { enabled: false, blocked: [], allowed: [], action: none() },
    mentions: { enabled: false, max: 10, action: none() },
    flood: { enabled: false, count: 8, seconds: 10, action: none() },
    duplicates: { enabled: false, count: 3, seconds: 60, action: none() },
    links: { enabled: false, mode: 'invites', allowedDomains: [], action: none() },
    exemptRoles: [],
    exemptChannels: [],
    alertChannelId: null,
  }
}

/**
 * A sensible starting point: spam rules on, invite links blocked, alerts to the chosen channel. Short timeouts only
 * for the spammy rules, and only if you may time people out. Blocked words stay as they are (each group picks its own).
 */
export function suggestedAutoMod(current: AutoModConfig, canTimeout: boolean, alertChannelId: number | null): AutoModConfig {
  const alert = alertChannelId !== null
  const timeout = (ms: number) => (canTimeout ? ms : 0)
  return {
    ...current,
    enabled: true,
    words: { ...current.words, enabled: current.words.blocked.length > 0 || current.words.enabled, action: { timeoutMs: 0, alert } },
    mentions: { enabled: true, max: 8, action: { timeoutMs: timeout(5 * 60_000), alert } },
    flood: { enabled: true, count: 6, seconds: 5, action: { timeoutMs: timeout(60_000), alert } },
    duplicates: { enabled: true, count: 3, seconds: 30, action: { timeoutMs: 0, alert } },
    links: { ...current.links, enabled: true, mode: 'invites', action: { timeoutMs: 0, alert } },
    alertChannelId: current.alertChannelId ?? alertChannelId,
  }
}

/** One entry per line (commas also split); blanks dropped, repeats (ignoring case) merged. */
export function parseList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[\n,]/)) {
    const entry = raw.trim()
    const key = entry.toLowerCase()
    if (!entry || seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/** The first problem with a word list, or null. */
export function wordListProblem(entries: string[], max: number): string | null {
  if (entries.length > max) return t('automod.problems.tooMany', { max, count: entries.length })
  for (const e of entries) {
    if (e.length > AUTOMOD_LIMITS.wordLength) return t('automod.problems.tooLong', { start: e.slice(0, 20), max: AUTOMOD_LIMITS.wordLength })
    if (!/[\p{L}\p{N}]/u.test(e)) return t('automod.problems.noLetter', { entry: e })
    if ((e.match(/\*/g) ?? []).length > AUTOMOD_LIMITS.wildcards) return t('automod.problems.wildcards', { entry: e, max: AUTOMOD_LIMITS.wildcards })
  }
  return null
}

/** Domains as the server keeps them: no scheme, "www." or "*.", lower case. Returns the first bad one too. */
export function parseDomains(text: string): { domains: string[]; bad: string | null } {
  const domains = parseList(text).map((d) => d.toLowerCase().replace(/^https?:\/\//, '').replace(/^(\*\.|www\.)/, '').replace(/\/+$/, ''))
  const bad = domains.find((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || d.length > 100) ?? null
  return { domains: [...new Set(domains)], bad }
}

const RULES: readonly string[] = ['words', 'mentions', 'flood', 'duplicates', 'links'] satisfies AutoModRule[]

/** "Blocked word"; a rule this app doesn't know yet as is. */
export const ruleLabel = (rule: string): string => (RULES.includes(rule) ? t(`automod.ruleLabels.${rule as AutoModRule}`) : rule)

/** How many rules are on (for the summary line). */
export const activeRules = (c: AutoModConfig): AutoModRule[] =>
  (['words', 'mentions', 'flood', 'duplicates', 'links'] as const).filter((r) => c[r].enabled)

/** An error from the server that means AutoMod stopped this (the message says why). */
export const isAutoModError = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'automod'

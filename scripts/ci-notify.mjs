#!/usr/bin/env node
// Posts what GitHub's own webhook messages don't say to an Iskra channel (docs/ci-cd.md, "CI results in Iskra"). The
// channel already gets GitHub's workflow_run event (Iskra turns it into a pass/fail line), so this posts only:
// - ci.yml: on a failure, which jobs and end-to-end tests failed; on a pass, the end-to-end tests that were flaky
//   (passed only on their retry). A plain pass posts nothing.
// - e2e-stress.yml (nightly): only when a test failed or was flaky.
// Optional: without the secret ISKRA_CI_WEBHOOK it does nothing. It sends only the workflow, branch, short commit, the
// failed jobs' names, the test names and the run's link; never logs, never the webhook URL. A post that fails is a
// warning, never a red run.
//
//   node scripts/ci-notify.mjs ci        # ci.yml: NEEDS = toJSON(needs)
//   node scripts/ci-notify.mjs stress    # e2e-stress.yml: NEEDS = toJSON(needs)
//
// Both read E2E_FLAKY and E2E_FAILED (end-to-end tests, one per line: scripts/e2e-flaky.mjs's outputs) and
// GITHUB_REF_NAME, GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const GREEN = 0x3ba55d
const RED = 0xed4245
const GREY = 0x99aab5

/** The webhook URL must be an Iskra incoming webhook over HTTPS (https://host[:port]/hooks/<id>/<secret>). */
export function checkWebhook(url) {
  let u
  try { u = new URL(url) } catch { return false }
  return u.protocol === 'https:' && /^\/hooks\/[^/]+\/[^/]+\/?$/.test(u.pathname) && !u.username && !u.password
}

/** One verdict from the `needs` context: failure beats cancelled beats success; skipped jobs don't count. */
export function verdict(needs) {
  const jobs = Object.entries(needs ?? {}).map(([name, j]) => ({ name, result: j?.result ?? 'unknown' }))
  const failed = jobs.filter((j) => j.result === 'failure').map((j) => j.name)
  if (failed.length) return { result: 'failure', failed }
  const cancelled = jobs.filter((j) => j.result === 'cancelled').map((j) => j.name)
  if (cancelled.length) return { result: 'cancelled', failed: cancelled }
  if (!jobs.some((j) => j.result === 'success')) return { result: 'skipped', failed: [] }
  return { result: 'success', failed: [] }
}

/** Test names, one per line (scripts/e2e-flaky.mjs), without blanks. */
const testLines = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)

/** A list for the message: the first few names, then how many more. */
function shortList(names, max = 5) {
  const shown = names.slice(0, max).map((n) => n.slice(0, 160))
  return names.length > max ? `${shown.join('; ')}; and ${names.length - max} more` : shown.join('; ')
}

/**
 * Whether there's anything to say beyond GitHub's own pass/fail: a failure (which jobs, which tests), or flaky tests.
 * CI posts on any failure; the stress run only when it found failed or flaky tests (a failed setup step is GitHub's
 * message alone). Cancelled and skipped runs never post.
 */
export function worthPosting({ kind, needs, env }) {
  const { result } = verdict(needs)
  const flaky = testLines(env.E2E_FLAKY).length > 0
  const failedTests = testLines(env.E2E_FAILED).length > 0
  if (kind === 'stress') return (result === 'success' || result === 'failure') && (flaky || failedTests)
  return result === 'failure' || (result === 'success' && flaky)
}

/** The webhook body (Discord-style JSON, PROTOCOL.md "Webhooks"): one embed. */
export function payload({ kind, needs, env }) {
  const { result, failed } = verdict(needs)
  const flakyTests = testLines(env.E2E_FLAKY)
  const failedTests = testLines(env.E2E_FAILED)
  const sha = String(env.GITHUB_SHA ?? '').slice(0, 10)
  const server = env.GITHUB_SERVER_URL || 'https://github.com'
  const run = `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}${Number(env.GITHUB_RUN_ATTEMPT) > 1 ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : ''}`
  const branch = env.GITHUB_REF_NAME || 'main'
  const what = kind === 'stress' ? 'Nightly end-to-end stress' : 'CI'
  let title = result === 'success' ? `${what} passed on ${branch}` : result === 'failure' ? `${what} failed on ${branch}` : `${what} ${result} on ${branch}`
  // Green with tests that only passed on their retry: say so, so a flake doesn't go unnoticed.
  if (result === 'success' && flakyTests.length) title += `, ${flakyTests.length} flaky`
  const lines = sha ? [`Commit ${sha}`] : []
  if (failed.length) lines.push(`${result === 'failure' ? 'Failed' : 'Cancelled'}: ${failed.join(', ')}`)
  if (failedTests.length) lines.push(`Failed tests: ${shortList(failedTests)}`)
  if (flakyTests.length) lines.push(`Flaky (passed on retry): ${shortList(flakyTests)}`)
  return {
    username: 'Iskra CI',
    embeds: [{ title: title.slice(0, 256), url: run, description: lines.join('\n').slice(0, 1000), color: result === 'success' ? GREEN : result === 'failure' ? RED : GREY }],
  }
}

export async function main(argv, { env = process.env, fetchImpl = fetch, print = console.log } = {}) {
  const kind = argv[0]
  if (kind !== 'ci' && kind !== 'stress') { print('usage: ci-notify.mjs ci|stress'); return 1 }
  const url = env.ISKRA_CI_WEBHOOK
  if (!url) { print('No ISKRA_CI_WEBHOOK secret: not reporting to Iskra.'); return 0 }
  if (!checkWebhook(url)) { print('::warning::ISKRA_CI_WEBHOOK isn\'t an Iskra webhook URL (https://<server>/hooks/<id>/<secret>); not reporting.'); return 0 }
  let needs
  try { needs = JSON.parse(env.NEEDS || '{}') } catch { print('::warning::NEEDS isn\'t JSON; not reporting.'); return 0 }
  if (!worthPosting({ kind, needs, env })) { print('Nothing beyond GitHub\'s own run message (no failure, no flaky tests): not posting.'); return 0 }
  const body = payload({ kind, needs, env })
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    if (!res.ok) { print(`::warning::The Iskra webhook answered ${res.status}; the result wasn't posted.`); return 0 }
  } catch (e) {
    print(`::warning::Couldn't reach the Iskra webhook (${e?.name === 'TimeoutError' ? 'timed out' : 'network error'}); the result wasn't posted.`)
    return 0
  }
  print(`Posted to Iskra: ${body.embeds[0].title}`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2))
}

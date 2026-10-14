#!/usr/bin/env node
// Posts a short CI or release result to an Iskra channel through an incoming webhook (docs/ci-cd.md, "CI results in
// Iskra"). Optional: without the secret ISKRA_CI_WEBHOOK it does nothing. It sends only the workflow, branch or tag,
// the short commit, pass/fail (with the failed jobs' names) and the run's link; never logs, never the webhook URL.
// A post that fails is a warning, never a red run.
//
//   node scripts/ci-notify.mjs ci        # ci.yml: NEEDS = toJSON(needs)
//   node scripts/ci-notify.mjs release   # release-finalize.yml: NEEDS = toJSON(needs), TAG = the release tag
//
// Reads GITHUB_REF_NAME, GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT; a release
// gives its tag's commit in COMMIT (finalize itself runs on main).
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

/** The webhook body (Discord-style JSON, PROTOCOL.md "Webhooks"): one embed. */
export function payload({ kind, needs, env }) {
  const { result, failed } = verdict(needs)
  const sha = String((kind === 'release' ? env.COMMIT : env.GITHUB_SHA) ?? '').slice(0, 10)
  const server = env.GITHUB_SERVER_URL || 'https://github.com'
  const run = `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}${Number(env.GITHUB_RUN_ATTEMPT) > 1 ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : ''}`
  let title
  if (kind === 'release') {
    const tag = env.TAG || env.GITHUB_REF_NAME
    const deployed = needs?.deploy?.result === 'success'
    title = result === 'success' ? `Release ${tag} published${deployed ? ' and deployed' : ''}` : `Release ${tag}: ${result === 'failure' ? 'failed' : result}`
  } else {
    const branch = env.GITHUB_REF_NAME || 'main'
    title = result === 'success' ? `CI passed on ${branch}` : result === 'failure' ? `CI failed on ${branch}` : `CI ${result} on ${branch}`
  }
  const lines = sha ? [`Commit ${sha}`] : []
  if (failed.length) lines.push(`${result === 'failure' ? 'Failed' : 'Cancelled'}: ${failed.join(', ')}`)
  return {
    username: kind === 'release' ? 'Iskra releases' : 'Iskra CI',
    embeds: [{ title: title.slice(0, 256), url: run, description: lines.join('\n').slice(0, 1000), color: result === 'success' ? GREEN : result === 'failure' ? RED : GREY }],
  }
}

export async function main(argv, { env = process.env, fetchImpl = fetch, print = console.log } = {}) {
  const kind = argv[0]
  if (kind !== 'ci' && kind !== 'release') { print('usage: ci-notify.mjs ci|release'); return 1 }
  const url = env.ISKRA_CI_WEBHOOK
  if (!url) { print('No ISKRA_CI_WEBHOOK secret: not reporting to Iskra.'); return 0 }
  if (!checkWebhook(url)) { print('::warning::ISKRA_CI_WEBHOOK isn\'t an Iskra webhook URL (https://<server>/hooks/<id>/<secret>); not reporting.'); return 0 }
  let needs
  try { needs = JSON.parse(env.NEEDS || '{}') } catch { print('::warning::NEEDS isn\'t JSON; not reporting.'); return 0 }
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

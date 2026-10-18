#!/usr/bin/env node
// Step of scripts/release.ps1 (the one release command); don't run it by hand. Also the CI gate of release-finalize.yml
// and of the Release workflow's checks (release-preflight.mjs). Uses the GitHub CLI (GH_TOKEN in Actions).
//
//   node scripts/ci-gate.mjs <commit sha> [--repo owner/name] [--wait-minutes 45]
//        Exit 0: a push run of CI (ci.yml) concluded success on exactly that commit.
//   node scripts/ci-gate.mjs <commit sha> --run <run id> [--repo owner/name] [--wait-minutes 45]
//        Exit 0: run <run id> is the Release workflow (release-all.yml) on main, and the CI it called in that same run
//        (its "ci / ..." jobs, checked out at the tagged commit) passed. Finalize uses this when the Release workflow
//        calls it: that workflow's own pushes can't start a separate CI run (GITHUB_TOKEN), so it runs CI itself.
//
// Exit 1: CI failed there, or no green run within the wait. Prints one line per check.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { ciVerdict, releaseRunCiVerdict } from './release-lib.mjs'

const ghJson = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))

/** One look at GitHub: a push run of ci.yml on `sha`, or the CI jobs of Release run `run`. */
export function lookOnce({ sha, repo, run, gh = ghJson }) {
  if (run) {
    const r = gh(`repos/${repo}/actions/runs/${run}`)
    const jobs = []
    for (let page = 1; page <= 5; page++) {
      const batch = gh(`repos/${repo}/actions/runs/${run}/jobs?filter=latest&per_page=100&page=${page}`).jobs ?? []
      jobs.push(...batch)
      if (batch.length < 100) break
    }
    return releaseRunCiVerdict(r, jobs)
  }
  // Runs are newest first; a run's conclusion follows its latest attempt (a rerun of failed jobs).
  const out = gh(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=50`)
  const verdict = ciVerdict(out.workflow_runs.filter((r) => r.head_sha === sha))
  // A red run names its red jobs, so the log tells a flake (one job, rerun it) from a real failure at a glance.
  if (verdict.state === 'fail' && verdict.run?.id) {
    try {
      const jobs = gh(`repos/${repo}/actions/runs/${verdict.run.id}/jobs?filter=latest&per_page=100`).jobs ?? []
      const red = jobs.filter((j) => j.status === 'completed' && !['success', 'skipped'].includes(j.conclusion)).map((j) => `${j.name} ${j.conclusion}`)
      if (red.length) return { ...verdict, message: `${verdict.message} (${red.join(', ')})` }
    } catch { /* the verdict stands without the job names */ }
  }
  return verdict
}

/** Polls until pass or fail, or the wait is over. Returns { ok, timedOut, message }. */
export async function waitForCi({ sha, repo, run = '', waitMinutes = 45, gh = ghJson, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const deadline = now() + waitMinutes * 60_000
  for (;;) {
    let verdict
    try { verdict = lookOnce({ sha, repo, run, gh }) } catch (e) {
      verdict = { state: 'wait', message: `couldn't ask GitHub (${String(e.stderr || e.message).trim().split('\n')[0]})` }
    }
    log(`${new Date(now()).toISOString().slice(11, 19)} ${sha.slice(0, 12)}: ${verdict.message}`)
    if (verdict.state === 'pass') return { ok: true, message: verdict.message }
    if (verdict.state === 'fail') return { ok: false, message: verdict.message }
    if (now() >= deadline) return { ok: false, timedOut: true, message: `no green CI run on ${sha} after ${waitMinutes} minutes (${verdict.message})` }
    await sleep(Math.min(30_000, Math.max(1000, deadline - now())))
  }
}

async function main(args) {
  const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
  const sha = args[0]
  const repo = opt('--repo', process.env.GH_REPO || process.env.GITHUB_REPOSITORY || 'quikmn/iskra-voice')
  const run = opt('--run', '')
  const waitMinutes = Number(opt('--wait-minutes', '45'))
  const fail = (msg) => { console.error(`error: ${msg}`); return 1 }
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) return fail('give the full 40-character commit sha')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(`"${repo}" isn't owner/name`)
  if (run && !/^\d+$/.test(run)) return fail('--run takes a run id')
  if (!Number.isFinite(waitMinutes) || waitMinutes < 0) return fail('--wait-minutes must be a number of minutes')
  const r = await waitForCi({ sha, repo, run, waitMinutes })
  if (r.ok) return 0
  return fail(`${r.message}. Nothing was published. ${r.timedOut ? 'When CI is green, run finalize again.' : 'Fix main (or rerun the failed CI jobs if it was a flake), then run finalize again.'}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main(process.argv.slice(2))

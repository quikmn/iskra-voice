#!/usr/bin/env node
// Waits until the CI workflow (ci.yml) passed on a commit; release-finalize.yml runs it before publishing anything, and
// scripts/release-all.ps1 to report. Uses the GitHub CLI (GH_TOKEN in Actions).
//
//   node scripts/ci-gate.mjs <commit sha> [--repo owner/name] [--wait-minutes 45]
//
// Exit 0: a push run of CI concluded success on exactly that commit. Exit 1: CI failed there, or no green run within
// the wait. Prints one line per check.
import { execFileSync } from 'node:child_process'
import { ciVerdict } from './release-lib.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const sha = args[0]
const repo = opt('--repo', process.env.GH_REPO || process.env.GITHUB_REPOSITORY || 'quikmn/iskra-voice')
const waitMinutes = Number(opt('--wait-minutes', '45'))
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1) }
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) fail('give the full 40-character commit sha')
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`"${repo}" isn't owner/name`)
if (!Number.isFinite(waitMinutes) || waitMinutes < 0) fail('--wait-minutes must be a number of minutes')

const deadline = Date.now() + waitMinutes * 60_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (;;) {
  let verdict
  try {
    const out = execFileSync('gh', ['api', `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=50`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    // Runs are newest first; a run's conclusion follows its latest attempt (a rerun of failed jobs).
    verdict = ciVerdict(JSON.parse(out).workflow_runs.filter((r) => r.head_sha === sha))
  } catch (e) {
    verdict = { state: 'wait', message: `couldn't ask GitHub (${String(e.stderr || e.message).trim().split('\n')[0]})` }
  }
  console.log(`${new Date().toISOString().slice(11, 19)} ${sha.slice(0, 12)}: ${verdict.message}`)
  if (verdict.state === 'pass') process.exit(0)
  if (verdict.state === 'fail') fail(`${verdict.message}. Nothing was published. Fix main (or rerun the failed CI jobs if it was a flake), then run finalize again.`)
  if (Date.now() >= deadline) fail(`no green CI run on ${sha} after ${waitMinutes} minutes (${verdict.message}). Nothing was published. When CI is green, run finalize again.`)
  await sleep(Math.min(30_000, Math.max(1000, deadline - Date.now())))
}

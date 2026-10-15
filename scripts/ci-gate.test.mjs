// scripts/ci-gate.mjs against a fake GitHub API: a push run of CI on the commit, or the Release run's own CI jobs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitForCi } from './ci-gate.mjs'

const SHA = 'a'.repeat(40)
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms } } }

test('push mode: waits while CI runs, passes when it passed on exactly that commit', async () => {
  let calls = 0
  const gh = (path) => {
    assert.match(path, new RegExp(`workflows/ci\\.yml/runs\\?head_sha=${SHA}&event=push`))
    calls++
    const status = calls < 3 ? 'in_progress' : 'completed'
    return { workflow_runs: [{ head_sha: SHA, event: 'push', status, conclusion: status === 'completed' ? 'success' : null, html_url: 'https://ci' }, { head_sha: 'b'.repeat(40), event: 'push', status: 'completed', conclusion: 'success' }] }
  }
  const r = await waitForCi({ sha: SHA, repo: 'o/r', gh, log: () => {}, ...clock() })
  assert.deepEqual(r, { ok: true, message: 'CI passed: https://ci' })
  assert.equal(calls, 3)
})

test('push mode: no run in time is a timeout, a failed run a failure', async () => {
  const none = await waitForCi({ sha: SHA, repo: 'o/r', waitMinutes: 1, gh: () => ({ workflow_runs: [] }), log: () => {}, ...clock() })
  assert.equal(none.ok, false)
  assert.equal(none.timedOut, true)
  const failed = await waitForCi({ sha: SHA, repo: 'o/r', gh: () => ({ workflow_runs: [{ head_sha: SHA, event: 'push', status: 'completed', conclusion: 'failure', html_url: 'u' }] }), log: () => {}, ...clock() })
  assert.equal(failed.ok, false)
  assert.match(failed.message, /CI concluded failure/)
})

test('run mode: reads the Release run and its latest jobs, passes on its green ci / jobs', async () => {
  const seen = []
  const gh = (path) => {
    seen.push(path)
    if (path === 'repos/o/r/actions/runs/42') return { id: 42, path: '.github/workflows/release-all.yml', head_branch: 'main', html_url: 'https://run' }
    assert.match(path, /^repos\/o\/r\/actions\/runs\/42\/jobs\?filter=latest&per_page=100&page=1$/)
    return { jobs: ['server (ubuntu-latest)', 'client (ubuntu-latest)', 'end-to-end', 'release scripts and restore drill', 'android'].map((n) => ({ name: `ci / ${n}`, status: 'completed', conclusion: 'success' })) }
  }
  const r = await waitForCi({ sha: SHA, repo: 'o/r', run: '42', gh, log: () => {}, ...clock() })
  assert.equal(r.ok, true, r.message)
  assert.equal(seen.length, 2)
})

test('a GitHub error is a wait, not a pass', async () => {
  const r = await waitForCi({ sha: SHA, repo: 'o/r', waitMinutes: 1, gh: () => { throw Object.assign(new Error('HTTP 502'), { stderr: 'gh: HTTP 502' }) }, log: () => {}, ...clock() })
  assert.equal(r.ok, false)
  assert.match(r.message, /couldn't ask GitHub \(gh: HTTP 502\)/)
})

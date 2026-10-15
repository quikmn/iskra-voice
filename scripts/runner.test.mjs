// The home PC runner: the job guard it runs before every job (scripts/runner-job-guard.ps1, with fake job
// environments) and what scripts/runner-setup.ps1 installs (pinned, checked, our label only, not elevated).
// Needs PowerShell 7 (pwsh) for the guard; skipped where it isn't installed. Registers nothing.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const guard = join(here, 'runner-job-guard.ps1')
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0
const skip = hasPwsh ? false : 'pwsh is not installed'

// A job as GitHub describes it to the runner: the Release workflow's Windows build, started by the owner on main.
const RELEASE_JOB = {
  GITHUB_REPOSITORY: 'quikmn/iskra-voice',
  GITHUB_REPOSITORY_ID: '1227290412',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: 'quikmn/iskra-voice/.github/workflows/release-all.yml@refs/heads/main',
  GITHUB_ACTOR: 'quikmn',
  GITHUB_TRIGGERING_ACTOR: 'quikmn',
  GITHUB_JOB: 'windows',
  GITHUB_RUN_ID: '123',
}

function runGuard(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_')))
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete clean[k]; else clean[k] = v
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', guard], { encoding: 'utf8', env: clean })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

test("the guard lets the Release workflow's own jobs run", { skip }, () => {
  for (const job of ['pc-checks', 'windows', 'play-pc']) {
    const r = runGuard({ ...RELEASE_JOB, GITHUB_JOB: job })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /Runner guard: ok/)
  }
})

test('the guard refuses pull requests, forks, other branches, workflows, jobs and people', { skip }, () => {
  const cases = {
    'a pull request': { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' },
    'pull_request_target': { GITHUB_EVENT_NAME: 'pull_request_target' },
    'a push': { GITHUB_EVENT_NAME: 'push' },
    'another branch': { GITHUB_REF: 'refs/heads/evil', GITHUB_WORKFLOW_REF: 'quikmn/iskra-voice/.github/workflows/release-all.yml@refs/heads/evil' },
    'a tag': { GITHUB_REF: 'refs/tags/v9.9.9' },
    'another workflow': { GITHUB_WORKFLOW_REF: 'quikmn/iskra-voice/.github/workflows/ci.yml@refs/heads/main' },
    'a look-alike workflow': { GITHUB_WORKFLOW_REF: 'quikmn/iskra-voice/.github/workflows/release-all.yml@refs/heads/main-x' },
    'a fork': { GITHUB_REPOSITORY: 'someone/iskra-voice', GITHUB_REPOSITORY_ID: '999' },
    'another job': { GITHUB_JOB: 'build' },
    'someone else': { GITHUB_ACTOR: 'someone' },
    'a re-run by someone else': { GITHUB_TRIGGERING_ACTOR: 'someone' },
    'case games': { GITHUB_ACTOR: 'QUIKMN' },
    'nothing set': { GITHUB_REPOSITORY: undefined, GITHUB_EVENT_NAME: undefined, GITHUB_JOB: undefined },
  }
  for (const [what, change] of Object.entries(cases)) {
    const r = runGuard({ ...RELEASE_JOB, ...change })
    assert.equal(r.code, 1, `${what}: ${r.out}`)
    assert.match(r.out, /only runs the Release workflow's own jobs.*Refused:/, what)
  }
})

test("the guard's job ids are exactly the jobs of release-all.yml that run on the home PC", () => {
  const workflow = readFileSync(join(here, '../.github/workflows/release-all.yml'), 'utf8')
  const onPc = [...workflow.matchAll(/^ {2}([a-z0-9-]+):\n(?:(?! {2}[a-z0-9-]+:\n)[\s\S])*?^ {4}runs-on: \[iskra-windows-signing\]/gm)].map((m) => m[1])
  const allowed = /\$jobs = @\(([^)]*)\)/.exec(readFileSync(guard, 'utf8'))[1].split(',').map((s) => s.trim().replace(/'/g, ''))
  assert.deepEqual(onPc.sort(), allowed.sort())
})

test('runner-setup.ps1: the official runner, pinned and SHA-256 checked, only our label, as the owner without admin rights', () => {
  const text = readFileSync(join(here, 'runner-setup.ps1'), 'utf8')
  const version = /\$runnerVersion = '(\d+\.\d+\.\d+)'/.exec(text)?.[1]
  assert.ok(version, 'a pinned version')
  assert.match(text, /\$runnerSha256 = '[0-9a-f]{64}'/)
  assert.match(text, /https:\/\/github\.com\/actions\/runner\/releases\/download\/v\$runnerVersion\/actions-runner-win-x64-\$runnerVersion\.zip/)
  assert.match(text, /Get-FileHash \$zip -Algorithm SHA256/)
  assert.ok(text.indexOf('Get-FileHash') < text.indexOf('Expand-Archive'), 'checked before unpacking')
  assert.match(text, /--labels \$label --no-default-labels/)
  assert.match(text, /\$label = 'iskra-windows-signing'/)
  assert.match(text, /ACTIONS_RUNNER_HOOK_JOB_STARTED=/)
  assert.match(text, /runner-job-guard\.ps1/)
  assert.match(text, /-RunLevel Limited/)
  assert.match(text, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/)
  assert.doesNotMatch(text, /--runasservice|New-NetFirewallRule|netsh/, 'no service, no firewall rule (outbound only, listens on nothing)')
  assert.match(text, /registration-token/)
  assert.match(text, /remove-token/)
})

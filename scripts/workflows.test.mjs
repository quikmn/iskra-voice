// The workflows' safety rules, offline: the home PC runner's label is used only by the Release workflow's guarded
// jobs, the Release workflow starts only by hand, every action is pinned to a full commit SHA, and actionlint passes
// (when it's installed; CI's runners don't have it, the PC does).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = join(root, '.github', 'workflows')
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
const read = (f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n')
const LABEL = 'iskra-windows-signing'
const GUARD = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.actor == github.repository_owner && github.triggering_actor == github.repository_owner"

/** The jobs of a workflow: id → its text (two-space-indented keys under `jobs:`). */
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7)
  const out = {}
  const re = /^ {2}([a-z0-9-]+):\n/gm
  const marks = [...body.matchAll(re)]
  marks.forEach((m, i) => { out[m[1]] = body.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : undefined) })
  return out
}

test('only the Release workflow uses the home PC runner, and each of those jobs carries the owner/main/dispatch guard', () => {
  for (const f of files) {
    const text = read(f)
    if (f !== 'release-all.yml') { assert.ok(!text.includes(LABEL), `${f} must not use the ${LABEL} runner`); continue }
    const onPc = Object.entries(jobs(text)).filter(([, body]) => body.includes(LABEL))
    assert.deepEqual(onPc.map(([id]) => id).sort(), ['pc-checks', 'play-pc', 'windows'])
    for (const [id, body] of onPc) {
      const cond = /^ {4}if: (.+)$/m.exec(body)?.[1] ?? ''
      assert.ok(cond.includes(GUARD), `${id}'s if: has the guard`)
      assert.doesNotMatch(cond, /\|\|\s*github\.(event_name|actor|ref)/, `${id}: nothing ORs around the guard`)
      assert.match(body, /^ {4}runs-on: \[iskra-windows-signing\]$/m, `${id} asks for the label only (no self-hosted/windows labels)`)
      assert.doesNotMatch(body, /persist-credentials: true/)
    }
  }
})

test('the Release workflow starts only by hand: no pull_request, push, schedule or workflow_run triggers; one at a time', () => {
  const text = read('release-all.yml')
  const on = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:'))
  assert.match(on, /^ {2}workflow_dispatch:$/m)
  assert.doesNotMatch(on, /pull_request|push:|schedule:|workflow_run|repository_dispatch|workflow_call/)
  assert.match(text, /^permissions: \{\}$/m)
  assert.match(text, /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false$/m)
  // Every gate before the first change: the version job needs both check jobs.
  assert.match(jobs(text).version, /needs: \[checks, pc-checks\]/)
  assert.match(jobs(text).finalize, /ci_run: \$\{\{ github\.run_id \}\}/)
})

test('every action is pinned to a full commit SHA with its version as a comment', () => {
  for (const f of files) {
    for (const m of read(f).matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)) {
      const [, ref, rest] = m
      if (ref.startsWith('./')) continue
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${ref}`)
      assert.match(rest, /# v\d/, `${f}: ${ref} has a version comment`)
    }
  }
})

test('workflows called by the Release workflow accept the call', () => {
  for (const f of ['ci.yml', 'release.yml', 'release-finalize.yml']) assert.match(read(f), /^ {2}workflow_call:$/m, f)
  assert.match(read('ci.yml'), /ref: \$\{\{ inputs\.ref \}\}/)
})

const actionlint = spawnSync('actionlint', ['-version']).status === 0
test('actionlint passes on every workflow', { skip: actionlint ? false : 'actionlint is not installed' }, () => {
  // shellcheck off: CI's runners have it and this machine doesn't; the result must not depend on where it runs.
  const r = spawnSync('actionlint', ['-shellcheck=', '-pyflakes='], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
})

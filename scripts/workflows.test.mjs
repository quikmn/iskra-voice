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
// The composite actions (.github/actions/<name>/action.yml): one copy each of the release upload, the TestFlight upload
// and the App Store Connect step, used by several workflows.
const actionsDir = join(root, '.github', 'actions')
const actions = readdirSync(actionsDir).map((d) => join('actions', d, 'action.yml'))
const readAction = (name) => readFileSync(join(actionsDir, name, 'action.yml'), 'utf8').replace(/\r\n/g, '\n')
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

test('every action is pinned to a full commit SHA with its version as a comment (workflows and composite actions)', () => {
  const texts = [...files.map((f) => [f, read(f)]), ...actions.map((a) => [a, readFileSync(join(root, '.github', a), 'utf8')])]
  assert.ok(actions.length >= 3, 'the composite actions are there')
  for (const [f, text] of texts) {
    for (const m of text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)) {
      const [, ref, rest] = m
      if (ref.startsWith('./')) { assert.ok(actions.includes(join(ref.slice(10), 'action.yml')) || ref.startsWith('./.github/workflows/'), `${f}: ${ref} exists`); continue }
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${ref}`)
      assert.match(rest, /# v\d/, `${f}: ${ref} has a version comment`)
    }
  }
})

test('release.yml: each build job attaches its own files through the shared action, the SBOMs come from it, the web app is kept for deploy.yml', () => {
  const text = read('release.yml')
  const j = jobs(text)
  assert.deepEqual(Object.keys(j), ['linux', 'linux-arm64', 'mac', 'sbom', 'publish'])
  for (const id of Object.keys(j)) {
    assert.match(j[id], /contents: write/, `${id} may upload to the release`)
    assert.match(j[id], /id-token: write/, `${id} attests`)
    assert.match(j[id], /uses: \.\/\.github\/actions\/release-attach/, `${id} attaches through the shared action`)
    assert.doesNotMatch(j[id], /gh release (upload|create)/, `${id} has no upload of its own`)
  }
  assert.match(j.sbom, /CycloneDX/)
  assert.match(j.linux, /name: webapp\n\s+path: client\/dist\n\s+include-hidden-files: true/)
  // The linux-arm64 tarball reaches the release only after it ran on an ARM machine.
  assert.match(j['linux-arm64'], /needs: linux\n/)
  assert.ok(j['linux-arm64'].indexOf('Run the programs in the bundle') < j['linux-arm64'].indexOf('release-attach'))
  // actions/checkout empties a workspace that isn't a git repository: jobs that download artifacts into the workspace
  // check out first (the local action must be there anyway).
  for (const id of ['linux-arm64', 'publish']) assert.ok(j[id].indexOf('actions/checkout@') < j[id].indexOf('actions/download-artifact@'), `${id} checks out before downloading`)
  // publish only merges the two Mac update files (checked against the attached zips and dmgs), so it needs the mac jobs only.
  assert.match(j.publish, /needs: mac\n/)
  assert.match(j.publish, /gh release download "\$TAG" --pattern 'Iskra-\*-mac-\*'/)
  assert.match(j.publish, /merge-yml/)
  // The shared action makes the draft only when none is there and checks each upload's size.
  const attach = readAction('release-attach')
  assert.match(attach, /gh release view "\$TAG" > \/dev\/null 2>&1/)
  assert.match(attach, /gh release create "\$TAG" --draft --prerelease --verify-tag/)
  assert.match(attach, /attest-build-provenance/)
  assert.match(attach, /isn't on the release with \$size bytes/)
})

test('release-finalize.yml: SBOMs are expected, not made; TestFlight runs beside the deploys and never gates publish', () => {
  const text = read('release-finalize.yml')
  const j = jobs(text)
  assert.deepEqual(Object.keys(j), ['publish', 'deploy', 'testflight', 'testflight-groups'])
  assert.match(text, /^run-name: Release finalize \$\{\{ inputs\.tag \}\}$/m)
  assert.doesNotMatch(j.publish, /name: SBOMs|dotnet tool install CycloneDX|cyclonedx-npm/)
  assert.match(j.publish, /release-assets\.mjs check/)
  assert.match(j.deploy, /needs: publish\n/)
  // A called workflow's job can't have more than its caller grants: the webapp job reads release.yml's artifact.
  assert.match(j.deploy, /permissions:\n\s+contents: read\n\s+actions: read/)
  assert.match(j.testflight, /needs: publish\n/)
  assert.match(j.testflight, /if: inputs\.testflight\n/)
  assert.match(j.testflight, /actions: read/)
  assert.match(j.testflight, /gh run list --workflow mobile-ios\.yml --branch "\$TAG" --event push/)
  assert.match(j.testflight, /gh run download "\$RUN" --name "iskra-ios-\$TAG"/)
  assert.match(j.testflight, /uses: \.\/\.github\/actions\/testflight-upload/)
  assert.match(j.testflight, /release\.ps1 -Phones/)
  assert.match(j['testflight-groups'], /needs: testflight\n/)
  assert.match(j['testflight-groups'], /uses: \.\/\.github\/actions\/appstore-connect/)
  // Both inputs exist for the dispatch and the call; the Release workflow keeps its own TestFlight job.
  assert.equal((text.match(/^ {6}testflight:/gm) ?? []).length, 2)
  assert.match(jobs(read('release-all.yml')).finalize, /testflight: false/)
})

test('mobile-ios.yml: the tag push only builds; uploads come from workflow_dispatch (release.ps1 -Phones, by hand) through the shared actions', () => {
  const text = read('mobile-ios.yml')
  const j = jobs(text)
  const on = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:'))
  assert.match(on, /^ {2}push:\n {4}tags: \['v\*'\]$/m)
  assert.deepEqual(Object.keys(j), ['build', 'upload', 'groups'])
  assert.doesNotMatch(j.build, /altool|node scripts\/appstore\.mjs|<string>upload<\/string>/)
  for (const id of ['upload', 'groups']) assert.match(j[id], /^ {4}if: github\.event_name != 'push' && inputs\.upload$/m, `${id} never runs for a push`)
  assert.match(j.upload, /uses: \.\/\.github\/actions\/testflight-upload/)
  assert.match(j.groups, /uses: \.\/\.github\/actions\/appstore-connect/)
  // The artifact is named for the ref (iskra-ios-<tag>): finalize downloads it by that name; its numbers travel with it.
  assert.match(j.build, /artifact=iskra-ios-\$\{REF\/\/\\\/\/-\}/)
  assert.match(j.build, /ios-build\.env/)
  assert.match(j.build, /retention-days: 14/)
  // release.ps1 -Phones finds its run by this title.
  assert.match(text, /^run-name: \$\{\{ format\('Mobile iOS \{0\}\{1\}', inputs\.ref \|\| github\.ref_name, inputs\.upload && ' \(TestFlight\)' \|\| ''\) \}\}$/m)
})

test('the TestFlight upload and the App Store Connect step exist once, in the composite actions, and their keys never outlive the job', () => {
  const upload = readAction('testflight-upload')
  const groups = readAction('appstore-connect')
  assert.match(upload, /xcrun altool --upload-app --type ios --file "\$IPA" --apiKey "\$KEY_ID" --apiIssuer "\$ISSUER_ID"/)
  assert.match(groups, /node scripts\/appstore\.mjs "\$STORE"/)
  for (const f of files) {
    const t = read(f)
    assert.doesNotMatch(t, /altool/, `${f} uploads only through the action`)
    assert.doesNotMatch(t, /appstore\.mjs "\$STORE"/, `${f} runs appstore.mjs only through the action`)
  }
  for (const [name, a] of [['testflight-upload', upload], ['appstore-connect', groups]]) {
    assert.match(a, /- name: Remove the key\n\s+if: always\(\)\n\s+shell: bash\n\s+run: rm -rf /, `${name} removes its key`)
    assert.match(a, /using: composite/)
  }
  // ios-build.env is read line by line, never sourced.
  assert.doesNotMatch(upload, /source |\. "\$DIR/)
})

test('deploy.yml reuses the web app release.yml built for a tag, and builds from source otherwise', () => {
  const j = jobs(read('deploy.yml'))
  assert.match(j.webapp, /actions: read/)
  assert.match(j.webapp, /gh run list --workflow release\.yml --branch "\$tag" --event push/)
  assert.match(j.webapp, /gh run download "\$id" --name webapp --dir client\/dist/)
  assert.match(j.webapp, /test -s client\/dist\/\.well-known\/security\.txt/)
  assert.match(j.webapp, /if: steps\.built\.outputs\.reused != 'true'\n\s+run: npm ci/)
  assert.match(j.webapp, /if: steps\.built\.outputs\.reused != 'true'\n\s+run: npm run build/)
  assert.match(j.webapp, /name: Index asset/)
})

test('workflows called by the Release workflow accept the call', () => {
  for (const f of ['ci.yml', 'release.yml', 'release-finalize.yml']) assert.match(read(f), /^ {2}workflow_call:$/m, f)
  assert.match(read('ci.yml'), /ref: \$\{\{ inputs\.ref \}\}/)
})

test('end-to-end flakes: one retry on CI only, flaky tests reported, the nightly stress run never red for flakes alone', () => {
  const config = readFileSync(join(root, 'client', 'playwright.config.ts'), 'utf8')
  assert.match(config, /retries: process\.env\.CI \? 1 : 0/)
  assert.doesNotMatch(config, /failOnFlakyTests/)
  const ci = read('ci.yml')
  assert.match(jobs(ci)['e2e-shard'], /--reporter=list,blob,json/)
  assert.match(jobs(ci)['end-to-end'], /flaky: \$\{\{ steps\.tests\.outputs\.flaky \}\}/)
  assert.match(jobs(ci).report, /E2E_FLAKY: \$\{\{ needs\.end-to-end\.outputs\.flaky \}\}/)
  const stress = read('e2e-stress.yml')
  const on = stress.slice(stress.indexOf('\non:\n'), stress.indexOf('\npermissions:'))
  assert.match(on, /^ {2}schedule:$/m)
  assert.match(on, /^ {2}workflow_dispatch:$/m)
  assert.doesNotMatch(on, /push:|pull_request/)
  assert.match(jobs(stress).shard, /--repeat-each "\$REPEAT"/)
  assert.match(jobs(stress).shard, /e2e-shards\.mjs list \$\{\{ matrix\.shard \}\} 4/)
  assert.match(jobs(stress).report, /ci-notify\.mjs stress/)
  // The report never turns the run red: only the shards' own results do.
  assert.doesNotMatch(jobs(stress).report, /exit 1/)
})

test('every matrix reports on all its legs: fail-fast is off, so one OS failing never cancels the others', () => {
  for (const f of files) {
    for (const [id, body] of Object.entries(jobs(read(f)))) {
      if (!/^ {4}strategy:\n/m.test(body)) continue
      assert.match(body, /^ {4}strategy:\n {6}fail-fast: false\b/m, `${f} job ${id}: put "fail-fast: false" first under strategy`)
    }
  }
})

const actionlint = spawnSync('actionlint', ['-version']).status === 0
test('actionlint passes on every workflow', { skip: actionlint ? false : 'actionlint is not installed' }, () => {
  // shellcheck off: CI's runners have it and this machine doesn't; the result must not depend on where it runs.
  const r = spawnSync('actionlint', ['-shellcheck=', '-pyflakes='], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
})

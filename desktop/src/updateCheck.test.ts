import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpError } from 'builder-util-runtime'
// The providers electron-updater uses, run against a fake GitHub (they don't need Electron).
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider'
import { autoFeed, healState, STALE_DOWNLOAD_MS } from './updateCheck'
import type { GitHubRelease } from './platform'

const REPO = 'quikmn/iskra-voice'
const RUNNING = '2.0.0-alpha.16'

// GitHub on 2026-10-15 at 14:00 UTC: tags v2.0.0-alpha.17, .18 and .20 had draft releases (finalize refused), .19 was
// published. releases.atom lists every one of those tags, newest first; only published releases have files.
const FEED_TAGS = ['v2.0.0-alpha.20', 'v2.0.0-alpha.19', 'v2.0.0-alpha.18', 'v2.0.0-alpha.17', 'v2.0.0-alpha.16']
const PUBLISHED = ['v2.0.0-alpha.19', 'v2.0.0-alpha.16']
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/${REPO}/releases</id>
  <title>Release notes from iskra-voice</title>
${FEED_TAGS.map((tag) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <link rel="alternate" type="text/html" href="https://github.com/${REPO}/releases/tag/${tag}"/>
    <title>${tag}</title>
    <content type="html">notes</content>
  </entry>`).join('\n')}
</feed>`
const latestYml = (version: string) =>
  `version: ${version}\nfiles:\n  - url: Iskra-Setup-${version}.exe\n    sha512: abc\n    size: 1\npath: Iskra-Setup-${version}.exe\nsha512: abc\nreleaseDate: '2026-10-15T12:25:00.000Z'\n`
// What the releases API returns without a token: published releases only.
const apiReleases: GitHubRelease[] = PUBLISHED.map((tag) => ({ tag_name: tag, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, draft: false }))

/** github.com as the updater sees it: the feed, and latest.yml only in published releases. */
const fakeGitHub = {
  requested: [] as string[],
  async request(options: { hostname?: string; path?: string }): Promise<string> {
    const url = `https://${options.hostname}${(options.path ?? '').split('?')[0]}`
    this.requested.push(url)
    if (url === `https://github.com/${REPO}/releases.atom`) return feed
    const file = /\/releases\/download\/(v[^/]+)\/latest\.yml$/.exec(url)
    if (file && PUBLISHED.includes(file[1])) return latestYml(file[1].slice(1))
    throw new HttpError(404)
  },
}
// The parts of electron-updater's AppUpdater the providers read (as set up in updates.ts).
const updater = { allowPrerelease: true, channel: null, currentVersion: RUNNING, fullChangelog: false, isAddNoCacheQuery: false }
const runtime = { isUseMultipleRangeRequest: false, platform: 'win32' as const, executor: fakeGitHub as never }

test('regression: the GitHub feed picks a draft tag, so every automatic check failed while one was newest', async () => {
  // What alpha.16-alpha.21 did: autoUpdater.checkForUpdates() with the GitHub provider. The newest feed entry is
  // alpha.20's tag, whose release is a draft with no latest.yml: the check throws and nothing is found, although
  // alpha.19 is out. (The tray's check worked later only because alpha.21 was published and newest by then.)
  const github = new GitHubProvider({ provider: 'github', owner: 'quikmn', repo: 'iskra-voice' }, updater as never, runtime)
  await assert.rejects(github.getLatestVersion(), (e: { code?: string }) => e.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
  assert.ok(fakeGitHub.requested.some((u) => u.includes('/download/v2.0.0-alpha.20/')))
})

test('the fix: the release is picked from the published ones and the updater finds it', async () => {
  const target = autoFeed(apiReleases, RUNNING, REPO)
  assert.deepEqual(target, { version: '2.0.0-alpha.19', url: `https://github.com/${REPO}/releases/download/v2.0.0-alpha.19` })
  const generic = new GenericProvider({ provider: 'generic', url: target!.url }, updater as never, runtime)
  const info = await generic.getLatestVersion()
  assert.equal(info.version, '2.0.0-alpha.19')
  const [installer] = generic.resolveFiles(info)
  assert.equal(installer.url.href, `https://github.com/${REPO}/releases/download/v2.0.0-alpha.19/Iskra-Setup-2.0.0-alpha.19.exe`)
})

test('nothing newer published: no feed, so no check of a draft', () => {
  assert.equal(autoFeed(apiReleases, '2.0.0-alpha.19', REPO), null)
  assert.equal(autoFeed([{ ...apiReleases[0], draft: true }], RUNNING, REPO), null)
  assert.equal(autoFeed([{ ...apiReleases[0], html_url: 'https://evil.example/x' }], RUNNING, REPO), null)
})

test('a stuck or meaningless state is reset so the next check runs', () => {
  const now = 10 * STALE_DOWNLOAD_MS
  const fresh = now - 60_000
  const old = now - STALE_DOWNLOAD_MS
  // A download that never finished (its error lost, or the network stalled across sleep).
  assert.deepEqual(healState({ state: 'downloading', version: '2.0.0-alpha.19' }, old, now, RUNNING), { state: 'none' })
  assert.deepEqual(healState({ state: 'downloading', version: '2.0.0-alpha.19' }, fresh, now, RUNNING), { state: 'downloading', version: '2.0.0-alpha.19' })
  // Ready or available for the version we're running (or an older one): nothing to install.
  assert.deepEqual(healState({ state: 'ready', version: RUNNING }, fresh, now, RUNNING), { state: 'none' })
  assert.deepEqual(healState({ state: 'ready', version: '2.0.0-alpha.15' }, fresh, now, RUNNING), { state: 'none' })
  assert.deepEqual(healState({ state: 'available', version: RUNNING, url: 'https://github.com/x' }, fresh, now, RUNNING), { state: 'none' })
  // A real update waiting stays, however old.
  assert.deepEqual(healState({ state: 'ready', version: '2.0.0-alpha.19' }, 0, now, RUNNING), { state: 'ready', version: '2.0.0-alpha.19' })
  assert.deepEqual(healState({ state: 'none' }, 0, now, RUNNING), { state: 'none' })
})

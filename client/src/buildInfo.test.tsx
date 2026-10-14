import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BUILD_COMMIT, buildLabel } from './buildInfo'
import { shortCommit } from './commit'
import { RELEASE_VERSION } from './links'
import { BuildVersion } from './ui/safety/BuildVersion'

const noGit = () => null

describe('build version and commit', () => {
  it('takes the short commit from CI, Cloudflare or git, and says "dev" without one', () => {
    expect(shortCommit({ GITHUB_SHA: 'A89A580E0C0BF73A2E229AA351C231EAB5C0FFEE' }, () => 'e0c0bf7')).toBe('a89a580')
    expect(shortCommit({ CF_PAGES_COMMIT_SHA: 'e0c0bf7aa351c2' }, noGit)).toBe('e0c0bf7')
    expect(shortCommit({}, () => 'aa351c231eab5c0\n')).toBe('aa351c2')
    expect(shortCommit({}, noGit)).toBe('dev')
    expect(shortCommit({ GITHUB_SHA: 'not-a-sha' }, () => '<script>')).toBe('dev')
  })

  it('injects a 7-character commit or "dev" into the build', () => {
    expect(BUILD_COMMIT).toMatch(/^([0-9a-f]{7}|dev)$/)
    expect(buildLabel()).toBe(`${RELEASE_VERSION} · ${BUILD_COMMIT}`)
    expect(buildLabel('2.0.0-alpha.14', 'a89a580')).toBe('2.0.0-alpha.14 · a89a580')
  })

  it('shows the version and commit in About & legal, with a copy button', () => {
    const html = renderToStaticMarkup(<BuildVersion label="2.0.0-alpha.14 · a89a580" />)
    expect(html).toContain('Iskra 2.0.0-alpha.14 · a89a580')
    expect(html).toContain('aria-label="Copy version"')
  })
})

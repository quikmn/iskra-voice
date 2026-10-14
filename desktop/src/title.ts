// The window title always names the build: "Iskra 2.0.0-alpha.14 · a89a580", after what the page is showing.
// scripts/build-info.mjs writes the commit into dist/build-info.json at build time; without it the commit is "dev".
import { readFileSync } from 'node:fs'

const SHORT_SHA = /^[0-9a-f]{7}$/

export function readBuildCommit(file: string): string {
  try {
    const commit = (JSON.parse(readFileSync(file, 'utf8')) as { commit?: unknown }).commit
    return typeof commit === 'string' && SHORT_SHA.test(commit) ? commit : 'dev'
  } catch {
    return 'dev'
  }
}

/**
 * "Iskra" → "Iskra 2.0.0-alpha.14 · a89a580"; "(3) Iskra" → "(3) Iskra 2.0.0-alpha.14 · a89a580";
 * "My settings — Iskra" → "My settings — Iskra 2.0.0-alpha.14 · a89a580"; anything else gets " — Iskra …" added.
 * With a note: "Iskra 2.0.0-alpha.14 · a89a580 · Update ready".
 */
export function windowTitle(pageTitle: string, version: string, commit: string, note?: string): string {
  // A waiting update shows here too ("… · a89a580 · Update ready"), so it's visible even with the app in the background.
  const build = `Iskra ${version} · ${commit}${note ? ` · ${note.slice(0, 40)}` : ''}`
  const page = pageTitle.trim().slice(0, 200)
  if (!page) return build
  if (page === 'Iskra') return build
  if (page.endsWith(' Iskra')) return `${page.slice(0, -'Iskra'.length)}${build}`
  return `${page} — ${build}`
}

// Writes dist/build-info.json: the commit this build is made from, shown in the window title (src/title.ts).
// CI's GITHUB_SHA, else `git rev-parse HEAD`, else "dev". Run by `npm run build`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHORT_SHA = /^[0-9a-f]{7}$/
const short = (sha) => {
  const s = sha?.trim().toLowerCase().slice(0, 7)
  return s && SHORT_SHA.test(s) ? s : null
}
const git = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

const commit = short(process.env.GITHUB_SHA) ?? short(git()) ?? 'dev'
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
mkdirSync(dist, { recursive: true })
writeFileSync(join(dist, 'build-info.json'), JSON.stringify({ commit }) + '\n')
console.log(`build-info: ${commit}`)

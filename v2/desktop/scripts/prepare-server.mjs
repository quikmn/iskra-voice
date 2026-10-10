// Puts a self-contained iskra-server and livekit-server into build/server for packaging.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const v2 = resolve(here, '..', '..')
const out = resolve(here, '..', 'build', 'server')
const windows = process.platform === 'win32'
const rid = windows ? 'win-x64' : process.platform === 'darwin' ? 'osx-arm64' : 'linux-x64'

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
execFileSync('dotnet', [
  'publish', join(v2, 'server', 'src', 'Iskra.Server'), '-c', 'Release', '-r', rid, '--self-contained',
  '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true', '-p:DebugType=none', '-o', out,
], { stdio: 'inherit' })

const livekit = join(v2, '.tools', windows ? 'livekit-server.exe' : 'livekit-server')
if (!existsSync(livekit)) throw new Error(`Missing ${livekit}: run v2/scripts/get-livekit first.`)
copyFileSync(livekit, join(out, windows ? 'livekit-server.exe' : 'livekit-server'))
console.log(`Server bundle ready in ${out}`)

// Puts a self-contained iskra-server and livekit-server into build/server-<os>-<arch> for packaging.
// Usage: node scripts/prepare-server.mjs [rid ...]   e.g. win-x64, linux-x64, osx-arm64, osx-x64 (default: this machine)
// LiveKit comes from .tools/<rid>/ (scripts/get-livekit.sh <rid>), or .tools/ for this machine's own platform.
// ISKRA_UNSIGNED=1 skips signing the Windows server binary.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const hostRid = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const rids = process.argv.length > 2 ? process.argv.slice(2) : [hostRid]

for (const rid of rids) {
  const match = /^(win|osx|linux)-(x64|arm64)$/.exec(rid)
  if (!match) throw new Error(`Unknown runtime id ${rid}`)
  const windows = match[1] === 'win'
  // Named the way electron-builder expands build/server-${os}-${arch} (win/mac/linux).
  const out = resolve(here, '..', 'build', `server-${match[1] === 'osx' ? 'mac' : match[1]}-${match[2]}`)
  const exe = (name) => (windows ? `${name}.exe` : name)

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  execFileSync('dotnet', [
    'publish', join(root, 'server', 'src', 'Iskra.Server'), '-c', 'Release', '-r', rid, '--self-contained',
    '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true', '-p:DebugType=none', '-o', out,
  ], { stdio: 'inherit' })

  const livekit = [join(root, '.tools', rid, exe('livekit-server')), ...(rid === hostRid ? [join(root, '.tools', exe('livekit-server'))] : [])].find(existsSync)
  if (!livekit) throw new Error(`Missing livekit-server for ${rid}: run scripts/get-livekit first.`)
  copyFileSync(livekit, join(out, exe('livekit-server')))
  if (!windows) {
    chmodSync(join(out, 'iskra-server'), 0o755)
    chmodSync(join(out, 'livekit-server'), 0o755)
  }
  if (windows && process.platform === 'win32' && !process.env.ISKRA_UNSIGNED) {
    // Sign our own server binary (LiveKit ships as-is from its project). Without PowerShell 7's module path, so
    // Windows PowerShell loads its own certificate cmdlets.
    const { PSModulePath: _, ...env } = process.env
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'sign.ps1'), join(out, 'iskra-server.exe')], { stdio: 'inherit', env })
  }
  console.log(`Server bundle for ${rid} ready in ${out}`)
}

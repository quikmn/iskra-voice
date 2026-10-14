// Build step (release-windows.ps1, release.yml), called by scripts/release.ps1; not run by hand to ship.
// Builds iskra-p2p, the standalone server's peer-to-peer tunnel (src/p2p/sidecarMain.ts, the same tunnel code the
// desktop app runs), as ONE executable per platform: a Node single executable application (SEA) holding the bundled
// JS and the two native addons (udx-native, sodium-native) as assets. It goes into the server archives next to
// iskra-server, not into the desktop app (which runs the tunnel in its own main process).
//
//   node scripts/build-sidecar.mjs [rid ...]        win-x64, linux-x64, linux-arm64, osx-arm64, osx-x64 (default: this machine)
//                                                   → build/p2p-<os>-<arch>/iskra-p2p[.exe] + iskra-p2p-licenses.txt
//   node scripts/build-sidecar.mjs --bundle <file>  only the bundled JS, loading the addons from node_modules
//                                                   (tests run it with node; nothing new is copied)
//
// The Node binary is this one for its own platform; for another, the same Node version from nodejs.org, checked
// against its SHASUMS256.txt. Windows: signed with sign.ps1 unless ISKRA_UNSIGNED=1. macOS: ad-hoc signed, or with
// ISKRA_MAC_IDENTITY (must run on a Mac).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const require = createRequire(join(desktop, 'package.json'))
const ENTRY = join(desktop, 'src', 'p2p', 'sidecarMain.ts')
const ADDONS = ['udx-native', 'sodium-native']
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const hostRid = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`

/** In a SEA build, each addon comes out of the executable into a private temporary folder and is loaded from there. */
const SEA_ADDON_LOADER = `
const __iskraAddon = (() => {
  const sea = require('node:sea'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  let dir = null
  return (name) => {
    if (!dir) {
      // Leftovers of earlier runs on Windows (it can't delete a loaded addon); ones still in use stay locked.
      if (process.platform === 'win32') for (const old of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('iskra-p2p-addons-'))) {
        try { fs.rmSync(path.join(os.tmpdir(), old), { recursive: true, force: true }) } catch {}
      }
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskra-p2p-addons-')) // random name, owner-only
      process.once('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
    }
    const file = path.join(dir, name + '.node')
    fs.writeFileSync(file, Buffer.from(sea.getRawAsset(name + '.node')), { mode: 0o600, flag: 'wx' })
    const m = { exports: {} }
    process.dlopen(m, file)
    if (process.platform !== 'win32') fs.rmSync(file, { force: true })
    return m.exports
  }
})();
`

/** Bundles the sidecar into one CommonJS file. `sea`: addons from the executable, else from node_modules. */
export async function bundleSidecar(outfile, { sea = false } = {}) {
  const esbuild = require('esbuild')
  const addonPlugin = {
    name: 'iskra-addons',
    setup(build) {
      build.onLoad({ filter: /[\\/](udx-native|sodium-native)[\\/]binding\.js$/ }, (args) => {
        const name = ADDONS.find((a) => args.path.replace(/\\/g, '/').includes(`/${a}/binding.js`))
        const contents = sea
          ? `module.exports = __iskraAddon(${JSON.stringify(name)})`
          : `const original = ${JSON.stringify(args.path)}\nmodule.exports = require(original)`
        return { contents, loader: 'js' }
      })
    },
  }
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    conditions: ['node'],
    banner: sea ? { js: SEA_ADDON_LOADER } : undefined,
    plugins: [addonPlugin],
    metafile: true,
    logLevel: 'warning',
    logOverride: { 'indirect-require': 'silent' },
  })
  return result.metafile
}

/** The packages in a bundle and their licence texts, for iskra-p2p-licenses.txt. */
function bundledLicences(metafile) {
  const packages = new Map()
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(input)
    if (!match) continue
    const dir = resolve(desktop, match[1])
    if (packages.has(dir)) continue
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f))
    packages.set(dir, `${pkg.name} ${pkg.version} (${pkg.license ?? 'see text'})\n\n${file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${pkg.license}`}`)
  }
  for (const addon of ADDONS) {
    const dir = dirname(require.resolve(`${addon}/package.json`))
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    packages.set(dir, `${pkg.name} ${pkg.version} (${pkg.license}; native addon)\n\n${readFileSync(join(dir, 'LICENSE'), 'utf8').trim()}`)
  }
  return [...packages.values()].sort()
}

/**
 * Removes the Authenticode signature of a Windows executable (Node's own, which the injection would break), so it
 * can be signed as ours: what `signtool remove /s` does. The certificate table sits at the end of the file.
 */
function stripPeSignature(file) {
  const pe = readFileSync(file)
  const header = pe.readUInt32LE(0x3c)
  if (pe.toString('latin1', header, header + 4) !== 'PE\0\0') throw new Error(`${file} isn't a PE file`)
  const optional = header + 24
  const directories = optional + (pe.readUInt16LE(optional) === 0x20b ? 112 : 96) // PE32+ or PE32
  const security = directories + 4 * 8
  const offset = pe.readUInt32LE(security)
  const size = pe.readUInt32LE(security + 4)
  if (!offset || !size) return
  if (offset + size !== pe.length) throw new Error(`${file}: the signature isn't at the end of the file`)
  pe.writeUInt32LE(0, security)
  pe.writeUInt32LE(0, security + 4)
  writeFileSync(file, pe.subarray(0, offset))
}

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** The Node binary for a target and its licence: this process's own, or the same version from nodejs.org. */
async function nodeFor(rid, work) {
  const [os, arch] = rid.split('-')
  const nodeOs = os === 'win' ? 'win' : os === 'osx' ? 'darwin' : 'linux'
  const licenceNear = (bin) => [join(dirname(bin), 'LICENSE'), join(dirname(bin), '..', 'LICENSE')].find(existsSync)
  if (rid === hostRid) {
    const licence = licenceNear(process.execPath)
    return { binary: process.execPath, licence: licence ? readFileSync(licence, 'utf8') : (await download(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`)).toString('utf8') }
  }
  if (nodeOs === 'win') throw new Error('Build the Windows sidecar on Windows.')
  const name = `node-${process.version}-${nodeOs}-${arch}`
  const base = `https://nodejs.org/dist/${process.version}`
  const sums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8')
  const archive = await download(`${base}/${name}.tar.gz`)
  const expected = sums.split('\n').find((l) => l.endsWith(`  ${name}.tar.gz`))?.split(' ')[0]
  const actual = createHash('sha256').update(archive).digest('hex')
  if (!expected || expected !== actual) throw new Error(`${name}.tar.gz: SHA-256 ${actual} doesn't match SHASUMS256.txt (${expected})`)
  const file = join(work, `${name}.tar.gz`)
  writeFileSync(file, archive)
  execFileSync('tar', ['-xzf', file, '-C', work, `${name}/bin/node`, `${name}/LICENSE`], { stdio: 'inherit' })
  return { binary: join(work, name, 'bin', 'node'), licence: readFileSync(join(work, name, 'LICENSE'), 'utf8') }
}

async function buildSea(rid) {
  const match = /^(win|osx|linux)-(x64|arm64)$/.exec(rid)
  if (!match) throw new Error(`Unknown runtime id ${rid}`)
  const [, os, arch] = match
  const windows = os === 'win'
  const target = `${os === 'win' ? 'win32' : os === 'osx' ? 'darwin' : 'linux'}-${arch}`
  const out = join(desktop, 'build', `p2p-${os === 'osx' ? 'mac' : os}-${arch}`)
  const exe = join(out, windows ? 'iskra-p2p.exe' : 'iskra-p2p')
  const work = mkdtempSync(join(tmpdir(), 'iskra-sidecar-build-'))
  try {
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    const bundle = join(work, 'sidecar.cjs')
    const metafile = await bundleSidecar(bundle, { sea: true })
    const assets = Object.fromEntries(ADDONS.map((a) => {
      const file = join(dirname(require.resolve(`${a}/package.json`)), 'prebuilds', target, `${a}.node`)
      if (!existsSync(file)) throw new Error(`${a} has no prebuild for ${target}`)
      return [`${a}.node`, file]
    }))
    const blob = join(work, 'sea.blob')
    writeFileSync(join(work, 'sea-config.json'), JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }))
    execFileSync(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')], { stdio: 'inherit' })

    const node = await nodeFor(rid, work)
    copyFileSync(node.binary, exe)
    if (!windows) chmodSync(exe, 0o755)
    if (windows) stripPeSignature(exe)
    if (os === 'osx') {
      if (process.platform !== 'darwin') throw new Error('Build the macOS sidecar on a Mac (it must be signed there).')
      execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' })
    }
    const { inject } = require('postject')
    await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), { sentinelFuse: SEA_FUSE, ...(os === 'osx' ? { machoSegmentName: 'NODE_SEA' } : {}), overwrite: true })
    if (os === 'osx') execFileSync('codesign', ['--sign', process.env.ISKRA_MAC_IDENTITY || '-', '--force', exe], { stdio: 'inherit' })
    if (windows && process.platform === 'win32' && !process.env.ISKRA_UNSIGNED) {
      const { PSModulePath: _, ...env } = process.env
      execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'sign.ps1'), exe], { stdio: 'inherit', env })
    }
    writeFileSync(join(out, 'iskra-p2p-licenses.txt'), [
      'iskra-p2p is Node.js running Iskra\'s peer-to-peer tunnel. It contains the following software.',
      `Node.js ${process.version}\n\n${node.licence.trim()}`,
      ...bundledLicences(metafile),
    ].join(`\n\n${'='.repeat(78)}\n\n`) + '\n')
    // A quick check where it can run: it starts and answers.
    if (rid === hostRid) {
      const version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim()
      if (version !== '1') throw new Error(`${basename(exe)} --version said ${JSON.stringify(version)}`)
    }
    console.log(`iskra-p2p for ${rid} ready in ${out}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args[0] === '--bundle') {
    if (!args[1]) throw new Error('--bundle needs an output file')
    await bundleSidecar(resolve(args[1]))
  } else {
    for (const rid of args.length ? args : [hostRid]) await buildSea(rid)
  }
}

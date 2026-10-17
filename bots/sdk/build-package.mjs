// Builds the npm package "iskra-bots" into sdk/dist: one ES module (the SDK with the app's core bundled in; libsodium
// and the optional voice packages stay dependencies) and its type declarations, plus the license.
//   node sdk/build-package.mjs          (or: npm run build:sdk, in bots/)
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const dist = join(here, 'dist')

// The package's dependencies are the ones bots/ is tested with (Dependabot updates bots/package.json).
const tested = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).dependencies
for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
  if (tested[name] !== version) throw new Error(`sdk/package.json has ${name}@${version}, bots/package.json ${tested[name]}: make them the same.`)
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist)

// The SDK, and the command line (npx iskra-bots bridge), sharing one chunk with the SDK.
await build({
  entryPoints: { index: join(here, 'src/index.ts'), cli: join(here, 'src/cli.ts') },
  outdir: dist,
  splitting: true,
  chunkNames: 'sdk-[hash]',
  define: { ISKRA_BOTS_VERSION: JSON.stringify(pkg.version) },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Installed next to the package: libsodium, and the voice packages (loaded only when a bot joins voice).
  external: [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})],
  banner: { js: `// ${pkg.name} ${pkg.version}. ${pkg.license}. ${pkg.homepage}` },
  legalComments: 'inline',
  logLevel: 'warning',
})

// Declarations: tsc from bots/ (it knows the SDK's and the app core's types), then one entry file.
// The package's own bin entry (TypeScript 7 doesn't export bin/tsc as a module path), run with this Node.
const tsPackage = createRequire(join(here, '..', 'package.json')).resolve('typescript/package.json')
const tsBin = JSON.parse(readFileSync(tsPackage, 'utf8')).bin
const tsc = join(dirname(tsPackage), typeof tsBin === 'string' ? tsBin : tsBin.tsc)
execFileSync(process.execPath, [tsc, '-p', join(here, 'tsconfig.build.json')], { stdio: 'inherit' })
if (!existsSync(join(dist, 'types/bots/sdk/src/index.d.ts'))) throw new Error('tsc did not write the declarations')
// Node's own ES module resolution ("moduleResolution": "nodenext") wants file extensions on relative imports.
const relative = /((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+?)(['"])/g
for (const entry of readdirSync(join(dist, 'types'), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue
  const file = join(entry.parentPath, entry.name)
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.replace(relative, (all, head, path, tail) => (path.endsWith('.js') ? all : `${head}${path}.js${tail}`)))
}
writeFileSync(join(dist, 'index.d.ts'), "export * from './types/bots/sdk/src/index.js'\n")

copyFileSync(join(here, '../../LICENSE'), join(here, 'LICENSE'))
console.log(`Built ${pkg.name} ${pkg.version} in sdk/dist.`)

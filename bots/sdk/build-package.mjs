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
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist)

await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: join(dist, 'index.js'),
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
const tsc = createRequire(join(here, '..', 'package.json')).resolve('typescript/bin/tsc')
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

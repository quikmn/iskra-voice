// Bundles the gallery bots that ship with the app (assets/gallery.json) into dist/gallery/<id>.cjs: one file each,
// with the bot SDK, the app's core and libsodium inside, so the app runs them with its own Node (ELECTRON_RUN_AS_NODE)
// and nothing to install. Run by `npm run build`. Needs ../client/node_modules (libsodium), like the client build.
import { build } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(desktop, '..')
const { bots } = JSON.parse(readFileSync(join(desktop, 'assets', 'gallery.json'), 'utf8'))

if (!existsSync(join(repo, 'client', 'node_modules', 'libsodium-wrappers-sumo')) && !existsSync(join(repo, 'bots', 'node_modules', 'libsodium-wrappers-sumo')))
  throw new Error('build-gallery: run "npm ci" in client/ first (the gallery bots bundle its libsodium).')

await build({
  entryPoints: bots.map((b) => ({ in: join(repo, 'bots', 'gallery', b.id, 'bot.ts'), out: b.id })),
  outdir: join(desktop, 'dist', 'gallery'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // The SDK by its npm name (as in a copied gallery folder); here, its source.
  alias: { 'iskra-bots': join(repo, 'bots', 'sdk', 'src', 'index.ts') },
  // libsodium: wherever it is installed (the app core resolves it from client/).
  nodePaths: [join(repo, 'client', 'node_modules'), join(repo, 'bots', 'node_modules')],
  legalComments: 'inline',
  logLevel: 'warning',
})
console.log(`build-gallery: ${bots.map((b) => b.id).join(', ')}`)

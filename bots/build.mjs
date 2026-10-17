// Bundles the SDK, its command line, its tests and the bots into dist/ for plain Node (22+). The SDK reuses the web client's core code
// (crypto, identity, connection), which esbuild pulls in from ../client/src/core.
//   node build.mjs               the SDK, every examples/*.ts and every gallery bot (gallery/<bot>/bot.ts → dist/gallery/<bot>.js)
//   node build.mjs my-bot.ts     also your own bot → dist/my-bot.js
import { build } from 'esbuild'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['libsodium-wrappers-sumo'], // resolved from bots/node_modules at runtime
  logLevel: 'warning',
  // Gallery bots import the SDK by its npm name (so a copied folder works with the npm package); here it's the source.
  alias: { 'iskra-bots': join(here, 'sdk/src/index.ts') },
}

await build({ ...shared, entryPoints: [join(here, 'sdk/src/index.ts')], outfile: join(here, 'dist/sdk.js') })
// The command line (node dist/cli.js bridge ...), and the SDK's tests (node --test "dist/test/*.test.js").
await build({ ...shared, entryPoints: [join(here, 'sdk/src/cli.ts')], outfile: join(here, 'dist/cli.js') })
const tests = readdirSync(join(here, 'sdk/test')).filter((f) => f.endsWith('.test.ts'))
await build({ ...shared, entryPoints: tests.map((f) => join(here, 'sdk/test', f)), outdir: join(here, 'dist/test') })
const examples = readdirSync(join(here, 'examples')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
await build({ ...shared, entryPoints: examples.map((f) => join(here, 'examples', f)), outdir: join(here, 'dist/examples') })
// The gallery: each folder's bot.ts, and its tests next to the SDK's (dist/test/gallery-<bot>-<name>.test.js).
const gallery = readdirSync(join(here, 'gallery'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(here, 'gallery', d.name, 'bot.ts')))
  .map((d) => d.name)
await build({ ...shared, entryPoints: gallery.map((name) => ({ in: join(here, 'gallery', name, 'bot.ts'), out: name })), outdir: join(here, 'dist/gallery') })
const galleryTests = gallery.flatMap((name) => readdirSync(join(here, 'gallery', name))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => ({ in: join(here, 'gallery', name, f), out: `gallery-${name}-${f.replace(/\.test\.ts$/, '')}.test` })))
await build({ ...shared, entryPoints: galleryTests, outdir: join(here, 'dist/test') })
for (const file of process.argv.slice(2)) {
  await build({ ...shared, entryPoints: [file], outfile: join(here, 'dist', basename(file).replace(/\.ts$/, '.js')) })
}
console.log(`Built dist/sdk.js, ${examples.length} example(s) and ${gallery.length} gallery bot(s).`)

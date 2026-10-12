// What's in each chunk: `npx vite build -c perf/bundle.config.ts --outDir <somewhere>` prints the biggest packages
// and folders per chunk (sizes before minifying) and which chunks the page loads first.
import type { Plugin, UserConfig } from 'vite'
import base from '../vite.config'

const stats = (): Plugin => ({
  name: 'iskra-bundle-stats',
  generateBundle(_options, bundle) {
    for (const [file, chunk] of Object.entries(bundle)) {
      if (chunk.type !== 'chunk') continue
      const groups = new Map<string, number>()
      let total = 0
      for (const [id, m] of Object.entries(chunk.modules)) {
        const path = id.replaceAll(String.fromCharCode(92), '/')
        const pkg = /node_modules\/((@[^/]+\/)?[^/]+)/.exec(path)
        const key = pkg ? `npm:${pkg[1]}` : path.replace(/.*\/client\/src\//, 'src/').replace(/\/[^/]+$/, '/')
        groups.set(key, (groups.get(key) ?? 0) + m.renderedLength)
        total += m.renderedLength
      }
      if (total < 50_000) continue
      console.log(`\n${file} ${Math.round(total / 1024)} KB${chunk.isEntry ? ' (entry)' : ''} imports: ${chunk.imports.join(', ') || '-'}`)
      for (const [key, n] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(Math.round(n / 1024)).padStart(5)} KB ${key}`)
    }
  },
})

const config = base as UserConfig
export default { ...config, plugins: [...(config.plugins ?? []), stats()] } satisfies UserConfig

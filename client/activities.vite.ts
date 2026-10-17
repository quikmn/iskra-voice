// The built-in activities (src/activities/<id>/main.ts) as one self-contained HTML file each, at /activities/<id>.html:
// the app loads them in a sandboxed frame (opaque origin, its own no-network policy), so everything is inline.
// Built with Vite itself; served on the fly by the dev server, emitted next to the app by `vite build`.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'vite'

export const BUILTIN_ACTIVITIES = ['draw', 'trivia', 'four'] as const

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

async function bundle(id: string): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      emptyOutDir: false,
      lib: { entry: here(`./src/activities/${id}/main.ts`), formats: ['iife'], name: 'IskraActivity', fileName: () => 'main.js' },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]) as { output: { type: string; code?: string }[] }[]
  const chunk = outputs.flatMap((o) => o.output).find((o) => o.type === 'chunk')
  if (!chunk?.code) throw new Error(`activity ${id}: no code`)
  return chunk.code
}

export async function activityHtml(id: string): Promise<string> {
  const [template, code] = await Promise.all([readFile(here('./src/activities/frame.html'), 'utf8'), bundle(id)])
  // Nothing in the code may end the inline script early.
  return template.replace('<!--script-->', () => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`)
}

export function activities(): Plugin {
  return {
    name: 'iskra-activities',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/activities\/([a-z]+)\.html(?:\?.*)?$/.exec(req.url ?? '')
        const id = match?.[1]
        if (!id || !(BUILTIN_ACTIVITIES as readonly string[]).includes(id)) return next()
        activityHtml(id).then((html) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(html)
        }, next)
      })
    },
    async generateBundle() {
      for (const id of BUILTIN_ACTIVITIES) this.emitFile({ type: 'asset', fileName: `activities/${id}.html`, source: await activityHtml(id) })
    },
  }
}

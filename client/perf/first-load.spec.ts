// First load of the built app: JS fetched and time until usable, for a new visitor and for a returning member.
import { expect, test, type Page } from '@playwright/test'
import { joinVia, startServer, type TestServer } from '../e2e/helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Perf Load')
})
test.afterAll(async () => server?.stop())

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

async function measure(page: Page, url: string, ready: () => Promise<void>, cpu: number) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
  const start = Date.now()
  await page.goto(url)
  await ready()
  const usable = Date.now() - start
  const nav = await page.evaluate(() => {
    const js = performance.getEntriesByType('resource').filter((e) => /\.js($|\?)/.test(e.name)) as PerformanceResourceTiming[]
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
    return { jsFiles: js.length, jsKB: Math.round(js.reduce((a, e) => a + e.decodedBodySize, 0) / 1024), dcl: Math.round(n.domContentLoadedEventEnd) }
  })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  await cdp.detach()
  return { usable, ...nav }
}

test('first load', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const rows: string[] = []
  for (const cpu of [1, 4]) {
    const fresh: Awaited<ReturnType<typeof measure>>[] = []
    const back: Awaited<ReturnType<typeof measure>>[] = []
    for (let i = 0; i < 5; i++) {
      const ctx = await browser.newContext()
      const p = await ctx.newPage()
      fresh.push(await measure(p, '/', () => expect(p.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible({ timeout: 60_000 }), cpu))
      await ctx.close()
      const again = await host.context().newPage()
      back.push(await measure(again, '/', () => expect(again.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 60_000 }), cpu))
      await again.close()
    }
    for (const [name, xs] of [['new visitor', fresh], ['returning member', back]] as const)
      rows.push(`cpu x${cpu} ${name}: js ${xs[0].jsFiles} files ${xs[0].jsKB} KB, DCL ${median(xs.map((x) => x.dcl))} ms, usable ${median(xs.map((x) => x.usable))} ms (runs ${xs.map((x) => x.usable).join(',')})`)
  }
  console.log('\n' + rows.join('\n'))
})

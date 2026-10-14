// "Connect without port forwarding" for a standalone server (no desktop app): the owner, in a browser, turns it on in
// Server settings → Internet access and the server starts its own tunnel (iskra-p2p, bundled the way the release
// bundles it and run with node), which announces the server on a private HyperDHT testnet on 127.0.0.1. The panel
// follows it from starting to ready, at desktop and phone width. Nothing touches the network.
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { joinVia, openServerSettings, SHOTS, startServer, type TestServer } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')

test.skip(!existsSync(join(DESKTOP, 'node_modules', 'hyperdht')), 'install desktop/ (npm ci) first: the tunnel lives there')

type Testnet = { bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }

let testnet: Testnet | null = null
let server: TestServer | null = null
let dir: string | null = null

test.afterAll(async () => {
  await server?.stop()
  await testnet?.destroy()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

test("a standalone server's owner turns on its own tunnel from the browser", async ({ page }) => {
  test.setTimeout(120_000)
  const createTestnet = createRequire(join(DESKTOP, 'package.json'))('hyperdht/testnet.js') as (size: number, opts: { host: string }) => Promise<Testnet>
  testnet = await createTestnet(3, { host: '127.0.0.1' })
  dir = mkdtempSync(join(tmpdir(), 'iskra-e2e-sidecar-'))
  const sidecar = join(dir, 'iskra-p2p.cjs')
  const build = (await import(pathToFileURL(join(DESKTOP, 'scripts', 'build-sidecar.mjs')).href)) as { bundleSidecar(out: string): Promise<unknown> }
  await build.bundleSidecar(sidecar)
  // The server finds its sidecar through ISKRA_P2P_SIDECAR and hands it the testnet (LocalOnly: 127.0.0.1 only).
  server = await startServer('Standalone box', false, {
    ISKRA_P2P_SIDECAR: sidecar,
    ISKRA_P2P_BOOTSTRAP: testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(','),
  })

  await joinVia(page, server.ownerLink(), 'Owner')
  const room = await openServerSettings(page, 'Internet access')
  const p2p = room.getByTestId('p2p-section')
  await expect(p2p).toHaveAttribute('data-state', 'off')
  await expect(p2p.getByText('This server runs the tunnel itself')).toBeVisible()
  await expect(p2p.getByTestId('p2p-privacy')).toContainText('peer-to-peer network')

  await p2p.getByRole('switch', { name: 'Let friends connect without port forwarding' }).click()
  await expect(p2p).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await expect(p2p.locator('[data-nat]')).toHaveAttribute('data-nat', /^(open|easy)$/, { timeout: 30_000 })
  await expect(p2p.getByText(/0 friends are connected this way/)).toBeVisible()
  await expect(p2p.getByRole('button', { name: 'New key' })).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'p2p-standalone.png'), animations: 'disabled' })

  // A new key: the tunnel announces it and stays ready.
  await p2p.getByRole('button', { name: 'New key' }).click()
  await expect(p2p).toHaveAttribute('data-state', 'ready')

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(p2p.getByRole('switch', { name: 'Let friends connect without port forwarding' })).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'p2p-standalone-phone.png'), animations: 'disabled' })

  // Off again: the tunnel goes.
  await p2p.getByRole('switch', { name: 'Let friends connect without port forwarding' }).click()
  await expect(p2p).toHaveAttribute('data-state', 'off')
})

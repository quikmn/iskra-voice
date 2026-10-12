// Electron check for background connections (npm run test:network; CI runs it on Windows, macOS and Linux). Starts Chromium the way the app does (same
// switches, the app's session privacy settings, a window with the app's web preferences and spellcheck), types into
// a text box so the spellchecker wakes up, waits, and reads Chromium's own network log: nothing may have asked for any
// host on the internet. Every host name fails to resolve here, so nothing ever leaves the machine either way.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { spellcheckDownloadsDictionaries } from './platform'
import { applyChromiumPrivacy, applySessionPrivacy } from './privacy'

const WAIT_MS = 12_000
const PROBE = 'netlog-probe.iskra.invalid'

/** Every host name the log mentions in a request or a lookup, apart from this machine's own. */
export function hostsIn(log: string): string[] {
  const hosts = new Set<string>()
  for (const m of log.matchAll(/"(?:url|host|original_url)":"([^"]+)"/g)) {
    let host = m[1]
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).hostname
    } catch {
      continue
    }
    host = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
    if (!host || host === 'localhost' || host === '~notfound' || /^(127\.|0\.0\.0\.0|::1$)/.test(host) || host.endsWith('.localhost')) continue
    hosts.add(host)
  }
  return [...hosts].sort()
}

/** In Electron: start like the app, type, wait, quit (Chromium finishes the log as it exits). */
async function child(log: string): Promise<void> {
  app.setPath('userData', path.join(path.dirname(log), 'user'))
  applyChromiumPrivacy(app)
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND')
  await app.whenReady()
  applySessionPrivacy(session.defaultSession)
  const window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: !spellcheckDownloadsDictionaries(process.platform), // as main.ts
  } })
  await window.loadURL('data:text/html,<!doctype html><textarea id=t lang=en-US autofocus></textarea>')
  await window.webContents.executeJavaScript("document.getElementById('t').focus()")
  window.webContents.insertText('Helo wrld, thsi is a speling tst. ')
  // The control: a request the page makes on purpose has to show up in the log.
  await window.webContents.executeJavaScript(`fetch('https://${PROBE}/').catch(() => null)`)
  await new Promise((r) => setTimeout(r, WAIT_MS))
  app.quit()
}

/** In Node: run the Electron part, then read the log it left. */
function parent(): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'iskra-netlog-'))
  const log = path.join(dir, 'net.json')
  const electron = require('electron') as unknown as string
  const result = spawnSync(electron, [__filename, `--log-net-log=${log}`, '--net-log-capture-mode=Everything', ...process.argv.slice(2)], { env: { ...process.env, ISKRA_NETLOG: log }, stdio: 'inherit', timeout: 60_000 })
  let text = ''
  try {
    text = readFileSync(log, 'utf8')
  } catch {
    /* none */
  }
  rmSync(dir, { recursive: true, force: true })
  const all = hostsIn(text)
  const hosts = all.filter((h) => h !== PROBE)
  if (result.status !== 0 || !text) {
    console.error(`network check: Electron exited with ${result.status}${text ? '' : ' and wrote no network log'}`)
    process.exitCode = 1
  } else if (!all.includes(PROBE)) {
    console.error('network check: the log is missing the probe request, so it proves nothing')
    process.exitCode = 1
  } else if (hosts.length) {
    console.error(`network check: FAILED, Chromium asked for ${hosts.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log(`network check: ok, no requests to the internet (${process.platform})`)
  }
}

if (process.versions.electron) {
  const log = process.env.ISKRA_NETLOG
  if (log) child(log).catch((error) => {
    console.error(error)
    process.exit(1)
  })
} else if (require.main === module) parent()

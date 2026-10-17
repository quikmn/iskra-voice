// `Iskra --mcp`: the local MCP bridge (mcpPipe.ts). Shows nothing and never becomes the main app. On Windows the
// Electron main process can't use the stdio pipes it was started with, so it starts itself again as plain Node
// (ELECTRON_RUN_AS_NODE) with the same pipes, running mcpBridgeNode.js, and exits with it.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { mcpTokenPath } from './mcpPipe'

app.disableHardwareAcceleration()
app.dock?.hide()
const userData = app.getPath('userData')
// Chromium's own caches go elsewhere, so this never touches the running app's.
app.setPath('sessionData', path.join(tmpdir(), 'iskra-mcp-bridge'))
const child = spawn(process.execPath, [path.join(__dirname, 'mcpBridgeNode.js'), mcpTokenPath(userData), app.getVersion()], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
  windowsHide: true,
})
child.on('exit', (code) => app.exit(code ?? 0))
child.on('error', () => app.exit(1))

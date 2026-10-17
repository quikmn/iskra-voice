// `Iskra --mcp`: relays an MCP client's stdio to the running Iskra over the private local channel (mcpPipe.ts).
// Shows nothing and never becomes the main app; when the channel can't be opened it answers with no tools.
import { app } from 'electron'
import { mcpSocketPath, mcpTokenPath, runBridge } from './mcpPipe'

app.disableHardwareAcceleration()
app.dock?.hide()
const userData = app.getPath('userData')
void runBridge({
  socketPath: mcpSocketPath(userData),
  tokenFile: mcpTokenPath(userData),
  version: app.getVersion(),
  input: process.stdin,
  output: process.stdout,
  note: (text) => process.stderr.write(`${text}\n`),
}).finally(() => app.exit(0))

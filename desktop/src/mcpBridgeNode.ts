// The MCP bridge itself, run as plain Node by mcpBridgeMain.ts: stdio ↔ the running Iskra (mcpPipe.ts).
import { runBridge } from './mcpPipe'

const [socketPath, tokenFile, version] = process.argv.slice(2)
void runBridge({
  socketPath, tokenFile, version: version || '0.0.0',
  input: process.stdin,
  output: process.stdout,
  note: (text) => process.stderr.write(`${text}\n`),
}).finally(() => process.exit(0))

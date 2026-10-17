// The app's entry point. `Iskra --mcp` is the local MCP bridge an AI app on this computer starts (mcpBridgeMain.ts):
// no window, no single-instance lock, just stdio relayed to the running Iskra. Anything else is the app (main.ts).
if (process.argv.includes('--mcp')) require('./mcpBridgeMain')
else require('./main')

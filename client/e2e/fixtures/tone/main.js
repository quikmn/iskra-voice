// e2e helper: another app playing a quiet 4003 Hz tone (about -50 dBFS, barely audible) until it's killed.
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')

app.setPath('userData', path.join(os.tmpdir(), 'iskra-e2e-tone'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  void window.loadFile(path.join(__dirname, 'index.html'))
})

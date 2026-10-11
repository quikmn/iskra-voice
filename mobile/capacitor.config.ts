// The phone app shell (Capacitor), one for iOS and Android. It bundles the built web client and runs it from
// capacitor://localhost (iOS) or http://localhost (Android), so the app opens without the network. See README.md.
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'foo.iskra.app',
  appName: 'Iskra',
  webDir: '../client/dist',
  backgroundColor: '#0B0B14',
  ios: {
    path: 'ios',
    // The page handles the notch and home indicator itself (viewport-fit=cover + env(safe-area-inset-*)).
    contentInset: 'never',
    backgroundColor: '#0B0B14',
    // Servers are anyone's hosts, so no App-Bound Domains.
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    path: 'android',
    backgroundColor: '#0B0B14',
  },
  server: {
    // http://localhost, not https://localhost: still a secure context (microphone, WebCrypto), and LAN servers without
    // HTTPS keep working as in the desktop app (an https page may not open ws://). Matches the server's frame-ancestors.
    androidScheme: 'http',
  },
  plugins: {
    // Shrink the web view above the keyboard, as a browser tab does, so the composer stays visible.
    Keyboard: { resize: 'native' },
    // Light text on the dark default theme; the client switches it for light themes (platform/native.ts).
    StatusBar: { style: 'DARK', overlaysWebView: true },
  },
}

export default config

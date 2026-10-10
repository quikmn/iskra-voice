// Public links shown in the app. Update the version when a new release ships.
export const RELEASE_VERSION = '2.0.0-alpha.2'
const download = (file: string) => `https://github.com/quikmn/iskra-voice/releases/download/v${RELEASE_VERSION}/${file}`

export const LINKS = {
  windowsInstaller: download(`Iskra-Setup-${RELEASE_VERSION}.exe`),
  serverWindows: download(`iskra-server-${RELEASE_VERSION}-win-x64.zip`),
  serverLinux: download(`iskra-server-${RELEASE_VERSION}-linux-x64.tar.gz`),
  releases: 'https://github.com/quikmn/iskra-voice/releases',
  hostingGuide: 'https://github.com/quikmn/iskra-voice/blob/main/docs/hosting.md',
}

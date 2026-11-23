// The desktop shell's English text: the source every other language in this folder follows (same keys, same arguments).
export const text = {
  tray: {
    open: 'Open Iskra',
    about: 'About Iskra',
    check: 'Check for updates',
    checking: 'Checking for updates…',
    downloading: (version: string) => `Downloading ${version}…`,
    restart: (version: string) => `Restart to update to ${version}`,
    download: (version: string) => `Download Iskra ${version}`,
    quit: 'Quit Iskra',
  },
  updates: {
    titleReady: 'Update ready',
    titleAvailable: 'Update available',
  },
  menu: { view: 'View' },
  recordings: {
    pickTitle: 'Where should call recordings go?',
  },
  backup: {
    pickTitle: 'Restore a server from a backup',
    filter: 'Iskra backups',
    notBackup: "That file isn't an Iskra backup.",
  },
  bots: {
    pickTitle: 'Choose a bot you trust',
    pickMessage: 'Only run bots you trust: a bot runs with your rights on this computer and can read and change your files.',
    pickButton: 'Use this folder',
    warnTitle: 'Only run bots you trust',
    runQuestion: (name: string) => `Run "${name}" on this computer?`,
    autostartQuestion: (name: string) => `Start "${name}" every time Iskra starts?`,
    changedQuestion: (name: string) => `"${name}" changed since you last ran it. Run it anyway?`,
    warnDetail: (folder: string) => `${folder}

This bot runs with your rights on this computer: it can read and change your files. Only run bots you trust.`,
    run: 'Run it',
    autostart: 'Start it with Iskra',
    cancel: 'Cancel',
  },
  template: {
    pickTitle: 'Start a server from a template file',
    filter: 'Iskra templates',
    tooBig: 'That file is too big for a template.',
  },
  host: {
    defaultName: 'My server',
    noServer: "This build doesn't include the server.",
    stoppedEarly: 'The server stopped right after starting. Is its port in use?',
    damaged: "The server's files are damaged, so it can't start. server.log in its folder says what's wrong; restoring a backup fixes it.",
    couldntStart: (error: string) => `The server couldn't start: ${error}`,
    couldntRun: (error: string) => `The server couldn't run: ${error}`,
    restoreFailed: "The backup couldn't be restored.",
    noPort: 'No free port found.',
  },
  keys: {
    mouse: (button: number) => `Mouse ${button}`,
    key: (code: number) => `Key ${code}`,
  },
  passkey: {
    title: 'Iskra passkey',
    waiting: 'Follow the prompt from your device or security key.',
  },
  splash: {
    title: 'Iskra',
    starting: 'Starting Iskra…',
    servers: 'Starting your servers…',
    connecting: 'Connecting…',
    ready: 'Ready',
    updatedTo: (version: string) => `Updated to ${version}`,
    updating: (version: string) => `Updating Iskra to ${version}…`,
    updatingDetail: "It'll be back in a few seconds.",
  },
  assistant: {
    title: 'Iskra assistant',
    question: (host: string) => `Let the assistant send your questions to ${host}?`,
    detail: 'Only say yes if you entered this address yourself in My settings → Assistant. What you ask the assistant, and what it reads for you, will go there.',
    yes: 'Yes, use it',
    no: 'No',
  },
  digitalOcean: {
    done: 'Connected to DigitalOcean. You can close this tab and go back to Iskra.',
    denied: "Iskra wasn't connected to DigitalOcean. You can close this tab and go back to Iskra.",
  },
}

export type DesktopText = typeof text

// Rent a server on DigitalOcean (desktop app): the steps, progress, errors and the "Your server" document.
export const rental = {
  title: 'Rent a server on DigitalOcean',
  entry: {
    title: 'Or let the app do it, on DigitalOcean',
    text: 'The desktop app can rent and set up the server for you in your own DigitalOcean account: one button, about $6 a month paid to DigitalOcean.',
    button: 'Rent on DigitalOcean',
  },
  createLink: 'Want a server that runs even when this computer is off?',
  createButton: 'Rent one on DigitalOcean',
  steps: {
    label: 'Steps',
    account: 'Account',
    token: 'Access',
    place: 'Server',
    create: 'Setup',
  },
  account: {
    heading: 'A DigitalOcean account',
    intro: 'Your server runs at DigitalOcean, a hosting company, all the time, so friends can join even when your computer is off. You need an account there; the app does the rest.',
    cost: 'About <b>$6 a month</b> for their smallest server that fits Iskra (1 GB memory), billed by the hour. You see the exact price before anything is created. Iskra is free and charges nothing.',
    credit: 'New DigitalOcean accounts get signup credit, so the first months may cost you nothing.',
    referral: 'Iskra sends you to DigitalOcean with our referral link: Iskra gets a little DigitalOcean credit that helps pay for our own server. You pay DigitalOcean directly; we never see your server or your card.',
    open: 'Open DigitalOcean',
    have: 'I have an account',
  },
  connect: {
    heading: 'Connect Iskra to DigitalOcean',
    intro: 'Sign in to DigitalOcean in your browser and allow Iskra to create one server for you. The app gets a key that works for an hour, keeps it in memory only, and forgets it when setup is done.',
    button: 'Connect to DigitalOcean',
    waiting: 'Waiting for you in the browser…',
    cancel: 'Cancel',
    fallback: 'Use an API token instead',
  },
  token: {
    heading: 'Let the app set it up',
    intro: 'Make a key (a "personal access token") that lets this app create the server for you. It stays in the app’s memory on this computer, goes only to DigitalOcean, and is thrown away when setup is done.',
    step1: 'In DigitalOcean, open <tokens>API → Tokens</tokens> and press <b>Generate New Token</b>.',
    step2: 'Name it "Iskra setup" and pick the shortest <b>Expiration</b> (30 days, or Custom for one day).',
    step3: 'Under <b>Scopes</b>, pick <b>Custom Scopes</b> and tick only: <b>droplet</b> (create, read, delete), <b>firewall</b> (create, read, delete), <b>regions</b> (read), <b>sizes</b> (read) and <b>tag</b> (create). DigitalOcean may tick a few related read scopes by itself; that’s fine.',
    step4: 'Press <b>Generate Token</b>, copy it (it starts with dop_v1_) and paste it here.',
    label: 'Token',
    placeholder: 'dop_v1_…',
    next: 'Continue',
    checking: 'Checking with DigitalOcean…',
    back: 'Back',
  },
  place: {
    heading: 'Your server',
    region: 'Location',
    regionHint: 'Pick the one nearest your group, so voice feels quick. The app guessed from your time zone.',
    regionOption: '{{name}}: {{price}} a month',
    name: 'Server name',
    template: 'Starting point',
    size: '{{memory}} memory, {{vcpus}} CPU, {{disk}} GB disk, Ubuntu 24.04. <b>{{price}} a month</b>, billed by DigitalOcean by the hour.',
    ssh: 'Also allow SSH (terminal access)',
    sshHint: 'Off by default: nobody needs to log in to run Iskra, so the firewall only lets in the web and voice. You can open it later in DigitalOcean.',
    note: 'This creates one server (a "droplet") and a firewall in your DigitalOcean account. Nothing is created before you press the button.',
    create: 'Create server for {{price}} a month',
  },
  progress: {
    heading: 'Setting up {{name}}',
    droplet: 'Creating the server at DigitalOcean',
    firewall: 'Adding a firewall (web and voice only)',
    booting: 'Starting it up',
    installing: 'Installing Iskra and getting its HTTPS certificate (usually 3–10 minutes)',
    claiming: 'Making you the owner',
    keepOpen: 'Leave this window open; you can keep chatting meanwhile.',
    address: 'Address: {{url}}',
    stop: 'Stop',
  },
  stopAsk: {
    heading: 'Stop setting up?',
    text: 'The server already exists in your DigitalOcean account and costs money while it exists.',
    delete: 'Stop and delete it',
    keep: 'Keep it',
    back: 'Keep going',
    kept: 'Kept. It’s in your DigitalOcean account (<droplets>Droplets</droplets>); delete it there if you don’t want it. To finish later, open Rent a small server and connect to {{ip}}.',
  },
  failed: {
    heading: 'That didn’t work',
    created: 'A server was already created in your DigitalOcean account. It costs money while it exists.',
    cleanUp: 'Delete it at DigitalOcean',
    cleaning: 'Deleting…',
    cleaned: 'Deleted. Nothing from this try is left in your DigitalOcean account.',
    cleanFailed: 'Couldn’t delete it from here. Delete it yourself in DigitalOcean: the server under <droplets>Droplets</droplets>, the firewall under <firewalls>Networking → Firewalls</firewalls>.',
    keepWaiting: 'Keep waiting',
    retry: 'Try again',
    detail: 'DigitalOcean said: {{detail}}',
  },
  errors: {
    token: 'DigitalOcean didn’t accept that token. Check that you copied all of it and that it hasn’t expired.',
    scope: 'Iskra is missing a permission at DigitalOcean. Connect again and allow everything it asks for, or make a new token with the scopes in the token steps.',
    limit: 'Your DigitalOcean account can’t have another server yet (new accounts start with a limit). Ask DigitalOcean to raise it, or delete a server you don’t use.',
    rate: 'DigitalOcean asks us to slow down. Wait a minute and try again.',
    network: 'Couldn’t reach DigitalOcean. Check your internet connection and try again.',
    server: 'DigitalOcean had a problem. Try again in a few minutes.',
    invalid: 'DigitalOcean turned that request down.',
    timeoutBoot: 'The server didn’t start within 5 minutes.',
    timeoutInstall: 'Your server didn’t answer over HTTPS within 25 minutes. It may still be installing or waiting for its certificate.',
    cancelled: 'Stopped.',
    busy: 'A server is already being set up.',
    denied: 'DigitalOcean didn’t give Iskra access. Try again, or use an API token instead.',
    unavailable: 'Update the desktop app to rent a server from here.',
  },
  done: {
    heading: 'Your server is ready',
    text: 'You’re the owner of {{name}}. Daily backups and automatic updates are on.',
    address: 'Address',
    cost: 'Cost',
    costValue: '{{price}} a month at DigitalOcean',
    save: 'Save your server document',
    saved: 'Saved',
    saveHint: 'Everything about your server in one file: inviting friends, costs and how to cancel, updates, backups, moving it, and a prompt for an AI assistant. No passwords or keys in it.',
    tokenGone: 'The token is gone from this app. You can delete it in DigitalOcean too (<tokens>API → Tokens</tokens>).',
    close: 'Go to my server',
  },
  doc: {
    fileName: 'Iskra server - {{name}}.md',
    title: '{{name}}: your Iskra server',
    made: 'Made by the Iskra app on {{date}}. Keep this file. It holds no passwords or keys.',
    addressTitle: 'Address',
    address:
      '- Address: {{url}}\n' +
      '- IP address: {{ip}}\n' +
      '- At DigitalOcean: the droplet "{{droplet}}" in {{region}} ({{size}}), with the firewall "{{droplet}}-firewall".',
    joinTitle: 'How friends join',
    join: 'Open the server in Iskra and press **Invite friends**: it makes a link to send them. They open it in the Iskra app or in a browser. You decide who gets in: links can expire or work only once, and roles decide what people can do.',
    keysTitle: 'Your keys and recovery',
    keys:
      '- You are the owner. Your account lives on your own devices, not on the server. Keep your **recovery key** (My settings → Recovery key) somewhere safe: it gets your account back on a new device.\n' +
      '- The server’s own key and data are on the server in /opt/iskra/world (server.key, iskra.db, uploads/). Daily backups of it are in /opt/iskra/world/backups.\n' +
      '- Owner tools are in the app: Server settings (members, roles, backups, updates).',
    costTitle: 'What it costs, and how to cancel',
    cost:
      '- {{price}} a month, billed by DigitalOcean by the hour. See it under Billing: {{billing}}. Iskra charges nothing.\n' +
      '- To stop paying: in DigitalOcean open Droplets ({{droplets}}), pick "{{droplet}}", then Destroy → Destroy this Droplet. A droplet that is only switched off still costs money; destroying it stops that. Then delete the firewall "{{droplet}}-firewall" under Networking → Firewalls (free, but tidy).\n' +
      '- Want to keep your server’s history? Make a backup first (Server settings → Backup & move).',
    updatesTitle: 'Updates and backups',
    updates:
      '- Iskra updates itself to new releases at night (around 04:00 server time, checked against the published checksums). Server settings → Server updates shows the version and lets you change this.\n' +
      '- Ubuntu installs its own security updates by itself.\n' +
      '- A backup is made every day on the server (the last 7 are kept). Since they’re on the same server, download one now and then too: Server settings → Backup & move → Make backup (encrypted with a passphrase you choose). DigitalOcean’s own paid backups are off.',
    moveTitle: 'Moving it later',
    move: 'Your whole server is one folder. Make a backup in Server settings → Backup & move, restore it on the new computer or server (desktop app: Create a server → Restore from a backup), then use **Move this server** so everyone’s app follows to the new address. Guide: {{guide}}',
    seesTitle: 'What Iskra can and can’t see',
    sees:
      'The Iskra project runs nothing for your server and sees nothing: not your server, your messages, your DigitalOcean account, your token or your card. The app talked to DigitalOcean only during setup, with your token, and has forgotten it. ' +
      'DigitalOcean, like any hosting company, could technically read the server’s disk; direct messages and encrypted channels are end-to-end encrypted, so it can’t read those. ' +
      'Your server itself talks to GitHub (updates) and Let’s Encrypt (its certificate), and sslip.io’s name servers answer for its address.',
    aiTitle: 'Help from an AI assistant',
    aiIntro: 'If something goes wrong, paste the text below into an AI assistant (Claude, ChatGPT…). It describes your setup exactly and holds no secrets.',
    sshOpen: 'SSH (22/tcp) is allowed',
    sshClosed: 'SSH (22/tcp) is not allowed; to use SSH or the Droplet Console, add an inbound rule for TCP 22 to that firewall first',
    ai:
      'I run an Iskra server (a self-hosted voice and chat server, https://github.com/quikmn/iskra-voice) on a DigitalOcean droplet. Please help me with a problem. Ask me to run commands and paste their output, and explain each command first. This is exactly how it was set up:\n\n' +
      '- Droplet "{{droplet}}" in region {{region}}, size {{size}}, image Ubuntu 24.04 LTS (x86-64), public IPv4 {{ip}}.\n' +
      '- Set up on first boot by a cloud-init user-data script (log: /var/log/iskra-setup.log). It installed Iskra {{version}} from GitHub releases (iskra-server-{{version}}-linux-x64.tar.gz, checked against SHA256SUMS.txt).\n' +
      '- Program in /opt/iskra; data ("world") in /opt/iskra/world: server.json (settings), iskra.db (SQLite), server.key, uploads/, backups/, certs/. Everything is owned by the system user "iskra".\n' +
      '- systemd service "iskra" (/etc/systemd/system/iskra.service) runs "/opt/iskra/iskra-server /opt/iskra/world" as the iskra user, with ExecStartPre=-/opt/iskra/iskra-update-guard and AmbientCapabilities=CAP_NET_BIND_SERVICE. Voice is LiveKit, which the server starts itself.\n' +
      '- Address {{url}} (an sslip.io name for the IP). The server gets its own HTTPS certificate from Let’s Encrypt (server.json "Https": {"Mode": "acme"}).\n' +
      '- Ports: 80/tcp (certificate check), 443/tcp (web and WebSocket), 7881/tcp and 7882/udp (voice). Open in ufw on the droplet (with 22/tcp) and in the DigitalOcean cloud firewall "{{droplet}}-firewall": {{ssh}}.\n' +
      '- Automatic updates from GitHub releases (server.json "Updates": {"Mode": "auto"}) and daily backups into /opt/iskra/world/backups.\n' +
      '- Logs: journalctl -u iskra -n 200 --no-pager. Status: systemctl status iskra. Health: curl -s {{url}}/health\n' +
      '- Guide: https://github.com/quikmn/iskra-voice/blob/main/docs/hosting.md\n\n' +
      'My problem: <describe it here>',
  },
}

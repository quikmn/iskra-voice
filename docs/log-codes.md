# Log codes

Generated from [protocol/log-codes.json](../protocol/log-codes.json) by the server test `LoggingTests` (run it with
`ISKRA_WRITE_DOCS=1` to rewrite this file). A code never changes meaning. How to read a log line:
[development.md, Logs](development.md#logs).

| Code | Level | From | Area | Meaning | What to do |
|---|---|---|---|---|---|
| BAK-110 | WARN | srv | backup | The daily backup failed. | Check free disk space and that the world folder's backups/ is writable; Settings → Backups shows the last result. |
| BAK-120 | WARN | srv | backup | A backup couldn't be sent to a backup buddy (why= says what went wrong). | Usually the friend's server is offline; it retries on its own. Settings → Backups → Backup buddies shows the details. |
| BAK-130 | WARN | srv | backup | The daily backup couldn't be copied to the extra folder (Backups.CopyTo). | Check that the folder or drive is there and writable. |
| BAK-140 | INFO | srv | backup | A removed backup buddy couldn't be told that it no longer keeps our backups. | Nothing: it deletes the copies after its grace period anyway. |
| BAK-150 | WARN | srv | backup | Copies kept for a friend's server couldn't be deleted or swept yet. | Check the world folder's permissions; it tries again. |
| BAK-160 | ERROR | srv | backup | A channel export failed for an unexpected reason (the admin sees "The export couldn't be made"). | Check free disk space and the world folder's exports/ folder; try the export again. Report a bug if it keeps failing. |
| BOT-110 | WARN | bot, srv | sched | A built-in bot's scheduled work failed (what= names the bot). | Report it with the log line; the bot tries again on its next tick. |
| CON-110 | WARN | app | conn | The connection to a server closed or failed; the app retries. | Look at close= and why= and the server's SES lines for the same conn=. |
| CON-120 | WARN | app | conn | The handshake with a server timed out. | Check the server is up and reachable. |
| CON-130 | INFO | app | conn | The server is restarting. | Nothing: the app reconnects. |
| CON-140 | INFO | app | conn | The server stopped (close 1001). | Nothing: the app reconnects when it's back. |
| CON-150 | WARN | app | conn | The server refused the connection (code= is the protocol error code). | Depends on the code: an expired invite, a ban, a revoked device. |
| CON-160 | INFO | app | conn | The app stopped trying (gave up, or the server was removed). | Nothing. |
| DSK-110 | WARN | desk | life | A part of the desktop app stopped unexpectedly (kind=: page, gpu, utility; reason= from Electron). | If the window went blank, open it again from the tray (or restart the app); report it if it repeats. |
| DSK-120 | WARN | desk | life | A server hosted in the desktop app stopped without being asked (exit= is its exit code). | Look at that server's logs/ folder for the same time. |
| DSK-130 | WARN | desk | life | A server hosted in the desktop app couldn't start (why=). | Look at server.log and logs/ in that server's folder. |
| DSK-140 | WARN | desk | store | The desktop app couldn't save its settings. | Check that the app's data folder is writable. |
| DSK-150 | WARN | desk | ui | The app's window stopped responding for a while. | Nothing unless it repeats; then report it with the bug report. |
| DSK-160 | WARN | desk | life | A bot run by the desktop app (My settings → Bots on this PC) stopped without being asked (exit= is its exit code). | Open the bot's log in Bots on this PC: its last lines say why. |
| DSK-170 | WARN | desk | life | A bot run by the desktop app couldn't start (why=: no-entry, no-python, spawn). | For your own folder: check it has a package.json main, bot.js or bot.py; Python bots need Python 3.11+ installed. |
| DSK-900 | ERROR | desk | life | An uncaught error in the desktop app's main process. | Report it with the log lines around it. |
| E2E-110 | WARN | app | e2ee | Decrypting encrypted voice failed. | Rejoin the channel; report it if it repeats. |
| ERR-900 | ERROR | app | ui | An uncaught error (area unknown). | Report it with the bug report. |
| ERR-910 | ERROR | app | ui | A known step failed (area= and op= say which, name= and frame= where; msg= is the browser's own wording). | Report it with the bug report. |
| HOK-110 | WARN | hook | http | An outgoing webhook delivery failed after its retries (why= is the outcome). | Check the receiving service; Server settings → Webhooks shows each delivery. |
| HOK-120 | WARN | hook | http | An outgoing webhook was turned off after failing again and again. | Fix the receiving end, then turn the webhook back on in Server settings → Webhooks. |
| HOK-130 | WARN | hook | http | Queueing or running an outgoing webhook delivery failed unexpectedly. | Report it with the log line. |
| LK-110 | WARN | srv | voice | LiveKit (voice) stopped; it's started again after a pause (exit= is its exit code). | If it keeps happening, check that the voice ports are free (Voice.Port, RtcTcpPort, RtcUdpPort). |
| LK-120 | WARN | lk | voice | LiveKit reported a warning (msg= is its own wording, scrubbed). | Usually harmless; report it if voice misbehaves at the same time. |
| LK-130 | WARN | srv | voice | A request to LiveKit (remove someone, change permissions, close a room) failed. | Usually LiveKit was restarting; check for LK-110 around it. |
| LK-140 | WARN | srv | voice | livekit-server wasn't found, so voice is off. | Put livekit-server next to iskra-server, or set Voice.LiveKitPath or ISKRA_LIVEKIT. |
| LK-150 | ERROR | srv | voice | Starting or running LiveKit failed. | Check that livekit-server can run on this machine; report it with the log line. |
| LK-160 | ERROR | lk | voice | LiveKit reported an error (msg= is its own wording, scrubbed). | Report it with the log line if voice misbehaves. |
| LOG-110 | WARN | srv | sweep | Trimming the log files failed. | Check that the world folder's logs/ is writable. |
| MED-110 | WARN | app | media | The microphone's noise suppression fell back (why= says why). | Nothing; report it if the microphone sounds wrong. |
| MED-120 | WARN | app | media | An audio or video device was lost or changed during a call. | Pick the device again in Settings → Voice. |
| MED-130 | WARN | app | media | Voice activity detection couldn't start; the microphone uses the volume threshold instead. | Nothing; report it if voice activity misbehaves. |
| MED-140 | WARN | app | media | Cleaning incoming voices isn't available here (or fell back, why= says why). | Nothing; others' voices play as they come. |
| MED-150 | WARN | app | media | Captions, a transcript or a translation couldn't start or stopped (what= says which). | Try again; on slow devices turn it off. |
| MED-160 | WARN | app | media | The camera background effect couldn't start or was turned off (why= says why). | Nothing; the camera keeps working without it. |
| MED-170 | WARN | app | media | The microphone couldn't be captured or sent; you stay muted. | Check the microphone permission and device in Settings → Voice. |
| MOD-110 | WARN | srv | http | A captions or translation model from upstream failed its check and wasn't kept. | Nothing: it's fetched again on the next request. Report it if it repeats. |
| NAT-110 | WARN | srv | nat | The router didn't open every port (UPnP / NAT-PMP), or couldn't be searched for. | Forward the ports by hand (docs/hosting.md) or turn on UPnP in the router. |
| NAT-120 | INFO | srv | nat | The public address is shared with other customers (carrier-grade NAT): ports can't be opened. | Use "Let friends connect without port forwarding" (p2p), or ask the provider for a public IPv4 address. |
| NAT-130 | INFO | srv | nat | The router stopped answering; it's searched for again. | Nothing, unless it repeats: then restart the router. |
| NAT-140 | WARN | srv | nat | The internet hosting check failed unexpectedly. | Report it with the log line; it tries again soon. |
| NAT-150 | INFO | srv | nat | Removing a port from the router failed. | Nothing: the router drops it when its lease ends. |
| PSH-110 | WARN | srv | push | A push notification couldn't be delivered (status= from the push service). | Usually the push service was unreachable; repeated 4xx means the subscription is stale. |
| SCH-110 | WARN | srv | sched | A scheduled job failed (what= names it: polls, events, reminders, AFK, rooms, teams...). | Report it with the log line; the job runs again on its next tick. |
| SES-110 | INFO | srv | sess | A connection was refused at the handshake (why= is the protocol error code). | Nothing on its own; many in a row from one app mean it has an old invite or a revoked device. |
| SES-120 | INFO | srv | sess | A session ended without the app asking (why=: kicked, removed, socket-lost, stalled, bad-frames, too-large, aborted). | Nothing on its own; socket-lost in a row for one acct points at that person's network. |
| SES-130 | WARN | srv | sess | A client stopped reading and was dropped (its queue was full). | Nothing: the app reconnects and catches up. |
| SES-900 | ERROR | srv | sess | A session crashed. | Report it with the log line (name= and frame= say where). |
| SRV-900 | WARN | srv | misc | A warning or error from a component that has no code of its own (often ASP.NET itself). | Report it with the log line. |
| SRV-910 | ERROR | srv | sess | A request handler failed (op= is the request type); the app got "Something went wrong on the server". | Report it with the log line (name= and frame= say where). |
| STO-110 | ERROR | srv | store | The server couldn't open its world folder and didn't start (why=: settings-json, database, no-access, files). | The console says what to do; for a damaged database, restore a backup. |
| STO-120 | ERROR | srv | store | A Discord import failed unexpectedly. | Report it with the log line. |
| SWP-110 | WARN | srv | sweep | A cleanup sweep failed (retention, uploads, disappearing messages). | Report it with the log line; it runs again later. |
| SWP-120 | INFO | srv | sweep | A file due for deletion couldn't be deleted yet (in use, or no access). | Nothing: it's tried again on the next sweep. |
| TLS-110 | ERROR | srv | tls | Getting a Let's Encrypt certificate failed. | Check that port 80 reaches this server from the internet and that the domain points here. |
| TLS-120 | WARN | srv | tls | Https.BindAddress / ProxyProtocol settings are ignored because HTTPS is off. | Set Https.Mode to "acme" or "files", or remove those settings. |
| TLS-130 | WARN | srv | tls | Bound to localhost without the PROXY protocol: every client looks like this machine. | Behind a proxy, turn on Https.ProxyProtocol (docs/hosting.md). |
| TLS-140 | WARN | srv | tls | The stored certificate couldn't be read and is ignored. | Delete the certs/ folder's files to get a new one, or fix their permissions. |
| TLS-150 | WARN | srv | http | A connection on a PROXY protocol listener was dropped (at most once a minute). | Check the proxy's proxy_protocol setting and Https.ProxyTrustedFrom. |
| TUN-110 | WARN | app | tunnel | Opening a peer-to-peer tunnel to a server failed. | Check the host's p2p status; very strict networks block it. |
| TUN-120 | INFO | app | tunnel | The direct address didn't answer; using the tunnel. | Nothing. |
| TUN-130 | WARN | srv | tunnel | The peer-to-peer tunnel stopped; it's started again after a pause (exit= is its exit code). | If it keeps happening, report it with the p2p lines around it. |
| TUN-140 | WARN | srv | tunnel | iskra-p2p wasn't found, so friends can't connect without port forwarding. | Put iskra-p2p next to iskra-server, or set P2p.SidecarPath. |
| TUN-150 | ERROR | srv, p2p, desk | tunnel | The peer-to-peer tunnel failed (to start, or it reported failed). | Report it with the p2p lines around it. |
| UPD-110 | WARN | upd | update | The desktop app couldn't check for updates. | Nothing: it checks again later. |
| UPD-120 | WARN | upd | update | Installing a desktop app update failed. | Download the app again from iskra.foo. |
| UPS-110 | WARN | srv | update | Checking GitHub for server updates failed. | Nothing: it checks again in an hour. |
| UPS-120 | WARN | srv | update | Installing a server update failed; the server keeps running its current version. | Try again from Settings → Updates; report it if it repeats. |
| UPS-130 | WARN | srv | update | A server update didn't start and was undone (rolled back). | Report it with the version (to=). |
| VOI-120 | WARN | app | voice | Joining voice failed (token, connect, timeout). | Check the server's LK lines around the same time. |
| VOI-130 | WARN | app | voice | No network route for voice (ICE failed). | Check the voice ports (UDP) or the TURN relay. |
| VOI-140 | INFO | app | voice | Voice is reconnecting (signal lost). | Nothing unless it repeats. |
| VOI-150 | INFO | srv | voice | Someone was removed from a voice room they may not be in (permissions, timeout, rules, limit). | Nothing: this is the server enforcing the channel's rules. |
| VOI-201 | INFO | app | voice | Left voice: the same account joined from another device. | Nothing. |
| VOI-202 | INFO | app | voice | Left voice: removed or moved by a moderator. | Nothing. |
| VOI-203 | INFO | app | voice | Left voice: the room closed or the server is restarting. | Nothing. |
| VOI-204 | WARN | app | voice | Left voice: the connection was lost. | Check the network; see VOI-130. |

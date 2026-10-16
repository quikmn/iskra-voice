<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new

### Fixes
- Self-hosting: a server bound to `127.0.0.1` (`Https.BindAddress`) without `Https.ProxyProtocol` now warns at start that every client looks like the machine itself (one shared rate limit, no addresses in the security log).

### Good to know

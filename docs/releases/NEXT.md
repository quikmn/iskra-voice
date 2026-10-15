<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new
- Several servers on one machine: behind a TLS-passthrough proxy (nginx `stream`), a server can listen on `127.0.0.1` only (`Https.BindAddress`) and take each client's real address from a PROXY protocol header (`Https.ProxyProtocol`). See "Two servers on one machine" in the hosting guide.

### Fixes

### Good to know

<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new

### Fixes
- A new channel could show the messages of a deleted channel that had the same id, on devices that had the old one open. Fixed: servers never reuse channel (or category, thread, docs page, event) ids, also on existing servers; deleting a channel now also removes its scheduled messages and its place in webhooks and AutoMod settings; and apps drop everything they kept for a channel (messages, drafts, read state, decrypted messages) once it's deleted or you lose access (an encrypted channel's keys wait up to 30 days in case your access comes back).

### Good to know
- The first start after updating can take a little longer on servers with a lot of history: the server tidies up after deleted channels and rebuilds its search index once.

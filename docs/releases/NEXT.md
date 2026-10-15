<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new

### Fixes
- **Deleted channels leave nothing behind.** A new channel could show the messages of a deleted channel that had the same id, on devices that had the old one open. Now servers never reuse channel (or category, thread, docs page, event) ids, also on existing servers; deleting a channel also removes its scheduled messages and its place in webhooks and AutoMod settings; and apps drop everything they kept for a channel (messages, drafts, read state, decrypted messages) once it's deleted or you lose access (an encrypted channel's keys wait up to 30 days in case your access comes back).
- **What's new shows fixes too**: after an update with only fixes, the card lists those.

### Good to know
- Servers with a lot of history take a little longer to start the first time after this update: they tidy up after deleted channels and rebuild their search index once.
- alpha.20 wasn't published (a check caught a problem in the What's new card); its fix is in this release.

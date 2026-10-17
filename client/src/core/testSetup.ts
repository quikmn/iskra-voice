// Vitest setup (vite.config.ts): libsodium is ready before any test file is collected. A describe body that hashes
// or signs while the file is collected runs before every beforeAll, so a beforeAll(ready) comes too late for it.
import sodium from 'libsodium-wrappers-sumo'

await sodium.ready

// "Rent a small server": the setup text for a VPS's "User data" box (cloud-init runs it on first boot), a one-time
// owner claim inside it, and claiming the server once it answers. Nothing here creates cloud resources: people do
// that themselves at a provider they pick. See docs/hosting.md, "Rent a small server", and PROTOCOL.md, "Owner claim".
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, ready } from '../core/crypto'
import type { InviteLink } from '../core/invite'
import { clearPendingRent, loadPendingRent, savePendingRent, type PendingRent } from '../core/storage'
import { RELEASE_VERSION } from '../links'
import { t } from '../i18n'

export const RELEASES = 'https://github.com/quikmn/iskra-voice/releases/download'
/** The ports a rented server opens: SSH (so the provider's tools keep working), web, and voice. */
export const VPS_PORTS = [
  { port: 22, protocol: 'tcp', purpose: 'ssh' },
  { port: 80, protocol: 'tcp', purpose: 'acme' },
  { port: 443, protocol: 'tcp', purpose: 'web' },
  { port: 7881, protocol: 'tcp', purpose: 'voice' },
  { port: 7882, protocol: 'udp', purpose: 'voice' },
] as const

export const serverPackage = (version = RELEASE_VERSION) => `iskra-server-${version}-linux-x64.tar.gz`

/** A new one-time owner claim: 32 random bytes, only in the setup text and this app. */
export async function newClaim(): Promise<string> {
  await ready()
  return b64u(sodium.randombytes_buf(32))
}

const enc = (s: string) => new TextEncoder().encode(s)

/** The owner invite code the server derives from the claim (PROTOCOL.md, "Owner claim"). */
export async function claimCode(claim: string): Promise<string> {
  await ready()
  return b64u(sodium.crypto_auth_hmacsha256(enc('iskra-owner-invite-v1'), fromB64u(claim)).subarray(0, 16))
}

/** Checks the server's proof that it holds our claim (constant time). */
export async function checkClaimProof(claim: string, key: string, nonce: string, proof: string): Promise<boolean> {
  await ready()
  try {
    const expected = sodium.crypto_auth_hmacsha256(enc(`iskra-owner-proof-v1\n${key}\n${nonce}`), fromB64u(claim))
    const given = fromB64u(proof)
    return given.length === expected.length && sodium.memcmp(given, expected)
  } catch {
    return false
  }
}

/** 1.2.3.4 → https://1-2-3-4.sslip.io, the address the setup gives the server (and its HTTPS certificate). */
export function vpsAddress(ip: string): string | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null
  const [a, b] = parts.map(Number)
  const nonPublic = a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  if (nonPublic) return null
  return `https://${parts.map(Number).join('-')}.sslip.io`
}

export interface VpsSetup {
  name: string
  template: string | null
  claim: string
  version?: string
}

/**
 * The "User data" text: a bash script cloud-init runs once, as root, on first boot (Ubuntu 24.04 LTS or Debian 12,
 * x86-64). It downloads the server release, checks it against the release's SHA256SUMS.txt, runs it as the iskra user
 * with systemd (automatic updates on), opens only the needed ports with ufw, and turns on HTTPS for <ip>.sslip.io.
 * The only secret in it is the one-time owner claim.
 */
export function cloudInit({ name, template, claim, version = RELEASE_VERSION }: VpsSetup): string {
  if (!/^[\w.-]+$/.test(version)) throw new Error('bad version')
  if (!/^[A-Za-z0-9_-]{43}$/.test(claim)) throw new Error('bad claim')
  const pkg = serverPackage(version)
  const settings = {
    Name: name.trim().slice(0, 60) || 'My Iskra server',
    ...(template && /^[a-z0-9-]{1,40}$/.test(template) ? { Template: template } : {}),
    OwnerClaim: claim,
    Https: { Mode: 'acme', Domain: '__DOMAIN__' },
    Voice: { Enabled: true, RtcTcpPort: 7881, RtcUdpPort: 7882 },
    Updates: { Mode: 'auto' },
  }
  const ufw = VPS_PORTS.map((p) => `ufw allow ${p.port}/${p.protocol}`).join('\n')
  return `#!/bin/bash
# Iskra server setup, made by the Iskra app. Paste it into "User data" (cloud-init) when you create the server.
# For Ubuntu 24.04 LTS or Debian 12 (x86-64). Runs once, on first boot; the log is in /var/log/iskra-setup.log.
set -euo pipefail
exec >>/var/log/iskra-setup.log 2>&1

VERSION="${version}"
PACKAGE="${pkg}"
BASE="${RELEASES}/v$VERSION"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl ca-certificates tar ufw iproute2

# This server's public IPv4 address gives it a free name, like 203-0-113-7.sslip.io.
IP="$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p' | head -n 1)"
case "$IP" in
  ''|10.*|127.*|169.254.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*)
    echo "No public IPv4 address on this server ($IP). Iskra needs one."; exit 1 ;;
esac
DOMAIN="$(echo "$IP" | tr . -).sslip.io"

# The server, checked against the release's checksums before anything is installed.
WORK="$(mktemp -d)"
curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/$PACKAGE" "$BASE/$PACKAGE"
curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt"
grep -E "^[0-9a-f]{64} [ *]$PACKAGE\\$" "$WORK/SHA256SUMS.txt" > "$WORK/expected"
(cd "$WORK" && sha256sum -c expected)

id iskra >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/iskra --shell /usr/sbin/nologin iskra
tar -xzf "$WORK/$PACKAGE" -C /opt/iskra
rm -rf "$WORK"
install -d -m 700 /opt/iskra/world
cat > /opt/iskra/world/server.json <<'ISKRA_SERVER_JSON'
${JSON.stringify(settings, null, 2)}
ISKRA_SERVER_JSON
sed -i "s/__DOMAIN__/$DOMAIN/" /opt/iskra/world/server.json
chmod 600 /opt/iskra/world/server.json
chown -R iskra:iskra /opt/iskra

cat > /etc/systemd/system/iskra.service <<'ISKRA_UNIT'
[Unit]
Description=Iskra server
After=network-online.target
Wants=network-online.target

[Service]
User=iskra
WorkingDirectory=/opt/iskra
ExecStartPre=-/opt/iskra/iskra-update-guard
ExecStart=/opt/iskra/iskra-server /opt/iskra/world
Restart=on-failure
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
ISKRA_UNIT

# Only what Iskra needs: SSH, web (80 for the certificate, 443), and voice.
${ufw}
ufw --force enable

systemctl daemon-reload
systemctl enable --now iskra
echo "Iskra is starting at https://$DOMAIN"
`
}

/** Plan B, for people who'd rather use a terminal: the steps as a question for an AI assistant. No secrets. */
export function vpsPrompt(version = RELEASE_VERSION): string {
  return t('hosting.rent.ai.prompt', {
    package: serverPackage(version),
    base: `${RELEASES}/v${version}`,
    ports: VPS_PORTS.map((p) => `${p.port}/${p.protocol.toUpperCase()}`).join(', '),
  })
}

// ── The pending claim ───────────────────────────────────────────────────────
// Kept until the server is claimed, so closing the dialog while the server installs doesn't lose the owner key.
// It's a secret: it lives in the encrypted store (sealed with the vault's key, which the OS keychain protects in the
// desktop app), never in localStorage.

const validClaim = (claim: unknown): claim is string => typeof claim === 'string' && /^[A-Za-z0-9_-]{43}$/.test(claim)

export async function loadPending(): Promise<PendingRent | null> {
  try {
    const pending = await loadPendingRent()
    return pending && validClaim(pending.claim) ? pending : null
  } catch {
    return null // locked, or no storage: start over with a new key
  }
}

export async function rememberPending(pending: PendingRent): Promise<void> {
  if (!validClaim(pending.claim)) return
  await savePendingRent(pending).catch(() => undefined)
}

/** Once the server is claimed, or the user starts over: the key is of no use to anyone any more. */
export async function forgetPending(): Promise<void> {
  await clearPendingRent().catch(() => undefined)
}

export type ClaimProgress = 'waiting' | 'checking' | 'joining'

export interface ClaimResult {
  invite: InviteLink
}

/**
 * Polls the new server until it answers with a valid proof for our claim (it has to install, start and get its
 * certificate first), then returns the owner invite. Gives up after `timeoutMs`.
 */
export async function waitForClaim(ip: string, claim: string, options: {
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
  onProgress?: (p: ClaimProgress) => void
  fetcher?: typeof fetch
} = {}): Promise<ClaimResult> {
  const base = vpsAddress(ip)
  if (!base) throw new Error(t('hosting.rent.badIp'))
  const { timeoutMs = 20 * 60_000, intervalMs = 5000, signal, onProgress, fetcher = fetch } = options
  const deadline = Date.now() + timeoutMs
  await ready()
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.('waiting')
    const nonce = b64u(sodium.randombytes_buf(16))
    try {
      const response = await fetcher(`${base}/.well-known/iskra-claim?nonce=${nonce}`, { signal, cache: 'no-store' })
      if (response.ok) {
        onProgress?.('checking')
        const body = (await response.json()) as { key?: unknown; proof?: unknown }
        if (typeof body.key === 'string' && typeof body.proof === 'string' && (await checkClaimProof(claim, body.key, nonce, body.proof))) {
          onProgress?.('joining')
          const invite = { serverUrl: base, serverKey: body.key, code: await claimCode(claim) }
          await forgetPending()
          return { invite }
        }
        throw new Error(t('hosting.rent.wrongServer'))
      }
      if (response.status === 404) throw new Error(t('hosting.rent.alreadyClaimed'))
    } catch (e) {
      if ((e as Error).name === 'AbortError' || (e as Error).message === t('hosting.rent.wrongServer') || (e as Error).message === t('hosting.rent.alreadyClaimed')) throw e
      // Not up yet: installing, starting, or waiting for its certificate.
    }
    if (Date.now() + intervalMs > deadline) throw new Error(t('hosting.rent.timeout'))
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

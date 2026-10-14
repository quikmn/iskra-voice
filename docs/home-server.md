# An Iskra box at home

> **Your server, your choice.** Iskra gets nothing from any of this; this is just a guide.

A small computer that's always on is a great home for your group's Iskra server: an old PC or laptop, a mini PC, or
a Raspberry Pi. It costs a few euros of electricity a year, everything stays in your home, and nobody has to keep
their gaming PC running so friends can chat.

This guide covers picking the box, installing Iskra, starting it with the computer, letting friends in from the
internet, updates, backups and keeping the power bill small. The full reference is [hosting.md](hosting.md).

## 1. Pick a box

Anything from the last ten years or so works for a friend group. What matters is that it's **64-bit** and can stay on.

| Box | Iskra package | Good to know |
|---|---|---|
| Old PC or laptop with Windows | `iskra-server-<version>-win-x64.zip`, or the desktop app | Easiest if it already runs Windows. A laptop has a built-in battery for short power cuts |
| Old PC, laptop or mini PC with Linux (Ubuntu, Debian, Fedora…) | `iskra-server-<version>-linux-x64.tar.gz` | The best fit: [automatic updates](#5-updates) work here. Mini PCs (Intel N100 and similar) are quiet and frugal |
| Raspberry Pi 4 or 5 | `iskra-server-<version>-linux-arm64.tar.gz` | Needs the **64-bit** Raspberry Pi OS (or Ubuntu for Pi). Use a USB SSD rather than the SD card if you can: it lasts longer and is faster. A Pi 3 runs the 64-bit system too, but slowly |
| Other 64-bit ARM boards | `iskra-server-<version>-linux-arm64.tar.gz` | Any 64-bit Linux (`uname -m` says `aarch64`) |
| Mac (Apple silicon or Intel) | `iskra-server-<version>-osx-arm64.tar.gz` / `osx-x64` | Works, but Macs like to sleep: see [power tips](#7-power-use) |

**Not supported:** 32-bit systems (Raspberry Pi OS 32-bit, `armv7l`, old 32-bit Windows). On a Raspberry Pi, check
with `uname -m`: it must say `aarch64`; if it says `armv7l`, install the 64-bit Raspberry Pi OS.

**How big?** 1 GB of memory is enough for a group of friends (the cheapest cloud servers Iskra runs on have 1 GB);
2 GB or more is comfortable. Disk space is mostly the files people share, plus about 100 MB if someone uses live
captions. A wired network cable is better than Wi-Fi for voice.

Voice (LiveKit) is in every package: nothing else to install.

## 2. Install

Download the package for your box from the [releases page](https://github.com/quikmn/iskra-voice/releases) and
unpack it into a folder of its own, then start it with a folder for the server (it's made on the first run):

```sh
# Linux and Raspberry Pi
mkdir -p ~/iskra && tar -xzf iskra-server-*-linux-*.tar.gz -C ~/iskra
~/iskra/iskra-server ~/iskra/world
```

```powershell
# Windows: unpack the zip into, say, C:\Iskra, then in a terminal:
C:\Iskra\iskra-server.exe C:\Iskra\world
```

The first time, the server prints a **one-time owner link** (also saved in `world/owner-invite.txt`). Open it in the
Iskra app, or at [app.iskra.foo](https://app.iskra.foo), and you're the owner. Then press Ctrl+C to stop it: the next
step makes it start on its own.

Windows asks once whether Iskra may use the network: choose **Allow** (private networks are enough at home).

**With a screen and a desktop app instead?** On a Windows, Mac or Linux PC you can also use the Iskra desktop app:
**Create a server**, then tick **Keep my server running**. Iskra then starts with the computer, hidden in the tray,
and updates together with the app. The rest of this guide is about the standalone server, which needs no screen.

## 3. Start with the computer

### Linux and Raspberry Pi: a system service (recommended)

A system service starts at boot, before anyone logs in, and is what [automatic updates](#5-updates) need. Install
Iskra in `/opt/iskra` for its own user:

```sh
sudo useradd --system --create-home --home-dir /opt/iskra iskra
sudo tar -xzf iskra-server-*-linux-*.tar.gz -C /opt/iskra
sudo mv ~/iskra/world /opt/iskra/world        # if you already made the server in step 2
sudo chown -R iskra:iskra /opt/iskra
```

Then create `/etc/systemd/system/iskra.service` with the unit from
[hosting.md](hosting.md#on-a-linux-vps-with-systemd) (it's the same at home and on a rented server) and turn it on:

```sh
sudo systemctl enable --now iskra
sudo journalctl -u iskra -f          # its output; shows the owner link on a new server
```

### Or: one command, as your own user (Windows, macOS, Linux)

```sh
iskra-server install-autostart ~/iskra/world      # Windows: iskra-server.exe install-autostart C:\Iskra\world
```

It prints how to start it right away. What it sets up:

- **Windows:** a scheduled task that starts when you log in, without a window. Run the command from an
  **administrator** terminal and it starts with the computer instead, before anyone logs in (still as you, never with
  administrator rights).
- **Linux:** a systemd user service that starts when you log in. `loginctl enable-linger $USER` makes it start at
  boot. Automatic updates need the system service above.
- **macOS:** a launchd agent that starts when you log in.

`iskra-server remove-autostart <folder>` undoes it.

## 4. Let friends in from the internet

At home, friends on your own network can join right away. For everyone else:

### The easy way: Let friends anywhere join

As the owner, open **Server settings → Internet access** in the app and turn on **Let friends anywhere join**. Iskra
asks your router to open the ports (UPnP or NAT-PMP), gives the server a free address like `203-0-113-7.sslip.io`,
gets an HTTPS certificate for it, and keeps all of that up to date. A checklist shows how each step went. Details:
[hosting.md](hosting.md#one-switch-let-friends-anywhere-join).

Give the box a **fixed address on your network** (in the router: "DHCP reservation" or "static lease" for the box),
so the router keeps sending friends to the right computer.

### If the router won't open ports

Many routers have UPnP turned off. Either turn it on in the router's settings, or forward these ports to the box by
hand (**Server settings → Internet access → Forward the ports yourself** lists them with your addresses, and can write
a question for an AI assistant with your router's model filled in):

| Outside port | To the box | What |
|---|---|---|
| `80/tcp` and `443/tcp` | the server's port, `47070` by default | The app, invites, HTTPS and its certificate |
| `7881/tcp` and `7882/udp` | the same ports | Voice and video |

If the box has its own firewall (ufw on Ubuntu, firewalld on Fedora), allow `47070/tcp`, `7881/tcp` and `7882/udp`
there too.

### If your connection is shared (CGNAT)

Some providers share one public address between many homes (carrier-grade NAT, common on mobile broadband and some
fiber). Then no port forwarding can work, and **What Iskra found out** in Server settings → Internet access says so.
Your options:

1. **Ask your provider for a public IPv4 address.** Often free and done once; then everything above works.
2. **[Tailscale](hosting.md#use-tailscale-free)** (free for small groups): you and each friend install it once, and
   friends reach your box as if it were on their own network. Iskra notices Tailscale on the box by itself and offers
   **Invite friends → Over Tailscale**. Friends join with the Iskra app (browsers need HTTPS, which this route doesn't
   have).
3. **Connect without port forwarding** (experimental) is built into the desktop app: if the box runs the desktop app
   with **Keep my server running**, turn it on in Server settings → Internet access. The standalone server can't do
   this yet.
4. **Rent a small server instead.** If home hosting doesn't work out, the app can set one up for about $6 a month
   ([Rent a small server](hosting.md#rent-a-small-server)), and your server can [move there](hosting.md#moving-a-server-to-another-computer)
   with everyone and everything in it.

## 5. Updates

As the owner, open **Server settings → Server updates**:

- **Install automatically** (Linux with the system service from step 3): the server checks every 6 hours, downloads
  new versions from GitHub, checks them (checksums and the signed build attestation), installs them at night once
  nobody is in voice, and puts the old version back by itself if the new one doesn't start.
- **Tell me** (the default, and everywhere else): you get a notice in the app. To update by hand, stop the server,
  unpack the new package over the old files (the `world` folder isn't in the package and stays as it is), and start
  it again.

The operating system needs updates too. On Ubuntu and Debian, security updates install themselves with
`unattended-upgrades` (`sudo apt install unattended-upgrades`); on Raspberry Pi OS, run
`sudo apt update && sudo apt full-upgrade` now and then, or install `unattended-upgrades` too.

## 6. Backups

- **Daily backups** are on by default: every day the server keeps a copy of its database, settings and keys in
  `world/backups/` (the last 7). They help with mistakes, not with a dead disk.
- **Download a backup now and then:** **Server settings → Backup & move → Make backup** gives you one encrypted file
  with everything (keep the passphrase somewhere else). Put it on another computer or a USB stick.
- From a script, for example a weekly job that writes to a NAS. It works while the server runs; run it as the
  server's user (the folder is readable by that user only), into a folder that user can write to:

  ```sh
  echo "$PASSPHRASE" | sudo -u iskra /opt/iskra/iskra-server backup /opt/iskra/world /mnt/nas/iskra/iskra-$(date +%F).iskrabackup --passphrase-stdin
  ```

A Raspberry Pi's SD card is the part most likely to fail, so downloaded backups matter most there. To restore on a new
box, see [Restoring](hosting.md#restoring); to hand the server to another computer, [Move this
server](hosting.md#moving-a-server-to-another-computer).

## 7. Power use

An always-on box runs about 8,760 hours a year, so every watt is about 9 kWh a year.

| Box | Typical power while idle | A year, roughly |
|---|---|---|
| Raspberry Pi 4 or 5 | 3–5 W | 25–45 kWh |
| Mini PC (Intel N100 and similar) | 6–10 W | 50–90 kWh |
| Old laptop, lid closed | 8–15 W | 70–130 kWh |
| Old desktop PC | 30–60 W | 260–525 kWh |

Iskra itself uses next to nothing while nobody talks; voice calls add a little.

- **Keep it awake, let the screen sleep.** Turn off sleep and hibernation (Windows: Settings → System → Power;
  macOS: System Settings → Energy, "Prevent automatic sleeping"; Linux desktops: the power settings). Turning off the
  display is fine.
- **No screen at all?** On Linux, a server or "Lite" install without a desktop saves memory and power.
- **Back after a power cut:** in the PC's BIOS/UEFI settings, set "Restore on AC power loss" (or similar) to
  **Power On**. A Raspberry Pi starts by itself when power comes back. The service from step 3 starts Iskra.
- **Laptops:** close the lid with "do nothing" as the lid action, and keep it plugged in. Many laptops can limit
  charging to about 80 %, which is kinder to the battery.
- **Old desktops** use the most. If you have one, a mini PC or a Pi usually pays for itself in electricity within a
  few years.
- Use a wired connection for voice, and a small UPS if power cuts are common where you live.

## Help

- Something's off? **Server settings → Internet access** explains what it found. The server's output is in
  `journalctl -u iskra` (system service), `journalctl --user -u iskra-…` (user service) or `server.log` in the server
  folder (Windows and macOS autostart).
- The full reference, every setting and every file: [hosting.md](hosting.md).

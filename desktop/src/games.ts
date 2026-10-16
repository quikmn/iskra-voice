// Activity status: which game is running, from process names only (never window titles or the screen).
// Matching happens here on the user's computer; only the matched game's name leaves the main process.

export interface KnownGame {
  name: string
  /** Process names, lowercase, without ".exe". */
  processes: string[]
}

/** Popular games and their process names (Windows, plus Linux/macOS where they differ). */
export const GAMES: KnownGame[] = [
  { name: 'Counter-Strike 2', processes: ['cs2'] },
  { name: 'Dota 2', processes: ['dota2'] },
  { name: 'League of Legends', processes: ['league of legends'] },
  { name: 'VALORANT', processes: ['valorant-win64-shipping'] },
  { name: 'Fortnite', processes: ['fortniteclient-win64-shipping'] },
  { name: 'Minecraft', processes: ['minecraft.windows'] },
  { name: 'Apex Legends', processes: ['r5apex', 'r5apex_dx12'] },
  { name: 'Overwatch 2', processes: ['overwatch'] },
  { name: 'Rocket League', processes: ['rocketleague'] },
  { name: 'Grand Theft Auto V', processes: ['gta5', 'gta5_enhanced'] },
  { name: 'ELDEN RING', processes: ['eldenring'] },
  { name: "Baldur's Gate 3", processes: ['bg3', 'bg3_dx11'] },
  { name: 'Cyberpunk 2077', processes: ['cyberpunk2077'] },
  { name: 'Factorio', processes: ['factorio'] },
  { name: 'Stardew Valley', processes: ['stardew valley', 'stardewvalley'] },
  { name: 'Terraria', processes: ['terraria'] },
  { name: 'Rust', processes: ['rustclient'] },
  { name: 'PUBG: Battlegrounds', processes: ['tslgame'] },
  { name: 'Call of Duty', processes: ['cod'] },
  { name: 'Destiny 2', processes: ['destiny2'] },
  { name: 'Among Us', processes: ['among us'] },
  { name: 'Valheim', processes: ['valheim'] },
  { name: 'Hearthstone', processes: ['hearthstone'] },
  { name: 'World of Warcraft', processes: ['wow', 'wowclassic'] },
  { name: 'Roblox', processes: ['robloxplayerbeta'] },
  { name: 'The Sims 4', processes: ['ts4_x64'] },
  { name: 'Deep Rock Galactic', processes: ['fsd-win64-shipping'] },
  { name: 'HELLDIVERS 2', processes: ['helldivers2'] },
  { name: 'Path of Exile', processes: ['pathofexile', 'pathofexile_x64', 'pathofexilesteam', 'pathofexile_x64steam'] },
  { name: 'Lethal Company', processes: ['lethal company'] },
  { name: 'Palworld', processes: ['palworld-win64-shipping'] },
  { name: 'Satisfactory', processes: ['factorygame-win64-shipping'] },
  { name: 'Marvel Rivals', processes: ['marvel-win64-shipping'] },
  { name: 'Phasmophobia', processes: ['phasmophobia'] },
  { name: 'Sea of Thieves', processes: ['sotgame'] },
  { name: 'Dead by Daylight', processes: ['deadbydaylight-win64-shipping'] },
  { name: 'Escape from Tarkov', processes: ['escapefromtarkov'] },
  { name: 'Team Fortress 2', processes: ['tf_win64', 'tf_linux64'] },
  { name: 'Hades II', processes: ['hades2'] },
  { name: 'Monster Hunter Wilds', processes: ['monsterhunterwilds'] },
  { name: 'Diablo IV', processes: ['diablo iv'] },
  { name: 'StarCraft II', processes: ['sc2_x64'] },
  { name: 'Euro Truck Simulator 2', processes: ['eurotrucks2'] },
  { name: 'Fall Guys', processes: ['fallguys_client_game'] },
  { name: 'Hollow Knight', processes: ['hollow_knight', 'hollow knight'] },
  { name: 'RimWorld', processes: ['rimworldwin64', 'rimworldlinux'] },
  { name: 'Oxygen Not Included', processes: ['oxygennotincluded'] },
  { name: 'Hogwarts Legacy', processes: ['hogwartslegacy'] },
]

/** "C:\\Games\\Foo.EXE" or "/usr/bin/foo" → "foo". */
export function processKey(raw: string): string {
  const base = raw.trim().split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/\.exe$/, '').trim()
}

/** The first game found running: your own programs first, then the bundled list (`[]` to look only at your own). */
export function matchGame(running: Iterable<string>, custom: { name: string; process: string }[], builtins: KnownGame[] = GAMES): string | null {
  const keys = new Set<string>()
  for (const name of running) {
    const key = processKey(name)
    if (key) keys.add(key)
  }
  for (const c of custom) if (keys.has(processKey(c.process))) return c.name
  for (const game of builtins) if (game.processes.some((p) => keys.has(p))) return game.name
  return null
}

/** `tasklist /fo csv /nh` output → image names. */
export function parseTasklist(csv: string): string[] {
  const names: string[] = []
  for (const line of csv.split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line)
    if (match) names.push(match[1])
  }
  return names
}

// Twitch's API with the operator's own app (https://dev.twitch.tv/console/apps): an app access token
// (client credentials) and "who of these is live". Nothing about the people on your server goes to Twitch.

export interface LiveStream {
  /** The stream's id: a new one each time the channel goes live. */
  id: string
  login: string
  name: string
  title: string
  game: string
}

export class Twitch {
  private token: { value: string; expires: number } | null = null
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly fetcher: typeof fetch

  constructor(clientId: string, clientSecret: string, fetcher: typeof fetch = fetch) {
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.fetcher = fetcher
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials' })
    const response = await this.fetcher('https://id.twitch.tv/oauth2/token', { method: 'POST', body, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Twitch didn't accept the app's id and secret (${response.status}).`)
    const json = (await response.json()) as { access_token?: string; expires_in?: number }
    if (!json.access_token) throw new Error('Twitch sent no access token.')
    this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 }
    return json.access_token
  }

  /** Which of these logins are live now (asked 100 at a time, as Twitch allows). */
  async live(logins: string[]): Promise<LiveStream[]> {
    const streams: LiveStream[] = []
    for (let i = 0; i < logins.length; i += 100) {
      const query = logins.slice(i, i + 100).map((l) => `user_login=${encodeURIComponent(l)}`).join('&')
      const ask = async () => this.fetcher(`https://api.twitch.tv/helix/streams?first=100&${query}`, {
        headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${await this.accessToken()}` },
        signal: AbortSignal.timeout(15_000),
      })
      let response = await ask()
      if (response.status === 401) {
        this.token = null // expired early: once more with a new token
        response = await ask()
      }
      if (!response.ok) throw new Error(`Twitch answered ${response.status}.`)
      const json = (await response.json()) as { data?: { id: string; user_login: string; user_name: string; title: string; game_name: string; type: string }[] }
      for (const s of json.data ?? []) {
        if (s.type === 'live') streams.push({ id: s.id, login: s.user_login.toLowerCase(), name: s.user_name, title: s.title, game: s.game_name })
      }
    }
    return streams
  }
}

/** Streams that just went live (not live last time, or a new stream id), and the new "live now" map. */
export function wentLive(previous: Record<string, string>, now: LiveStream[]): { started: LiveStream[]; live: Record<string, string> } {
  const live: Record<string, string> = {}
  for (const s of now) live[s.login] = s.id
  return { started: now.filter((s) => previous[s.login] !== s.id), live }
}

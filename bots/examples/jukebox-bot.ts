// Jukebox's behaviour, apart from starting it (jukebox.ts), so tests can run the same bot.
import type { AnswerContext, Bot, VoiceConnection } from '../sdk/src/index'
import { find, library, listing, nowPlaying, stopped, type Song } from './jukebox-rules'

/** Gives a bot Jukebox's commands, buttons and voice handling, playing from `folder`. */
export function jukebox(bot: Bot, folder: string): void {
  let queue: Song[] = []
  let index = 0
  /** The "Now playing" card: one message, edited as songs change. */
  let card: number | null = null

  const playingNow = () => (bot.voice?.nowPlaying ? queue[index] : undefined)
  const cardNow = () => nowPlaying(queue[index], queue[index + 1], bot.voice?.state === 'paused')

  /** Plays song i, then the ones after it, until the queue ends or someone stops it. */
  async function playFrom(voice: VoiceConnection, i: number): Promise<void> {
    index = i
    const song = queue[i]
    if (card !== null) await bot.edit(card, cardNow()).catch(() => undefined)
    void bot.setActivity(`🎵 ${song.title}`).catch(() => undefined)
    const end = await voice.play(song.source, { title: song.title })
    // "replaced": /skip already started the next one; "stopped" and "left": /stop, or the bot left voice.
    if (end.reason !== 'finished' && end.reason !== 'error') return
    if (index + 1 < queue.length && bot.voice === voice) return playFrom(voice, index + 1)
    await finish('The queue ended. `/play` to start again.')
  }

  async function finish(reason: string): Promise<void> {
    if (card !== null) await bot.edit(card, stopped(reason)).catch(() => undefined)
    card = null
    void bot.setActivity(null).catch(() => undefined)
    await bot.voice?.leave()
  }

  /** Only people in the bot's voice channel control the music. */
  function listening(ctx: AnswerContext): boolean {
    const voice = bot.voice
    if (voice && bot.voiceChannelOf(ctx.user) === voice.channelId) return true
    const name = voice ? bot.channels.find((c) => c.id === voice.channelId)?.name : null
    void ctx.reply(name ? `Join 🔊 ${name} to control the music.` : 'Nothing is playing. `/play` starts the music.', { private: true })
    return false
  }

  bot.commands([
    {
      name: 'play',
      description: 'Plays music in your voice channel',
      options: [{ name: 'song', description: 'A song or station (default: everything, from the top)', type: 'string' }],
      handler: async (ctx) => {
        const channelId = bot.voiceChannelOf(ctx.user)
        if (channelId === null) return ctx.reply('Join a voice channel first, then `/play`.', { private: true })
        const songs = library(folder)
        const query = typeof ctx.options.song === 'string' ? ctx.options.song : ctx.args
        const at = find(songs, query)
        if (at < 0) return ctx.reply(songs.length ? `Nothing called "${query}". \`/songs\` lists what I have.` : listing(songs), { private: true })

        let voice = bot.voice
        if (voice?.channelId !== channelId) {
          // Joining voice can take a few seconds (longer on a busy machine): "Jukebox is thinking…" meanwhile, so the
          // app doesn't give up on the answer after 15 s while the music is about to start.
          await ctx.defer()
          try {
            voice = await bot.joinVoice(channelId)
          } catch (e) {
            return ctx.reply(`I can't join that channel: ${(e as Error).message}`, { private: true })
          }
          voice.on('kicked', () => void finish('A moderator disconnected me.'))
          voice.on('disconnected', () => void finish('Voice went away. `/play` to start again.'))
        }
        queue = songs
        index = at
        if (card !== null) await bot.edit(card, stopped(`${ctx.userName} started something else.`)).catch(() => undefined)
        card = null
        const message = await ctx.reply(cardNow())
        card = message?.id ?? null
        void playFrom(voice, at)
      },
    },
    {
      name: 'skip',
      description: 'Skips to the next song',
      handler: async (ctx) => {
        if (!listening(ctx) || !playingNow()) return
        if (index + 1 >= queue.length) return ctx.reply('That was the last song. `/stop` ends the music.', { private: true })
        await ctx.reply(`⏭ ${ctx.userName} skipped **${queue[index].title}**`)
        void playFrom(bot.voice!, index + 1)
      },
    },
    {
      name: 'stop',
      description: 'Stops the music and leaves voice',
      handler: async (ctx) => {
        if (!listening(ctx)) return
        await finish(`${ctx.userName} stopped the music.`)
        await ctx.reply(`⏹ ${ctx.userName} stopped the music`)
      },
    },
    { name: 'songs', description: 'Lists the songs and stations', handler: (ctx) => ctx.reply(listing(library(folder)), { private: true }) },
  ])

  // The card's buttons do the same, and update the card in place.
  bot.onComponent(/^jukebox:/, async (ctx) => {
    if (!listening(ctx)) return
    const voice = bot.voice!
    switch (ctx.customId) {
      case 'jukebox:pause':
        voice.pause()
        return ctx.update(cardNow())
      case 'jukebox:resume':
        voice.resume()
        return ctx.update(cardNow())
      case 'jukebox:skip':
        if (index + 1 >= queue.length) return ctx.update(cardNow())
        index += 1 // the card shows the next song at once; playFrom edits it again (the same)
        await ctx.update(cardNow())
        return playFrom(voice, index)
      case 'jukebox:stop':
        card = null // the update below is the card's last change
        await ctx.update(stopped(`${ctx.userName} stopped the music.`))
        return finish('')
    }
  })

  // Everyone left the channel: stop, rather than play to nobody.
  bot.on('event', (type, body) => {
    if (type !== 'voice.state' || !bot.voice || !bot.me) return
    const state = body as { channelId: number; participants: { accountKey: string }[] }
    if (state.channelId === bot.voice.channelId && !state.participants.some((p) => p.accountKey !== bot.me!.accountKey && !bot.members.get(p.accountKey)?.bot))
      void finish('Everyone left, so I stopped.')
  })
}

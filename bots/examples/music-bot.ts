// The Music bot's behaviour, apart from starting it (music.ts), so tests can run the same bot.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Bot, FileInfo, VoiceConnection } from '../sdk/src/index'
import { find, library } from './jukebox-rules'
import {
  canControl, controlText, DEFAULT_SETTINGS, isAudio, MusicQueue, nowPlaying, parseVolume, readSettings, serverFileLink, stopped, titleOf,
  type MusicSettings, type QueuedTrack,
} from './music-rules'

/** Whoever asked, wherever: a command, a button, a message with songs or a DM. */
interface Asker {
  user: string
  userName: string
  /** Where they asked (0 in a DM). */
  channelId: number
  dm: boolean
  reply: (text: string, options?: { private?: boolean }) => Promise<unknown>
}

export interface MusicOptions {
  /** Where the settings (who controls the music, the volume) are kept. */
  settingsFile: string
  /** The operator's own music: audio files and a stations.json with radio streams (optional). */
  folder?: string
  /** DM'd files bigger than this aren't played (they're held in memory). Default 100 MB. */
  maxDmBytes?: number
}

/** Gives a bot the Music commands, buttons and voice handling. */
export function music(bot: Bot, options: MusicOptions): void {
  let settings: MusicSettings = DEFAULT_SETTINGS
  try {
    if (existsSync(options.settingsFile)) settings = readSettings(JSON.parse(readFileSync(options.settingsFile, 'utf8')))
  } catch {
    /* unreadable: the defaults */
  }
  const save = () => {
    writeFileSync(`${options.settingsFile}.tmp`, JSON.stringify(settings, null, 2) + '\n')
    renameSync(`${options.settingsFile}.tmp`, options.settingsFile)
  }
  const queue = new MusicQueue()
  /** The "Now playing" card: one message, edited as songs change (none when the music started from a DM). */
  let card: { channelId: number; id: number } | null = null
  /** Where to post the card: the channel the music was started from. */
  let home: number | null = null

  const memberOf = (key: string) => bot.members.get(key)
  const paused = () => bot.voice?.state === 'paused'
  const cardNow = () => (queue.current ? nowPlaying(queue.current, queue.upcoming[0], paused(), settings.volume) : null)
  const refreshCard = async () => {
    const content = cardNow()
    if (card && content) await bot.edit(card.id, content).catch(() => undefined)
  }

  /** Plays the next song, then the ones after it, until the queue ends or someone stops it. */
  async function playNext(voice: VoiceConnection): Promise<void> {
    const track = queue.next()
    if (!track) return finish('The queue ended. Add more with `/play` or by sending me a song.')
    if (!card && home !== null) {
      const message = await bot.send(home, cardNow()!).catch(() => null)
      card = message ? { channelId: home, id: message.id } : null
    } else await refreshCard()
    void bot.setActivity(`🎵 ${track.title}`).catch(() => undefined)
    const end = await voice.play(track.source, { title: track.title })
    // "replaced": a skip already started the next one; "stopped" and "left": /stop, or the bot left voice.
    if (end.reason === 'error' && home !== null) void bot.send(home, `Couldn't play **${track.title}**: ${end.error?.message ?? 'unknown error'}`).catch(() => undefined)
    if ((end.reason === 'finished' || end.reason === 'error') && bot.voice === voice) return playNext(voice)
  }

  async function finish(reason: string): Promise<void> {
    if (card) await bot.edit(card.id, stopped(reason)).catch(() => undefined)
    card = null
    home = null
    queue.reset()
    void bot.setActivity(null).catch(() => undefined)
    await bot.voice?.leave()
  }

  /** The voice channel to play in: the asker's. Says why not when that doesn't work. */
  function listenerChannel(ctx: Pick<Asker, 'user' | 'reply'>): number | null {
    const theirs = bot.voiceChannelOf(ctx.user)
    const ours = bot.voice?.channelId
    const name = (id: number) => bot.channels.find((c) => c.id === id)?.name ?? 'voice'
    if (theirs === null) {
      void ctx.reply(ours ? `Join 🔊 ${name(ours)} to add songs.` : 'Join a voice channel first, then add a song.', { private: true })
      return null
    }
    if (ours !== undefined && ours !== theirs) {
      void ctx.reply(`I'm playing in 🔊 ${name(ours)}. Join it to add songs.`, { private: true })
      return null
    }
    return theirs
  }

  /** Adds songs for someone (joining their voice channel first) and starts playing if nothing is. */
  async function enqueue(ctx: Asker, tracks: QueuedTrack[]): Promise<void> {
    const channelId = listenerChannel(ctx)
    if (channelId === null) return
    let voice = bot.voice
    if (!voice) {
      try {
        voice = await bot.joinVoice(channelId)
      } catch (e) {
        await ctx.reply(`I can't join that channel: ${(e as Error).message}`, { private: true })
        return
      }
      voice.setVolume(settings.volume)
      voice.on('kicked', () => void finish('A moderator disconnected me.'))
      voice.on('disconnected', () => void finish('Voice went away. `/play` to start again.'))
    }
    if (!ctx.dm && home === null) home = ctx.channelId
    const added = queue.add(...tracks)
    if (added === 0) {
      await ctx.reply('The queue is full (100 songs, 25 each). Try again when some have played.', { private: true })
      return
    }
    const what = added === 1 ? `**${tracks[0].title}**` : `${added} songs`
    const playing = voice.state === 'playing' || voice.state === 'paused'
    await ctx.reply(playing ? `➕ ${ctx.userName} added ${what} (${queue.upcoming.length} in the queue)` : `▶ ${ctx.userName} started the music with ${what}`)
    if (!playing) void playNext(voice)
    else await refreshCard()
  }

  /** Control commands: only for people in the bot's channel whom the setting allows (or for their own song). */
  function controlling(ctx: Pick<Asker, 'user' | 'reply'>, own = false): VoiceConnection | null {
    const voice = bot.voice
    if (!voice || !queue.current) {
      void ctx.reply('Nothing is playing. `/play` starts the music.', { private: true })
      return null
    }
    const isAdmin = canControl({ ...settings, control: { kind: 'level', level: 'admin' } }, memberOf(ctx.user))
    if (bot.voiceChannelOf(ctx.user) !== voice.channelId && !isAdmin) {
      void ctx.reply(`Join 🔊 ${bot.channels.find((c) => c.id === voice.channelId)?.name ?? 'the voice channel'} to control the music.`, { private: true })
      return null
    }
    if (!canControl(settings, memberOf(ctx.user), own)) {
      void ctx.reply(`Only ${controlText(settings.control)} can control the music here.`, { private: true })
      return null
    }
    return voice
  }

  const fromLink = (path: string, ctx: Pick<Asker, 'user' | 'userName'>): QueuedTrack =>
    ({ title: titleOf(path.split('/').pop() ?? ''), source: bot.fileUrl(path), by: ctx.user, byName: ctx.userName, from: 'upload' })
  const fromFile = (file: FileInfo, ctx: Pick<Asker, 'user' | 'userName'>): QueuedTrack =>
    ({ title: titleOf(file.name), source: bot.fileUrl(file), by: ctx.user, byName: ctx.userName, from: 'upload' })

  bot.commands([
    {
      name: 'play',
      description: 'Plays a song in your voice channel, or adds it to the queue',
      options: [{ name: 'song', description: 'A link to an audio file on this server, or a song or station by name', type: 'string' }],
      handler: async (ctx) => {
        const query = String(ctx.options.song ?? ctx.args).trim()
        if (!query && paused()) {
          const voice = controlling(ctx)
          if (!voice) return
          voice.resume()
          await refreshCard()
          return ctx.reply(`▶ ${ctx.userName} resumed the music`)
        }
        const link = query ? serverFileLink(query, bot.fileUrl('/')) : null
        if (link) return enqueue(ctx, [fromLink(link, ctx)])
        if (/^https?:\/\//iu.test(query))
          return ctx.reply("I only play files uploaded to this server (and the songs I was given). Upload the song here, then use its link, or send it to me.", { private: true })
        const songs = options.folder ? library(options.folder) : []
        const at = find(songs, query)
        if (at < 0) {
          const hint = 'Attach an audio file and mention me, send it to me in a DM, or `/play` with a link to a song on this server.'
          return ctx.reply(query && songs.length ? `Nothing called "${query}". ${hint}` : hint, { private: true })
        }
        // A name: that song (or station); no name: the whole folder from the top.
        const picked = query ? [songs[at]] : songs
        return enqueue(ctx, picked.map((s) => ({ title: s.title, source: s.source, by: ctx.user, byName: ctx.userName, from: s.station ? 'station' as const : 'library' as const })))
      },
    },
    {
      name: 'queue',
      description: "Shows what's playing and what's next",
      handler: (ctx) => ctx.reply(`${queue.listing()}\n\nControls: ${controlText(settings.control)}. Volume ${Math.round(settings.volume * 100)} %.`, { private: true }),
    },
    {
      name: 'skip',
      description: 'Skips the song playing now',
      handler: async (ctx) => {
        const voice = controlling(ctx, queue.current?.by === ctx.user)
        if (!voice) return
        const skipped = queue.current!
        await ctx.reply(`⏭ ${ctx.userName} skipped **${skipped.title}**`)
        void playNext(voice)
      },
    },
    {
      name: 'pause',
      description: 'Pauses the music',
      handler: async (ctx) => {
        const voice = controlling(ctx)
        if (!voice) return
        voice.pause()
        await refreshCard()
        await ctx.reply(`⏸ ${ctx.userName} paused the music`)
      },
    },
    {
      name: 'resume',
      description: 'Goes on after a pause',
      handler: async (ctx) => {
        const voice = controlling(ctx)
        if (!voice) return
        voice.resume()
        await refreshCard()
        await ctx.reply(`▶ ${ctx.userName} resumed the music`)
      },
    },
    {
      name: 'stop',
      description: 'Stops the music, empties the queue and leaves voice',
      handler: async (ctx) => {
        if (!controlling(ctx)) return
        await finish(`${ctx.userName} stopped the music.`)
        await ctx.reply(`⏹ ${ctx.userName} stopped the music`)
      },
    },
    {
      name: 'volume',
      description: 'Sets the volume for everyone (0–200 %, 100 is as recorded)',
      options: [{ name: 'percent', description: '0 to 200', type: 'integer', required: true }],
      handler: async (ctx) => {
        const volume = parseVolume(typeof ctx.options.percent === 'number' ? ctx.options.percent : ctx.args)
        if (volume === null) return ctx.reply('Give a volume from 0 to 200, like `/volume 80`.', { private: true })
        const voice = controlling(ctx)
        if (!voice) return
        settings = { ...settings, volume }
        save()
        voice.setVolume(volume)
        await refreshCard()
        await ctx.reply(`🔊 ${ctx.userName} set the volume to ${Math.round(volume * 100)} %`)
      },
    },
    {
      name: 'remove',
      description: 'Takes a song out of the queue',
      options: [{ name: 'position', description: 'Its number in /queue', type: 'integer', required: true }],
      handler: async (ctx) => {
        const position = typeof ctx.options.position === 'number' ? ctx.options.position : Number(ctx.args)
        const target = queue.upcoming[position - 1]
        if (!target) return ctx.reply("There's no song with that number. `/queue` shows them.", { private: true })
        if (!controlling(ctx, target.by === ctx.user)) return
        queue.remove(position)
        await refreshCard()
        await ctx.reply(`➖ ${ctx.userName} removed **${target.title}**`)
      },
    },
    {
      name: 'clear',
      description: 'Empties the queue (the song playing now goes on)',
      handler: async (ctx) => {
        if (!controlling(ctx)) return
        const count = queue.clear()
        await refreshCard()
        await ctx.reply(`🧹 ${ctx.userName} cleared the queue (${count} song${count === 1 ? '' : 's'})`)
      },
    },
    {
      name: 'music-control',
      description: 'Chooses who may control the music (pause, skip, stop, volume)',
      options: [
        { name: 'who', description: 'Who may control it', type: 'string', required: true, choices: [
          { name: 'Everyone listening', value: 'everyone' }, { name: 'Trusted and up', value: 'trusted' },
          { name: 'Admins', value: 'admin' }, { name: 'People with a role', value: 'role' },
        ] },
        { name: 'role', description: 'The role, for "People with a role"', type: 'role' },
      ],
      role: 'admin',
      handler: async (ctx) => {
        const who = String(ctx.options.who ?? ctx.args.split(/\s+/u)[0] ?? '')
        if (who === 'everyone') settings = { ...settings, control: { kind: 'everyone' } }
        else if (who === 'trusted' || who === 'admin') settings = { ...settings, control: { kind: 'level', level: who } }
        else if (who === 'role' && typeof ctx.options.role === 'number') {
          const id = ctx.options.role
          const roles = await bot.request('role.list', {}).then((r) => r.roles).catch(() => [])
          settings = { ...settings, control: { kind: 'role', id, name: roles.find((r) => r.id === id)?.name ?? `#${id}` } }
        } else return ctx.reply('Pick everyone, trusted, admin, or role together with a role.', { private: true })
        save()
        await ctx.reply(`🎛 From now on ${controlText(settings.control)} can control the music.`)
      },
    },
  ])

  // The card's buttons do the same as the commands, and update the card in place.
  bot.onComponent(/^music:/, async (ctx) => {
    const own = ctx.customId === 'music:skip' && queue.current?.by === ctx.user
    const voice = controlling(ctx, own)
    if (!voice) return
    switch (ctx.customId) {
      case 'music:pause':
        voice.pause()
        break
      case 'music:resume':
        voice.resume()
        break
      case 'music:skip':
        if (!queue.upcoming.length) {
          card = null // the update below is the card's last change
          await ctx.update(stopped(`${ctx.userName} skipped the last song.`))
          return finish('')
        }
        void playNext(voice) // moves the queue on at once
        return ctx.update(cardNow()!)
      case 'music:stop':
        card = null
        await ctx.update(stopped(`${ctx.userName} stopped the music.`))
        return finish('')
      case 'music:quieter':
      case 'music:louder':
        settings = { ...settings, volume: Math.min(2, Math.max(0, Math.round((settings.volume + (ctx.customId === 'music:louder' ? 0.1 : -0.1)) * 10) / 10)) }
        save()
        voice.setVolume(settings.volume)
        break
    }
    const content = cardNow()
    if (content) await ctx.update(content)
  })

  // Songs people upload: attach audio files to a message that mentions the bot (it reads nothing else)...
  bot.on('message', (message) => {
    const files = (message.attachments ?? []).filter(isAudio)
    if (!files.length) return
    const ctx: Asker = { user: message.author, userName: message.authorName, channelId: message.channelId, dm: false, reply: (text) => message.reply(text) }
    void enqueue(ctx, files.map((f) => fromFile(f, ctx)))
  })

  // ...or send them in a DM: they're end-to-end encrypted to the bot, which decrypts and plays them.
  bot.on('dm', async (dm) => {
    const files = dm.files.filter((f) => isAudio(f))
    if (!files.length) {
      if (!dm.text.startsWith('/')) await dm.reply('Send me an audio file (MP3, Ogg, FLAC or WAV) while you\'re in a voice channel and I\'ll play it there. `/help` lists what else I can do.')
      return
    }
    const ctx: Asker = { user: dm.from, userName: dm.authorName, channelId: 0, dm: true, reply: (text) => dm.reply(text) }
    const tracks: QueuedTrack[] = []
    for (const file of files) {
      if (file.size > (options.maxDmBytes ?? 100 * 1024 * 1024)) {
        await dm.reply(`**${file.name}** is too big for me to play from a DM. Upload it to a channel instead.`)
        continue
      }
      try {
        tracks.push({ title: titleOf(file.name), source: await bot.downloadDmFile(file), by: dm.from, byName: dm.authorName, from: 'dm' })
      } catch (e) {
        await dm.reply(`I couldn't open **${file.name}**: ${(e as Error).message}`)
      }
    }
    if (tracks.length) await enqueue(ctx, tracks)
  })

  // Everyone left the channel: stop, rather than play to nobody.
  bot.on('event', (type, body) => {
    if (type !== 'voice.state' || !bot.voice || !bot.me) return
    const state = body as { channelId: number; participants: { accountKey: string }[] }
    if (state.channelId === bot.voice.channelId && !state.participants.some((p) => p.accountKey !== bot.me!.accountKey && !bot.members.get(p.accountKey)?.bot))
      void finish('Everyone left, so I stopped.')
  })
}

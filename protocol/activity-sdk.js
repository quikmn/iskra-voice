/* Iskra activity SDK, version 1 (docs/activities.md). One copy for everyone: the server puts it in front of every
   server-added activity's HTML, and the built-in activities bundle it. It sets `window.iskra` and talks to the app that
   shows the activity: postMessage to the parent frame, or, in the desktop app's walled view (which has no parent),
   console lines the app reads and messages the app posts into the view. Everything it gets is checked by the app. */
;(function (W) {
  'use strict'
  if (!W || W.iskra) return
  var V = 1
  var LINE = '\u2063iskra-activity:'
  var walled = W.parent === W
  var handlers = { players: [], message: [], end: [] }
  var held = [] // messages that arrive before anyone listens for them
  var info = null
  var lastSeq = 0
  var resolveReady = null
  var ready = null

  function post(message) {
    message.iskra = V
    if (walled) W.console.debug(LINE + JSON.stringify(message))
    else W.parent.postMessage(message, '*')
  }

  function emit(event, args) {
    var list = handlers[event].slice()
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].apply(null, args)
      } catch (e) {
        W.console.error(e)
      }
    }
  }

  function deliver(m) {
    lastSeq = m.seq
    emit('message', [m.data, m.from, m.seq])
  }

  // Held messages go out in order, before any newer one.
  var scheduled = false
  function flush() {
    scheduled = false
    while (held.length && handlers.message.length) deliver(held.shift())
  }
  function schedule() {
    if (scheduled || !handlers.message.length) return
    scheduled = true
    W.setTimeout(flush, 0)
  }

  W.addEventListener('message', function (event) {
    if (event.source !== (walled ? W : W.parent)) return
    var m = event.data
    if (!m || typeof m !== 'object' || m.iskra !== V) return
    if (m.type === 'init' && !info) {
      info = { me: m.me, players: m.players || [], state: m.state === undefined ? null : m.state, locale: m.locale || 'en',
        theme: m.theme || 'dark', activity: m.activity || null }
      if (typeof m.stateSeq === 'number') lastSeq = m.stateSeq
      if (resolveReady) resolveReady(info)
    } else if (!info) {
      return
    } else if (m.type === 'players') {
      info.players = m.players || []
      emit('players', [info.players])
    } else if (m.type === 'message' && typeof m.seq === 'number') {
      if (handlers.message.length && !held.length) deliver(m)
      else {
        held.push(m)
        schedule()
      }
    } else if (m.type === 'ended') {
      emit('end', [])
    }
  })

  W.iskra = {
    version: V,
    /** Resolves once the app has sent who you are, who's playing and the snapshot for late joiners. */
    ready: function () {
      if (!ready) {
        ready = new Promise(function (resolve) { resolveReady = resolve })
        post({ type: 'ready' })
      }
      return ready
    },
    /** 'players' (list), 'message' (data, from, seq) or 'end'. Returns a function that stops listening. */
    on: function (event, fn) {
      if (!handlers[event] || typeof fn !== 'function') throw new Error('iskra.on: unknown event ' + event)
      handlers[event].push(fn)
      if (event === 'message') schedule()
      return function () {
        var at = handlers[event].indexOf(fn)
        if (at >= 0) handlers[event].splice(at, 1)
      }
    },
    /** Sends JSON (≤ 8 KB) to everyone playing, you included, in the same order for all. */
    send: function (data) { post({ type: 'send', data: data }) },
    /** The state after the last message you got (≤ 48 KB), for people who join later. */
    setState: function (state) { post({ type: 'state', seq: lastSeq, state: state }) },
    /** Ends the activity for everyone (if you may), or closes it for you. */
    end: function () { post({ type: 'end' }) },
    get me() { return info ? info.me : null },
    get players() { return info ? info.players : [] },
    /** The player who has been in longest: a good one to make decisions and snapshots. */
    get host() { return info && info.players.length ? info.players[0].id : null },
  }
})(typeof window === 'undefined' ? undefined : window)

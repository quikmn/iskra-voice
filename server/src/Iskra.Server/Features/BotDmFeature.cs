using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Direct messages with bots. A bot is an ordinary DM endpoint (its own device keys and prekeys, envelopes encrypted to
/// it like to anyone), so the server still only relays envelopes. What's different is who may write first: anyone may
/// write to a bot; a bot may write to a person on this server unless they blocked it or turned off DMs from bots (then
/// only in a conversation the person started). New conversations a bot starts are rate limited.
/// </summary>
public static class BotDmFeature
{
    /// <summary>How far ahead of the server's clock a setting's time may be.</summary>
    private const long MaxClockSkewMs = 10 * 60 * 1000;

    public static void Register(Router router)
    {
        router.Add("dm.bots.get", (s, me, _) => View(s.World.Store.BotDmPref(me.AccountKey)));
        router.Add("dm.bots.set", Set);
    }

    private static object View((bool Allow, long At) pref) => new { allow = pref.Allow, at = pref.At };

    private static object Set(Session s, Member me, Body body)
    {
        var allow = body.OptionalBool("allow") ?? throw RequestException.BadRequest("'allow' is required.");
        var at = body.OptionalLong("at", min: 1, max: s.Now + MaxClockSkewMs) ?? throw RequestException.BadRequest("'at' is required.");
        var before = s.World.Store.BotDmPref(me.AccountKey);
        var after = s.World.Store.SetBotDmPref(me.AccountKey, allow, at);
        if (after != before)
        {
            var frame = Frames.Event("dm.bots", View(after));
            foreach (var other in s.Hub.Sessions.Where(o => o.AccountKey == me.AccountKey && o != s)) other.Send(frame);
        }
        return View(after);
    }

    /// <summary>Checked by <c>dm.send</c> before storing. People's DMs with each other are untouched.</summary>
    public static void CheckSend(Session s, Member me, Member peer)
    {
        if (peer.AccountKey == me.AccountKey) return;
        var store = s.World.Store;
        bool meBot = store.IsBot(me.AccountKey), peerBot = store.IsBot(peer.AccountKey);
        if (!meBot && !peerBot) return;
        if (meBot && peerBot) throw RequestException.Forbidden("Bots can't message other bots.", "bot_dm_bot");
        // Built-in bots run inside the server and never connect: they have no keys to encrypt to.
        if (peerBot && store.BuiltinIdOf(peer.AccountKey) is not null)
            throw RequestException.BadRequest("Built-in bots don't take direct messages.", "builtin_bot_dm");
        if (peerBot) return; // anyone may write to a bot

        if (!s.Hub.Limits.TryTake(me.AccountKey, "bot.dm.send")) throw new RequestException("rate_limited", "Slow down a little.");
        var conversation = store.BotDmPeer(me.AccountKey, peer.AccountKey);
        if (conversation is { PersonWrote: true }) return;
        if (!store.BotDmPref(peer.AccountKey).Allow)
            throw RequestException.Forbidden("This person doesn't take direct messages from bots.", "bot_dms_off");
        if (conversation is null && !s.Hub.Limits.TryTake(me.AccountKey, "bot.dm.new"))
            throw new RequestException("rate_limited", "This bot started too many new conversations. Try again later.", "bot_dm_new_limit");
    }

    /// <summary>After a DM was stored: remembers the conversation (and whether the person wrote first).</summary>
    public static void Sent(Session s, Member me, Member peer)
    {
        if (peer.AccountKey == me.AccountKey) return;
        var store = s.World.Store;
        if (store.IsBot(peer.AccountKey)) store.NoteBotDmPeer(peer.AccountKey, me.AccountKey, personWrote: true, s.Now);
        else if (store.IsBot(me.AccountKey)) store.NoteBotDmPeer(me.AccountKey, peer.AccountKey, personWrote: false, s.Now);
    }
}

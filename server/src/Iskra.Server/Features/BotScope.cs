using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// What a bot may read. An admin chooses at invite time (and can change later) whether a bot can read all messages; by
/// default it gets only its interactions and the messages meant for it: its own, ones that mention it, replies to it,
/// and "/command" messages for one of its registered commands. Enforced on what the server sends and on reading requests.
/// </summary>
public static class BotScope
{
    /// <summary>Requests that hand out message content, refused to bots that can't read all messages.</summary>
    private static readonly HashSet<string> ReadRequests =
    [
        "chat.history", "chat.edits", "search", "pin.list", "thread.get", "forum.posts", "forum.post.get",
        "docs.pages", "docs.page.get", "docs.page.history", "docs.search", "docs.home.get", "chat.forward", "inbox.list",
    ];

    /// <summary>Events that carry other people's content and that such a bot never needs.</summary>
    private static readonly HashSet<string> DroppedEvents =
        ["chat.typing", "docs.page.updated", "docs.home", "forum.post.updated", "watch.chat"];

    public static void Register(Router router) => router.Add("bot.scope.set", Set);

    /// <summary>The router asks before every request.</summary>
    internal static RequestException? Gate(Session s, Member me, string type) =>
        ReadRequests.Contains(type) && s.World.Store.IsBot(me.AccountKey) && !s.World.Store.BotReadsAll(me.AccountKey)
            ? RequestException.Forbidden("This bot can only read messages meant for it. An admin can let it read all messages.", "bot_no_read")
            : null;

    private static object Set(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can change what a bot can read.", "admins_bot_scope");
        var key = body.String("accountKey", 64);
        var bot = s.World.Store.GetMember(key);
        if (bot is null || !s.World.Store.IsBot(key)) throw RequestException.NotFound("Bot");
        var readAll = body.OptionalBool("readAll") ?? throw RequestException.BadRequest("'readAll' is required.");
        s.World.Store.SetBotReadAll(key, readAll);
        foreach (var session in s.Hub.Sessions.Where(x => x.AccountKey == key)) session.ReadFilter = Filter(s.World.Store, key);
        Audit.Record(s, "bot.scope", key, details: new { readAll });
        var member = s.Hub.PublicMember(bot);
        s.Hub.Broadcast(Frames.Event("member.updated", new { member }));
        return new { member };
    }

    /// <summary>The filter for a session of this account: null for people and for bots that read everything.</summary>
    public static Func<string, bool>? Filter(Store store, string accountKey) =>
        store.IsBot(accountKey) && !store.BotReadsAll(accountKey) ? new ReadFilter(store, accountKey).Allows : null;

    /// <summary>Decides per outgoing frame. Frames start with {"type":"…"}, so most are decided without parsing.</summary>
    private sealed class ReadFilter(Store store, string me)
    {
        private const string Prefix = "{\"type\":\"";

        public bool Allows(string frame)
        {
            if (!frame.StartsWith(Prefix, StringComparison.Ordinal)) return true;
            var end = frame.IndexOf('"', Prefix.Length);
            if (end < 0) return true;
            var type = frame[Prefix.Length..end];
            if (DroppedEvents.Contains(type)) return false;
            if (type is not ("chat.message" or "chat.edited" or "poll.updated")) return true;
            try
            {
                using var doc = JsonDocument.Parse(frame);
                var body = doc.RootElement.GetProperty("body");
                if (type == "poll.updated")
                    return body.TryGetProperty("id", out var id) && id.TryGetInt64(out var pollId) && store.GetMessage(pollId)?.AuthorKey == me;
                return MeantForMe(body.GetProperty("message"));
            }
            catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
            {
                return false;
            }
        }

        private bool MeantForMe(JsonElement message)
        {
            if (message.TryGetProperty("author", out var author) && author.GetString() == me) return true;
            var text = message.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? "" : "";
            if (text.Contains($"<@{me}>", StringComparison.Ordinal)) return true;
            if (message.TryGetProperty("replyTo", out var reply) && reply.ValueKind == JsonValueKind.Object
                && reply.TryGetProperty("author", out var replied) && replied.ValueKind == JsonValueKind.String && replied.GetString() == me) return true;
            return IsMyCommand(text);
        }

        /// <summary>"/name …" or "/name@Bot …" for one of this bot's registered commands.</summary>
        private bool IsMyCommand(string text)
        {
            if (!text.StartsWith('/')) return false;
            var head = text[1..].Split([' ', '\n', '\t'], 2)[0];
            var parts = head.Split('@', 2);
            var name = parts[0].ToLowerInvariant();
            if (name.Length == 0 || store.GetBotCommands(me) is not { } list) return false;
            // "/roll@Dice" is for the bot called Dice only (spaces in its name may be left out).
            if (parts.Length == 2 && !string.Equals(parts[1], (store.GetMember(me)?.Name ?? "").Replace(" ", ""), StringComparison.OrdinalIgnoreCase))
                return false;
            using var doc = JsonDocument.Parse(list.Commands);
            return doc.RootElement.EnumerateArray().Any(c => c.GetProperty("name").GetString() == name);
        }
    }
}

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Microsoft.Extensions.Logging.Abstractions;

namespace Iskra.Server.Features;

/// <summary>
/// Built-in bots, run by the server itself: Dice (/roll), Polls (/poll, a native poll) and Reminders (/remind, a
/// personal reminder). An admin turns each on or off; while on it's a bot member like any other (its role and channel
/// permissions decide where it answers), but it never connects: the server answers commands people send in channels it
/// can read and post in. Encrypted channels are out of reach (the server can't read the command), like for every bot.
/// </summary>
public static partial class BuiltinBotFeature
{
    /// <param name="Command">Null for bots that only react to what happens (Starboard, Welcome).</param>
    public sealed record Kind(string Id, string Name, string? Command, string Description, string Usage);

    public static readonly Kind[] Bots =
    [
        new("dice", "Dice", "roll", "Rolls dice, like 2d6+3", "2d6+3"),
        new("polls", "Polls", "poll", "Starts a poll", "Question | Answer | Answer"),
        new("reminders", "Reminders", "remind", "Reminds you later", "me in 10m what"),
        new("starboard", "Starboard", null, "", ""),
        new("birthdays", "Birthdays", "birthday", "Birthday greetings", "set 14 March | remove | list"),
        new("welcome", "Welcome", null, "", ""),
        new("feeds", "Feeds", null, "", ""),
    ];

    /// <summary>Marks reminder data written by the Reminders bot (not sealed: the command was a plain channel message).</summary>
    public const string ReminderDataPrefix = "bot.";

    public static void Register(Router router)
    {
        router.Add("builtin.bots.set", Set);
        MoreBuiltinBots.Register(router);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// <summary>For <c>welcome.builtinBots</c> and the <c>builtin.bots</c> event: every built-in bot and whether it's on.</summary>
    public static List<object> All(Store store)
    {
        var rows = store.BuiltinBots().ToDictionary(r => r.Id, r => r.AccountKey);
        return Bots.Select(b =>
        {
            var key = rows.GetValueOrDefault(b.Id);
            return (object)new { id = b.Id, accountKey = key, enabled = key is not null && store.GetMember(key) is not null };
        }).ToList();
    }

    /// <summary>The <c>builtin</c> part of a message: what a built-in bot's answer means, so apps can word it in their language.</summary>
    public static JsonElement? MessageView(Store store, Message m)
    {
        if (store.BuiltinIdOf(m.AuthorKey) is null || store.GetBuiltinReply(m.Id) is not { } raw) return null;
        using var doc = JsonDocument.Parse(raw);
        return doc.RootElement.Clone();
    }

    // ── On and off ───────────────────────────────────────────────────────────

    private static object Set(Session s, Member me, Body body)
    {
        if (!BaseRoles.Allows(me, BaseAbility.Bots)) throw RequestException.Forbidden("Only admins can turn built-in bots on or off.", "builtin_bots_admin");
        var id = body.String("bot", 32);
        var kind = Bots.FirstOrDefault(b => b.Id == id) ?? throw RequestException.BadRequest("There's no built-in bot by that name.");
        var enabled = body.OptionalBool("enabled") ?? throw RequestException.BadRequest("'enabled' is required.");
        var store = s.World.Store;
        var key = store.BuiltinBotKey(kind.Id, NewKey, s.Now);
        var member = store.GetMember(key);
        if (enabled && member is null)
        {
            (member, var commands) = Enable(store, kind, me.AccountKey, s.Now);
            Audit.Record(s, "builtin.bot.on", key, details: new { bot = kind.Id });
            MoreBuiltinBots.TurnedOn(s, kind.Id);
            s.Hub.Broadcast(Frames.Event("member.joined", new { member = s.Hub.PublicMember(member) }));
            using var doc = JsonDocument.Parse(commands);
            s.Hub.Broadcast(Frames.Event("bot.commands", new { bot = key, commands = doc.RootElement.Clone() }));
        }
        else if (!enabled && member is not null)
        {
            Audit.Record(s, "builtin.bot.off", key, details: new { bot = kind.Id });
            store.RemoveMember(key); // its command list goes with the member row
            s.Hub.Broadcast(Frames.Event("member.removed", new { accountKey = key }));
        }
        else return new { bots = All(store) };

        var bots = All(store);
        s.Hub.Broadcast(Frames.Event("builtin.bots", new { bots }));
        return new { bots };
    }

    /// <summary>Adds the built-in bot as a member (with its command), as turning it on does; also used by starter templates. Returns the commands JSON.</summary>
    internal static (Member Member, string Commands) Enable(Store store, Kind kind, string by, long now)
    {
        var key = store.BuiltinBotKey(kind.Id, NewKey, now);
        store.RemoveBan(key); // turning it on is an explicit choice
        var member = store.AddMember(key, kind.Name, Roles.Member, now);
        store.AddBot(key, by, now, readAll: false); // server-run: it only ever sees its own command
        var commands = (kind.Command is null ? new JsonArray()
            : new JsonArray(new JsonObject { ["name"] = kind.Command, ["description"] = kind.Description, ["usage"] = kind.Usage })).ToJsonString();
        store.SetBotCommands(key, commands, now);
        return (member, commands);
    }

    /// <summary>A fresh identity nobody holds the private key of: the bot never signs in, so the key is thrown away.</summary>
    private static string NewKey()
    {
        using var key = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        return Ed25519.ToB64u(Ed25519.PublicKeyOf(key));
    }

    // ── Commands ─────────────────────────────────────────────────────────────

    [GeneratedRegex(@"^/([A-Za-z0-9][A-Za-z0-9_-]{0,31})(?:@(\S{1,64}))?(?:\s+(.*))?$", RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex CommandPattern();

    /// <summary>Whether this bot answers here: a chat channel it can read and post in, not encrypted, and it isn't timed out.</summary>
    public static bool Answers(Store store, Member bot, Channel channel, long now)
    {
        if (channel.Kind is not ("text" or "thread" or "voice" or "stage")) return false;
        var parent = channel.Kind == "thread" && store.GetThread(channel.Id) is { } thread ? store.GetChannel(thread.ParentId) : channel;
        if (parent is null || E2eeChannelFeature.IsEncrypted(store, parent) || E2eeChannelFeature.IsEncrypted(store, channel)) return false;
        return Permissions.CanSend(bot, channel) && store.TimedOutUntil(bot.AccountKey, now) is null;
    }

    /// <summary>
    /// Called for every plain channel message after it's stored and sent: a command for a built-in bot that's on gets its
    /// answer right after the sender's own reply. Bots' messages are never commands (no bot loops).
    /// </summary>
    public static void Heard(Session s, Member me, Channel channel, Message message)
    {
        if (message.Text.Length < 2 || message.Text[0] != '/') return;
        var store = s.World.Store;
        if (store.IsBot(me.AccountKey)) return;
        var match = CommandPattern().Match(message.Text);
        if (!match.Success) return;
        var kind = Bots.FirstOrDefault(b => b.Command is not null && b.Command == match.Groups[1].Value.ToLowerInvariant());
        if (kind is null) return;
        var row = store.BuiltinBots().FirstOrDefault(r => r.Id == kind.Id);
        if (row is null || store.GetMember(row.AccountKey) is not { } bot) return;
        if (match.Groups[2].Success && !string.Equals(Handle(store.DisplayName(bot)), match.Groups[2].Value, StringComparison.OrdinalIgnoreCase)) return;
        if (!Answers(store, bot, channel, s.Now)) return;
        if (!s.TryTakeLimit("builtin." + kind.Id)) return; // the sender's own sends are limited too; this keeps polls and reminders rarer
        var args = match.Groups[3].Success ? match.Groups[3].Value.Trim() : "";
        s.AfterReply(() =>
        {
            try
            {
                switch (kind.Id)
                {
                    case "dice": Roll(s, me, bot, channel, args); break;
                    case "polls": Poll(s, me, bot, channel, args); break;
                    case "birthdays": BirthdayBot.Command(s, me, bot, channel, args); break;
                    default: Remind(s, me, bot, channel, message, args); break;
                }
            }
            catch (RequestException e)
            {
                Private(s, bot, me, channel, $"{kind.Name}: {e.Message}", Reply(kind, "error", me, new { error = new { code = e.Code, message = e.Message, key = e.Key, args = e.Args } }));
            }
            catch (Exception e) when (e is not OperationCanceledException and not ObjectDisposedException)
            {
                // The sender's own reply has gone out already (a second answer to it would confuse the app): the bot just doesn't answer.
            }
        });
    }

    /// <summary>A bot's name as it can follow "@" in a command (no spaces), as apps write it.</summary>
    private static string Handle(string name) => string.Concat(name.Where(c => !char.IsWhiteSpace(c)));

    internal static JsonObject Reply(Kind kind, string type, Member asker, object? extra = null)
    {
        var reply = new JsonObject { ["bot"] = kind.Id, ["kind"] = type, ["for"] = asker.AccountKey };
        if (extra is not null && JsonSerializer.SerializeToNode(extra, Json.Options) is JsonObject more)
            foreach (var (name, value) in more.ToList())
            {
                more.Remove(name);
                reply[name] = value;
            }
        return reply;
    }

    private static void Roll(Session s, Member me, Member bot, Channel channel, string args)
    {
        var who = s.World.Store.DisplayName(me);
        var roll = BuiltinCommands.Roll(args, sides => RandomNumberGenerator.GetInt32(1, sides + 1));
        if (roll is null)
        {
            var input = args.Length <= 60 ? args : args[..59] + "…";
            Private(s, bot, me, channel, $"🎲 {who}: that isn't dice notation. Try /roll 2d6+3 (up to {BuiltinCommands.MaxDice} dice with up to {BuiltinCommands.MaxSides} sides).",
                Reply(Bots[0], "roll.invalid", me, new { input }));
            return;
        }
        Post(s, bot, channel, BuiltinCommands.RollText(who, roll), Reply(Bots[0], "roll", me, new
        {
            expression = roll.Expression,
            groups = roll.Groups.Select(g => new { sign = g.Sign, count = g.Count, sides = g.Sides, rolls = g.Rolls }),
            modifier = roll.Modifier,
            total = roll.Total,
        }));
    }

    private static void Poll(Session s, Member me, Member bot, Channel channel, string args)
    {
        if (BuiltinCommands.ParsePoll(args) is not var (question, answers))
        {
            Private(s, bot, me, channel, "📊 Start a poll like this: /poll Pizza or tacos? | Pizza | Tacos", Reply(Bots[1], "poll.usage", me));
            return;
        }
        // Checked here too, so a long answer gets the friendly message instead of a size error.
        if (answers.Length > PollFeature.MaxOptions)
            throw RequestException.BadRequest($"A poll needs {PollFeature.MinOptions}–{PollFeature.MaxOptions} answers.", "poll_answers",
                new { min = PollFeature.MinOptions, max = PollFeature.MaxOptions });
        if (question.Length > PollFeature.MaxQuestion)
            throw RequestException.BadRequest($"The question must be 1–{PollFeature.MaxQuestion} characters.", "poll_question_length", new { max = PollFeature.MaxQuestion });
        if (answers.Any(a => a.Length > PollFeature.MaxOption))
            throw RequestException.BadRequest($"Each answer must be 1–{PollFeature.MaxOption} characters.", "poll_answer_length", new { max = PollFeature.MaxOption });
        // The native poll, made by the bot through the same request (and checks) a person's poll goes through.
        var session = Session.Detached(bot.AccountKey, s.World, s.Hub, s.Voice, s.Uploads, s.Previews, s.Router, NullLogger.Instance, s.Time, s.Push, s.Gifs);
        var request = new JsonObject { ["channelId"] = channel.Id, ["question"] = question, ["options"] = new JsonArray([.. answers.Select(a => (JsonNode)a)]) };
        using var doc = JsonDocument.Parse(request.ToJsonString());
        s.Router.Invoke(session, bot, "poll.create", doc.RootElement);
    }

    private static void Remind(Session s, Member me, Member bot, Channel channel, Message message, string args)
    {
        var store = s.World.Store;
        var who = store.DisplayName(me);
        if (BuiltinCommands.ParseRemind(args) is not { } remind)
        {
            Private(s, bot, me, channel, "⏰ Set a reminder like this: /remind me in 10m take the pizza out (from 1 minute up to 365 days).", Reply(Bots[2], "remind.usage", me));
            return;
        }
        if (store.CountReminders(me.AccountKey) >= ReminderFeature.MaxPerAccount)
            throw RequestException.BadRequest($"You can have up to {ReminderFeature.MaxPerAccount} reminders here. Finish some first.", "reminders_max",
                new { max = ReminderFeature.MaxPerAccount });
        // An ordinary reminder about the command message: it shows in the asker's inbox, fires in their apps and pushes,
        // and can be snoozed or cancelled there. Its note is readable by the server, as the command already was.
        var due = s.Now + remind.DelayMs;
        var about = JsonSerializer.SerializeToUtf8Bytes(new { note = remind.Note, where = "#" + channel.Name, at = message.CreatedAt }, Json.Options);
        var reminder = store.AddReminder(me.AccountKey, due, ReminderDataPrefix + Ed25519.ToB64u(about), channel.Id, message.Id, s.Now);
        s.Hub.SendToAccount(me.AccountKey, Frames.Event("reminder.updated", new { reminder = ReminderFeature.View(reminder) }));
        Post(s, bot, channel, $"⏰ OK {who}, I'll remind you in {Duration(remind.DelayMs)}.", Reply(Bots[2], "remind", me, new { dueAt = due }));
    }

    /// <summary>"1 day 2 hours", "10 minutes": for the plain text.</summary>
    internal static string Duration(long ms)
    {
        var parts = new List<string>();
        void Part(long n, string unit)
        {
            if (n > 0 && parts.Count < 2) parts.Add($"{n} {unit}{(n == 1 ? "" : "s")}");
        }
        var minutes = ms / 60_000;
        Part(minutes / 1440, "day");
        Part(minutes / 60 % 24, "hour");
        Part(minutes % 60, "minute");
        return string.Join(' ', parts);
    }

    /// <summary>Hints and errors go only to the person who asked (a private answer, never stored), not into the channel.</summary>
    internal static void Private(Session s, Member bot, Member asker, Channel channel, string text, JsonObject reply) =>
        InteractionFeature.PrivateNote(s, bot.AccountKey, asker.AccountKey, channel.Id,
            Text.Normalize(text, ChatFeature.MaxMessageLength, allowNewlines: false) ?? "…", reply);

    /// <summary>Posts the bot's answer like any message (everyone who can read the channel sees it), with what it means attached.</summary>
    private static void Post(Session s, Member bot, Channel channel, string text, JsonObject reply)
    {
        var store = s.World.Store;
        var message = store.AddBuiltinMessage(channel.Id, bot.AccountKey, Text.Normalize(text, ChatFeature.MaxMessageLength, allowNewlines: false) ?? "…",
            reply.ToJsonString(), s.Now);
        var view = MessageViews.Public(store, message);
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = view }));
        ThreadFeature.Touched(s, channel);
        s.Push.ChatMessage(channel, message);
    }
}

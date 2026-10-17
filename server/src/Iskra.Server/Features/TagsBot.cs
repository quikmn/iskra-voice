using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The Tags bot: saved snippets anyone can post with <c>/tag name</c> (the rules, a link, an FAQ answer). Admins and a
/// role they pick manage them, in the bot's settings or with <c>/tag set</c> and <c>/tag remove</c>. A snippet can't
/// ping anyone: mentions in it are defused when it's posted.
/// </summary>
public static partial class TagsBot
{
    public const string Id = "tags";
    public const int MaxTags = 200;
    public const int MaxName = 32;
    public const int MaxText = 2000;
    private static readonly string[] Reserved = ["list", "set", "remove"];

    public static void Register(Router router)
    {
        router.Add("tags.list", List);
        router.Add("tags.set", Set);
        router.Add("tags.remove", Remove);
    }

    [GeneratedRegex(@"^[a-z0-9-]{1,32}$", RegexOptions.CultureInvariant)]
    private static partial Regex NamePattern();

    public static object View(Tag t) => new { name = t.Name, text = t.Text, updatedBy = t.UpdatedBy, updatedAt = t.UpdatedAt };

    private static long? ManagerRole(Store store) => MoreBuiltinBots.Config<TagsConfig>(store, Id).ManagerRoleId;

    public static bool CanManage(Store store, Member me) => BuiltinBots3.IsStaff(store, me, ManagerRole(store));

    private static void RequireManager(Store store, Member me)
    {
        if (!CanManage(store, me)) throw RequestException.Forbidden("Only admins and tag managers can change tags.", "tags_manage");
    }

    /// <summary>A tag's name as typed (lowercased); throws when it isn't a-z, 0-9 and dashes, or is a subcommand.</summary>
    public static string Name(string raw)
    {
        var name = raw.Trim().ToLowerInvariant();
        if (!NamePattern().IsMatch(name) || Reserved.Contains(name))
            throw RequestException.BadRequest($"Tag names are 1–{MaxName} of a–z, 0–9 and -, and not list, set or remove.", "tags_name", new { max = MaxName });
        return name;
    }

    public static string Snippet(string raw) =>
        raw.Trim().Length == 0 || Sessions.Text.Normalize(raw, MaxText, allowNewlines: true) is not { } text
            ? throw RequestException.BadRequest($"A tag's text is 1–{MaxText} characters.", "tags_text", new { max = MaxText })
            : text;

    private static (Tag Tag, bool Created) Save(Session s, Member me, string name, string text)
    {
        var store = s.World.Store;
        var created = store.SetTag(name, text, me.AccountKey, s.Now, MaxTags)
            ?? throw RequestException.BadRequest($"A server can have up to {MaxTags} tags. Remove one first.", "tags_max", new { max = MaxTags });
        Audit.Record(s, "tag.set", store.BuiltinBots().FirstOrDefault(r => r.Id == Id)?.AccountKey, details: new { name, created });
        return (store.GetTag(name)!, created);
    }

    private static bool Delete(Session s, string name)
    {
        var store = s.World.Store;
        if (!store.RemoveTag(name)) return false;
        Audit.Record(s, "tag.remove", store.BuiltinBots().FirstOrDefault(r => r.Id == Id)?.AccountKey, details: new { name });
        return true;
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    private static object List(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        return new { tags = store.Tags().Select(View), max = MaxTags, canManage = CanManage(store, me) };
    }

    private static object Set(Session s, Member me, Body body)
    {
        RequireManager(s.World.Store, me);
        var name = Name(body.String("name", MaxName * 2));
        var text = Snippet(body.String("text", MaxText * 2));
        var (tag, created) = Save(s, me, name, text);
        return new { tag = View(tag), created };
    }

    private static object Remove(Session s, Member me, Body body)
    {
        RequireManager(s.World.Store, me);
        var name = body.String("name", MaxName * 2).Trim().ToLowerInvariant();
        if (!Delete(s, name)) throw RequestException.BadRequest($"There's no tag called {name}.", "tags_unknown", new { name });
        return new { };
    }

    // ── /tag ─────────────────────────────────────────────────────────────────

    private static readonly BuiltinBotFeature.Kind Kind = MoreBuiltinBots.KindOf(Id);

    public static void Command(Session s, Member me, Member bot, Channel channel, string args)
    {
        var store = s.World.Store;
        var space = args.IndexOfAny([' ', '\n', '\t']);
        var first = (space < 0 ? args : args[..space]).ToLowerInvariant();
        var rest = space < 0 ? "" : args[(space + 1)..].Trim();
        switch (first)
        {
            case "":
                BuiltinBotFeature.Private(s, bot, me, channel, "🏷️ Post a tag with /tag name. /tag list shows them all.", BuiltinBotFeature.Reply(Kind, "tag.usage", me));
                return;
            case "list":
            {
                var names = store.Tags().Select(t => t.Name).ToList();
                var text = names.Count == 0 ? "🏷️ There are no tags yet." : "🏷️ Tags: " + string.Join(", ", names);
                BuiltinBotFeature.Private(s, bot, me, channel, text, BuiltinBotFeature.Reply(Kind, "tag.list", me, new { names }));
                return;
            }
            case "set":
            {
                RequireManager(store, me);
                var split = rest.IndexOfAny([' ', '\n', '\t']);
                if (split < 0)
                {
                    BuiltinBotFeature.Private(s, bot, me, channel, "🏷️ Save a tag like this: /tag set rules Be kind.", BuiltinBotFeature.Reply(Kind, "tag.usage", me));
                    return;
                }
                var name = Name(rest[..split]);
                var (_, created) = Save(s, me, name, Snippet(rest[(split + 1)..]));
                BuiltinBotFeature.Private(s, bot, me, channel, $"🏷️ Saved the tag {name}.", BuiltinBotFeature.Reply(Kind, "tag.saved", me, new { name, created }));
                return;
            }
            case "remove":
            {
                RequireManager(store, me);
                var name = rest.ToLowerInvariant();
                if (!Delete(s, name)) throw RequestException.BadRequest($"There's no tag called {name}.", "tags_unknown", new { name });
                BuiltinBotFeature.Private(s, bot, me, channel, $"🏷️ Removed the tag {name}.", BuiltinBotFeature.Reply(Kind, "tag.removed", me, new { name }));
                return;
            }
        }
        if (rest.Length > 0 || store.GetTag(first) is not { } tag)
        {
            var input = args.Length <= 40 ? args : args[..39] + "…";
            BuiltinBotFeature.Private(s, bot, me, channel, $"🏷️ There's no tag called {input}. /tag list shows them all.",
                BuiltinBotFeature.Reply(Kind, "tag.unknown", me, new { name = input }));
            return;
        }
        // Anyone can post a tag, and nobody gets pinged by one (the text is defused, and it goes out without pings).
        var posted = FeedService.Defuse(tag.Text);
        MoreBuiltinBots.Post(store, s.Hub, s.Push, bot, channel, posted, BuiltinBotFeature.Reply(Kind, "tag", me, new { name = tag.Name, text = posted }), s.Now);
        ThreadFeature.Touched(s, channel);
    }
}

using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Organizing a server: channel categories and the order of channels (admins), and nicknames.
/// Notification settings live in <see cref="NotifyFeature"/>.
/// </summary>
public static class OrganizeFeature
{
    public const int MaxCategoryNameLength = 32;
    public const int MaxCategories = 50;

    public static void Register(Router router)
    {
        router.Add("category.create", CreateCategory);
        router.Add("category.update", UpdateCategory);
        router.Add("category.delete", DeleteCategory);
        router.Add("category.move", MoveCategory);
        router.Add("channel.move", MoveChannel);
        router.Add("member.nick", SetNick);
        NotifyFeature.Register(router);
        ForwardFeature.Register(router);
        PrefsFeature.Register(router);
    }

    public static object PublicCategory(Category c) => new { id = c.Id, name = c.Name, position = c.Position };

    /// <summary>
    /// Admins see every category (they manage them). Everyone else only sees categories holding at least one channel
    /// they can read, so a category of private channels doesn't reveal that they exist.
    /// </summary>
    public static List<object> VisibleCategories(Store store, Member member)
    {
        var categories = store.AllCategories();
        if (Permissions.IsAdmin(member)) return categories.Select(PublicCategory).ToList();
        var used = store.AllChannels().Where(c => c.CategoryId is not null && Permissions.CanRead(member, c)).Select(c => c.CategoryId!.Value).ToHashSet();
        // Positions are renumbered too, so gaps don't hint at hidden categories.
        return categories.Where(c => used.Contains(c.Id)).Select((c, i) => PublicCategory(c with { Position = i })).ToList();
    }

    private static void RequireAdmin(Member me)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can organize channels.", "admins_organize");
    }

    /// <summary>
    /// An imported channel goes into the category with this name (ignoring case), created at the end if there's none
    /// and the server has room; it's added after the category's last channel. Unusable names leave it uncategorized.
    /// </summary>
    public static void PlaceImportedChannel(Store store, long channelId, string? categoryName)
    {
        if (Text.Normalize(categoryName, MaxCategoryNameLength, allowNewlines: false) is not { } name) return;
        var category = store.AllCategories().FirstOrDefault(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase));
        if (category is null)
        {
            if (store.CountCategories() >= MaxCategories) return;
            category = store.CreateCategory(name);
        }
        store.MoveChannel(channelId, category.Id, null);
    }

    private static string CategoryName(string raw) =>
        Text.Normalize(raw, MaxCategoryNameLength, allowNewlines: false)
        ?? throw RequestException.BadRequest($"Category names must be 1–{MaxCategoryNameLength} characters, with no invisible characters.", "category_name", new { max = MaxCategoryNameLength });

    private static Category ExistingCategory(Session s, long id) =>
        s.World.Store.GetCategory(id) ?? throw RequestException.NotFound("Category");

    /// <summary>The optional 'categoryId' of a request (admins only call this): null, or a category that exists.</summary>
    internal static long? OptionalCategory(Session s, Body body) =>
        body.OptionalLong("categoryId", 1) is { } id ? ExistingCategory(s, id).Id : null;

    private static object CreateCategory(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var name = CategoryName(body.String("name", 256));
        if (s.World.Store.CountCategories() >= MaxCategories) throw RequestException.BadRequest($"A server can have up to {MaxCategories} categories.", "categories_max", new { max = MaxCategories });
        var category = s.World.Store.CreateCategory(name);
        ChannelFeature.BroadcastChannels(s);
        return new { category = PublicCategory(category) };
    }

    private static object UpdateCategory(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var category = ExistingCategory(s, body.Long("id"));
        var name = CategoryName(body.String("name", 256));
        s.World.Store.RenameCategory(category.Id, name);
        ChannelFeature.BroadcastChannels(s);
        return new { category = PublicCategory(category with { Name = name }) };
    }

    private static object? DeleteCategory(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var category = ExistingCategory(s, body.Long("id"));
        s.World.Store.DeleteCategory(category.Id);
        ChannelFeature.BroadcastChannels(s);
        return null;
    }

    private static object? MoveCategory(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var category = ExistingCategory(s, body.Long("id"));
        var before = body.OptionalLong("before", 1) is { } b ? ExistingCategory(s, b).Id : (long?)null;
        if (before == category.Id) throw RequestException.BadRequest("A category can't move before itself.");
        s.World.Store.MoveCategory(category.Id, before);
        ChannelFeature.BroadcastChannels(s);
        return null;
    }

    /// <summary>A channel (not a thread) the admin can see; others are not_found so they don't leak.</summary>
    private static Channel VisibleChannel(Session s, Member me, long id) =>
        s.World.Store.GetChannel(id) is { Kind: not "thread" } channel && Permissions.CanRead(me, channel)
            ? channel
            : throw RequestException.NotFound("Channel");

    private static object? MoveChannel(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var channel = VisibleChannel(s, me, body.Long("id"));
        var categoryId = OptionalCategory(s, body);
        long? before = null;
        if (body.OptionalLong("before", 1) is { } b)
        {
            var target = VisibleChannel(s, me, b);
            if (target.Id == channel.Id) throw RequestException.BadRequest("A channel can't move before itself.");
            if (target.CategoryId != categoryId) throw RequestException.BadRequest("'before' must be a channel in that category.");
            before = target.Id;
        }
        s.World.Store.MoveChannel(channel.Id, categoryId, before);
        ChannelFeature.BroadcastChannels(s);
        return null;
    }

    // ── Nicknames ────────────────────────────────────────────────────────────

    /// <summary>Your own nickname, or (admins) the nickname of someone ranked below you. "" resets it.</summary>
    private static object SetNick(Session s, Member me, Body body)
    {
        var key = body.OptionalString("accountKey", 64) ?? me.AccountKey;
        var target = key == me.AccountKey ? me : s.World.Store.GetMember(key) ?? throw RequestException.NotFound("Member");
        if (target.AccountKey != me.AccountKey && !(Permissions.IsAdmin(me) && Permissions.Outranks(me, target)))
            throw RequestException.Forbidden("You can only change nicknames of members ranked below you.", "rank_nicknames");

        var raw = body.OptionalString("nick", 256) ?? throw RequestException.BadRequest("'nick' is required.");
        var nick = raw.Trim().Length == 0 ? null : Names.Normalize(raw)
            ?? throw RequestException.BadRequest($"Server nicknames must be 1–{Names.MaxLength} characters, with no invisible characters.", "nickname_length", new { max = Names.MaxLength });
        s.World.Store.SetNickname(target.AccountKey, nick);
        var member = s.Hub.PublicMember(target);
        s.Hub.Broadcast(Frames.Event("member.updated", new { member }));
        return new { member };
    }
}

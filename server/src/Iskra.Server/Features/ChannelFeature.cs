using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

public static class ChannelFeature
{
    public const int MaxNameLength = 32;
    private static readonly string[] Kinds = ["text", "voice", "forum", "stage"];

    public static void Register(Router router)
    {
        router.Add("channel.create", Create);
        router.Add("channel.update", Update);
        router.Add("channel.delete", Delete);
    }

    private static void RequireAdmin(Member me)
    {
        if (!Permissions.Has(me, Perm.ManageChannels)) throw RequestException.Forbidden("You can't manage channels on this server.");
    }

    /// <summary>Channel names are lowercase with dashes, like "game-night".</summary>
    internal static string ChannelName(string raw)
    {
        var name = Text.Normalize(raw, MaxNameLength, allowNewlines: false)
            ?? throw RequestException.BadRequest($"Channel names must be 1–{MaxNameLength} characters.");
        return string.Join('-', name.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }

    private static string Role(Body body, string field, string fallback)
    {
        var role = body.OptionalString(field, 16) ?? fallback;
        if (!Roles.IsValid(role)) throw RequestException.BadRequest($"'{field}' must be one of: {string.Join(", ", Roles.All)}.");
        return role;
    }

    private static void CheckRoles(string readRole, string writeRole)
    {
        if (Roles.Rank(writeRole) < Roles.Rank(readRole))
            throw RequestException.BadRequest("Anyone who can write in a channel must also be able to read it.");
    }

    /// <summary>Everyone gets their own up-to-date channel list (what's visible depends on your role).</summary>
    internal static void BroadcastChannels(Session s)
    {
        foreach (var session in s.Hub.Sessions)
        {
            var member = session.CurrentMember();
            if (member is not null) session.Send(s.Hub.ChannelsEvent(member));
        }
    }

    /// <summary>Threads are managed with thread.update/thread.delete, not as channels.</summary>
    internal static Channel ManagedChannel(Session s, Member me, Body body) =>
        s.World.Store.GetChannel(body.Long("id")) is { Kind: not "thread" } channel && Permissions.CanRead(me, channel)
            ? channel : throw RequestException.NotFound("Channel");

    private static object Create(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var kind = body.OptionalString("kind", 16) ?? "text";
        if (!Kinds.Contains(kind)) throw RequestException.BadRequest("'kind' must be text, voice, forum or stage.");
        var readRole = Role(body, "readRole", Roles.Member);
        var writeRole = Role(body, "writeRole", readRole);
        CheckRoles(readRole, writeRole);

        var slowmode = ModerationFeature.SlowmodeField(body) ?? 0;
        var categoryId = OrganizeFeature.OptionalCategory(s, body);
        var channel = s.World.Store.CreateChannel(ChannelName(body.String("name", 256)), kind, readRole, writeRole, s.Now);
        if (slowmode > 0) s.World.Store.SetSlowmode(channel.Id, slowmode);
        if (categoryId is not null)
        {
            s.World.Store.SetChannelCategory(channel.Id, categoryId);
            channel = channel with { CategoryId = categoryId };
        }
        Audit.Record(s, "channel.create", details: new { channelId = channel.Id, name = channel.Name, kind, readRole, writeRole, slowmode });
        BroadcastChannels(s);
        return new { channel = Hub.PublicChannel(channel, slowmode) };
    }

    private static object Update(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var channel = ManagedChannel(s, me, body);
        var name = body.OptionalString("name", 256) is { } raw ? ChannelName(raw) : channel.Name;
        var updated = channel with
        {
            Name = name,
            ReadRole = Role(body, "readRole", channel.ReadRole),
            WriteRole = Role(body, "writeRole", channel.WriteRole),
        };
        CheckRoles(updated.ReadRole, updated.WriteRole);
        var oldSlowmode = s.World.Store.Slowmode(channel.Id);
        var slowmode = ModerationFeature.SlowmodeField(body) ?? oldSlowmode;

        s.World.Store.UpdateChannel(updated);
        if (slowmode != oldSlowmode) s.World.Store.SetSlowmode(channel.Id, slowmode);
        var changes = new Dictionary<string, object>();
        if (updated.Name != channel.Name) changes["name"] = new { from = channel.Name, to = updated.Name };
        if (updated.ReadRole != channel.ReadRole) changes["readRole"] = new { from = channel.ReadRole, to = updated.ReadRole };
        if (updated.WriteRole != channel.WriteRole) changes["writeRole"] = new { from = channel.WriteRole, to = updated.WriteRole };
        if (slowmode != oldSlowmode) changes["slowmode"] = new { from = oldSlowmode, to = slowmode };
        if (changes.Count > 0) Audit.Record(s, "channel.update", details: new { channelId = channel.Id, name = updated.Name, changes });
        BroadcastChannels(s);
        s.Voice.EnforceAccess();
        return new { channel = Hub.PublicChannel(updated, slowmode) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var channel = ManagedChannel(s, me, body);
        Audit.Record(s, "channel.delete", details: new { channelId = channel.Id, name = channel.Name, kind = channel.Kind });
        s.World.Store.DeleteChannel(channel.Id);
        BroadcastChannels(s);
        s.Voice.EnforceAccess();
        return null;
    }
}

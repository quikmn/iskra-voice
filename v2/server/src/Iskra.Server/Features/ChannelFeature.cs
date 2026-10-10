using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

public static class ChannelFeature
{
    public const int MaxNameLength = 32;
    private static readonly string[] Kinds = ["text", "voice"];

    public static void Register(Router router)
    {
        router.Add("channel.create", Create);
        router.Add("channel.update", Update);
        router.Add("channel.delete", Delete);
    }

    private static void RequireAdmin(Member me)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can manage channels.");
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
            if (member is not null) session.Send(Frames.Event("channels", new { channels = s.Hub.VisibleChannels(member) }));
        }
    }

    private static object Create(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var kind = body.OptionalString("kind", 16) ?? "text";
        if (!Kinds.Contains(kind)) throw RequestException.BadRequest("'kind' must be text or voice.");
        var readRole = Role(body, "readRole", Roles.Member);
        var writeRole = Role(body, "writeRole", readRole);
        CheckRoles(readRole, writeRole);

        var channel = s.World.Store.CreateChannel(ChannelName(body.String("name", 256)), kind, readRole, writeRole, s.Now);
        BroadcastChannels(s);
        return new { channel = Hub.PublicChannel(channel) };
    }

    private static object Update(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var channel = s.World.Store.GetChannel(body.Long("id")) ?? throw RequestException.NotFound("Channel");
        var name = body.OptionalString("name", 256) is { } raw ? ChannelName(raw) : channel.Name;
        var updated = channel with
        {
            Name = name,
            ReadRole = Role(body, "readRole", channel.ReadRole),
            WriteRole = Role(body, "writeRole", channel.WriteRole),
        };
        CheckRoles(updated.ReadRole, updated.WriteRole);

        s.World.Store.UpdateChannel(updated);
        BroadcastChannels(s);
        return new { channel = Hub.PublicChannel(updated) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var channel = s.World.Store.GetChannel(body.Long("id")) ?? throw RequestException.NotFound("Channel");
        s.World.Store.DeleteChannel(channel.Id);
        BroadcastChannels(s);
        return null;
    }
}

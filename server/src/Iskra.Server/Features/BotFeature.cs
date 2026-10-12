using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Bots are ordinary Iskra identities that say <c>profile.bot: true</c> when they connect. They can only join with a
/// bot invite (made by an admin), are marked as bots for everyone, can't join voice, create invites or become admins,
/// and have the same rate limits as everyone else.
/// </summary>
public static class BotFeature
{
    /// <summary>The highest role a bot can have.</summary>
    public const string MaxRole = Roles.Trusted;

    public static void Register(Router router)
    {
        router.Add("bot.invite", CreateInvite);
    }

    /// <summary>A bot invite only works for a bot, and a bot can only join with a bot invite.</summary>
    public static bool InviteFits(Store store, string code, bool isBot) => store.IsBotInvite(code) == isBot;

    public static void Joined(Store store, string accountKey, string code, long now) =>
        store.AddBot(accountKey, store.GetInvite(code)?.CreatedBy ?? "", now);

    /// <summary>Single use: one invite per bot.</summary>
    private static object CreateInvite(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can add bots.", "admins_add_bots");
        var role = body.OptionalString("role", 16) ?? Roles.Member;
        if (!Roles.IsValid(role) || Roles.Rank(role) > Roles.Rank(MaxRole))
            throw RequestException.BadRequest("Bots can be guest, member or trusted.", "bot_roles");
        var lifetimeMs = body.OptionalLong("expiresInMs", min: 60_000, max: (long)InviteFeature.MaxLifetime.TotalMilliseconds)
            ?? (long)InviteFeature.DefaultLifetime.TotalMilliseconds;

        var invite = s.World.Store.CreateInvite(InviteFeature.NewCode(), me.AccountKey, role, s.Now, s.Now + lifetimeMs, maxUses: 1);
        s.World.Store.MarkBotInvite(invite.Code);
        Audit.Record(s, "bot.invite", details: new { role, expiresAt = invite.ExpiresAt });
        return new { invite = InviteFeature.PublicInvite(invite) };
    }
}

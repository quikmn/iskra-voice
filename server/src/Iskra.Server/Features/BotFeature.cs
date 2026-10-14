using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Bots are ordinary Iskra identities that say <c>profile.bot: true</c> when they connect. They can only join with a
/// bot invite (made by an admin), are marked as bots for everyone, join voice only when an admin allows it, can't create invites or become admins,
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

    public static void Joined(Store store, string accountKey, string code, long now)
    {
        store.AddBot(accountKey, store.GetInvite(code)?.CreatedBy ?? "", now, store.BotInviteReadsAll(code));
        store.SetBotVoice(accountKey, store.BotInviteVoice(code)); // VoiceBotFeature
    }

    /// <summary>Single use: one invite per bot.</summary>
    private static object CreateInvite(Session s, Member me, Body body)
    {
        if (!BaseRoles.Allows(me, BaseAbility.Bots)) throw RequestException.Forbidden("Only admins can add bots.", "admins_add_bots");
        var role = body.OptionalString("role", 16) ?? Roles.Member;
        if (!Roles.IsValid(role) || Roles.Rank(role) > Roles.Rank(MaxRole))
            throw RequestException.BadRequest("Bots can be guest, member or trusted.", "bot_roles");
        var lifetimeMs = body.OptionalLong("expiresInMs", min: 60_000, max: (long)InviteFeature.MaxLifetime.TotalMilliseconds)
            ?? (long)InviteFeature.DefaultLifetime.TotalMilliseconds;

        var invite = s.World.Store.CreateInvite(InviteFeature.NewCode(), me.AccountKey, role, s.Now, s.Now + lifetimeMs, maxUses: 1);
        // "Can read all messages" is the admin's explicit choice; by default a bot gets its commands and mentions only.
        var readAll = body.OptionalBool("readAll") ?? false;
        s.World.Store.MarkBotInvite(invite.Code, readAll);
        // Joining voice is off unless the admin allows it (VoiceBotFeature).
        var voice = body.OptionalBool("voice") ?? false;
        if (voice) s.World.Store.SetBotInviteVoice(invite.Code, true);
        Audit.Record(s, "bot.invite", details: new { role, expiresAt = invite.ExpiresAt, readAll, voice });
        return new { invite = InviteFeature.PublicInvite(invite) };
    }
}

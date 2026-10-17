using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Deleting an account (signed by the account key, so only its owner can) and handing a server to a new owner,
/// which an owner needs to do before deleting their account.
/// </summary>
public static class AccountFeature
{
    public const string DeleteContext = "iskra/account-delete/v1";
    private const long ClockSkew = 10 * 60 * 1000;

    public static void Register(Router router)
    {
        router.Add("account.delete", Delete);
        router.Add("owner.transfer", Transfer);
    }

    public static bool Verify(AccountDeletion d)
    {
        if (d.DeletedAt < 0) return false;
        if (!Ed25519.TryFromB64u(d.AccountKey, out var account) || account.Length != Ed25519.PublicKeySize) return false;
        if (!Ed25519.TryFromB64u(d.Sig, out var sig)) return false;
        return Ed25519.Verify(account, Ed25519.Payload(DeleteContext, account, Ed25519.U64BigEndian(d.DeletedAt), [(byte)(d.Messages ? 1 : 0)]), sig);
    }

    public static object View(AccountDeletion d) => new { accountKey = d.AccountKey, deletedAt = d.DeletedAt, messages = d.Messages, sig = d.Sig };

    /// <summary>The handshake refuses a deleted account and hands its devices the signed deletion, so they can sign out too.</summary>
    internal static (string Code, string Message, object Extra)? OnAuth(Store store, DeviceCert cert) =>
        store.GetDeletion(cert.AccountKey) is { } d ? ("account_deleted", "This account was deleted.", new { deletion = View(d) }) : null;

    private static object? Delete(Session s, Member me, Body body)
    {
        var raw = body.OptionalElement("deletion") ?? throw RequestException.BadRequest("'deletion' is required.");
        if (raw.ValueKind != System.Text.Json.JsonValueKind.Object) throw RequestException.BadRequest("'deletion' must be an object.");
        var fields = new Body(raw);
        var deletion = new AccountDeletion(
            fields.String("accountKey", 64),
            fields.OptionalLong("deletedAt", 0, s.Now + ClockSkew) ?? throw RequestException.BadRequest("'deletedAt' is required."),
            fields.OptionalBool("messages") ?? throw RequestException.BadRequest("'messages' is required."),
            fields.String("sig", 128));
        if (deletion.AccountKey != me.AccountKey) throw RequestException.Forbidden("You can only delete your own account.");
        if (!Verify(deletion)) throw RequestException.BadRequest("Invalid deletion signature.");
        if (me.Role == Roles.Owner)
            throw RequestException.Forbidden("You own this server. Give it to someone else first (Transfer ownership), or shut it down.", "owner_cant_delete");
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots are removed by their owner.");

        var store = s.World.Store;
        var messages = deletion.Messages ? store.MessagesBy(me.AccountKey) : [];
        var channels = messages.Select(m => m.ChannelId).Distinct().Select(store.GetChannel).OfType<Channel>().ToList();
        store.RecordDeparture(me.AccountKey, "", "deleted", null, s.Now); // no name: they asked to be forgotten
        store.DeleteAccount(deletion, s.Now);
        SecurityLog.Record(s.World.Store, s.Now, "account.delete", me.AccountKey, details: new { messages = deletion.Messages });

        // Threads and forums whose messages went: forum posts lose their first message, threads their counts.
        foreach (var channel in channels)
        {
            if (channel.Kind == "forum")
                foreach (var (id, _) in messages.Where(m => m.ChannelId == channel.Id)) ForumFeature.RootDeleted(s, channel, id);
            else ThreadFeature.Touched(s, channel);
        }

        s.Voice.RemoveEverywhere(me.AccountKey);
        s.Hub.Outhooks?.MemberLeft(me.AccountKey, "", "deleted"); // no name: they asked to be forgotten
        var own = Frames.Event("account.deleted", new { deletion = View(deletion) });
        var others = Frames.Event("member.deleted", new { accountKey = me.AccountKey, messages = deletion.Messages });
        foreach (var session in s.Hub.Sessions)
        {
            if (session.AccountKey == me.AccountKey) session.Send(own);
            else
            {
                session.Send(Frames.Event("member.removed", new { accountKey = me.AccountKey }));
                session.Send(others);
            }
        }
        s.Voice.EnforceAccess();
        s.AfterReply(() => s.Hub.Disconnect(me.AccountKey, CloseCodes.Forbidden, "Your account was deleted.", "kicked_deleted"));
        return null;
    }

    private static object? Transfer(Session s, Member me, Body body)
    {
        if (!BaseRoles.Allows(me, BaseAbility.TransferOwnership)) throw RequestException.Forbidden("Only the owner can hand over the server.", "owner_transfer");
        var key = body.String("accountKey", 64);
        if (key == me.AccountKey) throw RequestException.BadRequest("You already own this server.", "already_owner");
        var target = s.World.Store.GetMember(key) ?? throw RequestException.NotFound("Member");
        if (s.World.Store.IsBot(key)) throw RequestException.BadRequest("Bots can't own a server.", "bot_owner");

        Audit.Record(s, "owner.transfer", key, details: new { from = target.Role });
        s.World.Store.TransferOwnership(me.AccountKey, key);
        foreach (var k in new[] { key, me.AccountKey })
        {
            if (s.World.Store.GetMember(k) is not { } m) continue;
            s.Hub.Broadcast(Frames.Event("member.updated", new { member = s.Hub.PublicMember(m) }));
            s.Hub.RefreshChannels(k);
        }
        s.Voice.EnforceAccess();
        return null;
    }
}

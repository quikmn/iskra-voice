using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>Leaving a server on your own (signing out of a device and taking a throwaway account off member lists).</summary>
public static class LeaveFeature
{
    public static void Register(Router router) => router.Add("member.leave", Leave);

    private static object? Leave(Session s, Member me, Body body)
    {
        // The server would be left without an owner; bots are managed by their owner.
        if (me.Role == Roles.Owner) throw RequestException.Forbidden("The owner can't leave their own server.", "owner_cant_leave");
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't leave on their own.");
        s.World.Store.RemoveMember(me.AccountKey);
        s.Hub.Broadcast(Frames.Event("member.removed", new { accountKey = me.AccountKey }));
        s.Voice.EnforceAccess();
        // Every session of the account closes, this one right after its answer.
        s.AfterReply(() => s.Hub.Disconnect(me.AccountKey, CloseCodes.Forbidden, "You left this server.", "kicked_left"));
        return null;
    }
}

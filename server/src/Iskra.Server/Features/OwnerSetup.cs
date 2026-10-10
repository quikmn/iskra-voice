using System.Text;
using Iskra.Server.Crypto;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// A new world has no owner. On startup we make a single-use owner invite and write it to owner-invite.txt,
/// so whoever started the server (and can read its folder) becomes the owner. No race, no "first to connect wins".
/// </summary>
public static class OwnerSetup
{
    public const string FileName = "owner-invite.txt";

    public static string InviteLink(World world, string code) =>
        $"{world.Settings.AppUrl.TrimEnd('/')}/#/join/" +
        $"{Ed25519.ToB64u(Encoding.UTF8.GetBytes(world.Settings.EffectivePublicUrl))}.{Ed25519.ToB64u(world.ServerPublicKey)}.{code}";

    /// <summary>Returns the owner invite link if the world still needs an owner, otherwise null.</summary>
    public static string? EnsureOwnerInvite(World world, long now)
    {
        var path = Path.Combine(world.Path, FileName);
        if (world.Store.HasOwner())
        {
            File.Delete(path);
            return null;
        }

        var invite = world.Store.ActiveInvites(now).FirstOrDefault(i => i.Role == Roles.Owner)
            ?? world.Store.CreateInvite(InviteFeature.NewCode(), "server", Roles.Owner, now, expiresAt: null, maxUses: 1);
        var link = InviteLink(world, invite.Code);
        AtomicFile.WriteAllText(path, link + "\n");
        return link;
    }

    public static void OwnerJoined(World world) => File.Delete(Path.Combine(world.Path, FileName));
}

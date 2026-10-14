using Iskra.Server.Crypto;
using Iskra.Server.Hosting;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// "Let friends connect without port forwarding" (experimental): the owner's opt-in, the p2p secret in p2p.key, and
/// what members need to make invites that carry it (see PROTOCOL.md, "Connecting without port forwarding"). The
/// tunnel itself runs in the desktop app that hosts the server, or in the iskra-p2p sidecar of a standalone server
/// (<see cref="P2pSidecar"/>), and reaches us on the tunnel listener.
/// </summary>
public static class P2pFeature
{
    public const string KeyFile = "p2p.key";

    public static void Register(Router router, TunnelListener tunnel, Voice.LiveKitHost? livekit, P2pSidecar? sidecar = null)
    {
        router.Add("p2p.status", (s, me, _) => { RequireOwner(me); return new { status = Status(s.World, s.Hub, tunnel, sidecar) }; });
        router.Add("p2p.set", (s, me, body) => Set(s, me, body, tunnel, livekit, sidecar));
        router.Add("p2p.rotate", (s, me, _) => Rotate(s, me, tunnel, sidecar));
    }

    private static void RequireOwner(Member me)
    {
        if (!BaseRoles.Allows(me, BaseAbility.RunServer)) throw RequestException.Forbidden("Only the owner can change how friends connect.", "owner_p2p");
    }

    /// <summary>The secret from p2p.key, or null when the file is missing or damaged.</summary>
    public static byte[]? Secret(World world)
    {
        var path = Path.Combine(world.Path, KeyFile);
        if (!File.Exists(path)) return null;
        return Ed25519.TryFromB64u(File.ReadAllText(path).Trim(), out var secret) && secret.Length == P2pKeys.SecretSize ? secret : null;
    }

    /// <summary>What members get in welcome and server.p2p: the secret while the feature is on, else null.</summary>
    public static string? SecretForMembers(World world) =>
        world.Settings.P2p.Enabled && Secret(world) is { } secret ? Ed25519.ToB64u(secret) : null;

    /// <summary>Makes sure p2p.key exists (a server started with P2p on, or the owner turning it on).</summary>
    public static byte[] EnsureSecret(World world)
    {
        if (Secret(world) is { } existing) return existing;
        var secret = P2pKeys.NewSecret();
        AtomicFile.WriteAllText(Path.Combine(world.Path, KeyFile), Ed25519.ToB64u(secret) + "\n");
        return secret;
    }

    public static object Status(World world, Hub hub, TunnelListener tunnel, P2pSidecar? sidecar = null)
    {
        var enabled = world.Settings.P2p.Enabled;
        var secret = enabled ? Secret(world) : null;
        var path = Path.Combine(world.Path, KeyFile);
        return new
        {
            enabled,
            hostKey = secret is null ? null : P2pKeys.HostPublicKeyHex(secret),
            tunnelPort = tunnel.Port,
            since = secret is null ? (long?)null : new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds(),
            connected = hub.Sessions.Count(s => s.Tunnelled),
            // The standalone server's own tunnel; null when the desktop app hosting it runs the tunnel.
            tunnel = sidecar?.View(),
        };
    }

    private static object Set(Session s, Member me, Body body, TunnelListener tunnel, Voice.LiveKitHost? livekit, P2pSidecar? sidecar)
    {
        RequireOwner(me);
        var enabled = body.OptionalBool("enabled") ?? throw RequestException.BadRequest("'enabled' must be true or false.");
        if (enabled) EnsureSecret(s.World);
        var changed = s.World.Settings.P2p.Enabled != enabled;
        if (changed)
        {
            s.World.UpdateSettings(w => w with { P2p = w.P2p with { Enabled = enabled } });
            livekit?.Restart(); // TURN comes and goes with the feature
            sidecar?.Changed();
            Announce(s.World, s.Hub);
        }
        Audit.Record(s, "server.p2p", details: new { enabled });
        return new { status = Status(s.World, s.Hub, tunnel, sidecar) };
    }

    private static object Rotate(Session s, Member me, TunnelListener tunnel, P2pSidecar? sidecar)
    {
        RequireOwner(me);
        var secret = P2pKeys.NewSecret();
        AtomicFile.WriteAllText(Path.Combine(s.World.Path, KeyFile), Ed25519.ToB64u(secret) + "\n");
        if (s.World.Settings.P2p.Enabled)
        {
            sidecar?.Rotated(); // announces the new key
            Announce(s.World, s.Hub);
        }
        Audit.Record(s, "server.p2p.rotate");
        return new { status = Status(s.World, s.Hub, tunnel, sidecar) };
    }

    /// <summary>Everyone learns the current secret (or that there is none), so their invite links stay right.</summary>
    private static void Announce(World world, Hub hub) =>
        hub.Broadcast(Frames.Event("server.p2p", new { p2p = SecretForMembers(world) }));
}

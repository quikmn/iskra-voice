using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>"This server moved to &lt;url&gt;", signed with the server key, so clients can follow it safely.</summary>
public sealed record MoveNotice(string ServerKey, string Url, long MovedAt, string Sig);

/// <summary>
/// Moving a server to another computer: after restoring a backup there, the owner publishes a signed notice here.
/// Clients check it against the server key they already trust and switch to the new address. While a notice is
/// up, this copy refuses everything except a few owner tools, so nobody keeps writing into the old one.
/// </summary>
public static class MoveFeature
{
    public const string Context = "iskra/server-moved/v1";
    public const string FileName = "moved.json";
    public const int MaxUrlLength = 512;

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };

    /// <summary>Requests that still work on a server that has moved.</summary>
    private static readonly HashSet<string> AllowedWhileMoved =
        ["ping", "server.move", "server.move.cancel", "backup.create", "backup.status", "host.status", "host.internet.set"];

    public static void Register(Router router)
    {
        router.Add("server.move", Move);
        router.Add("server.move.cancel", Cancel);
    }

    public static void MapEndpoints(WebApplication app) =>
        app.MapGet("/.well-known/iskra-moved", (HttpContext context, World world) =>
        {
            Files.Uploads.AllowCors(context);
            context.Response.Headers.CacheControl = "no-store";
            return world.Moved is { } notice ? Results.Json(View(notice)) : Results.NotFound();
        });

    public static object View(MoveNotice n) => new { serverKey = n.ServerKey, url = n.Url, movedAt = n.MovedAt, sig = n.Sig };

    public static byte[] Payload(byte[] serverKey, long movedAt, string url) =>
        Ed25519.Payload(Context, serverKey, Ed25519.U64BigEndian(movedAt), Encoding.UTF8.GetBytes(url));

    public static MoveNotice Sign(World world, string url, long now)
    {
        var sig = Ed25519.Sign(world.ServerKey, Payload(world.ServerPublicKey, now, url));
        return new MoveNotice(Ed25519.ToB64u(world.ServerPublicKey), url, now, Ed25519.ToB64u(sig));
    }

    public static bool Verify(MoveNotice n, byte[] serverKey) =>
        Ed25519.ToB64u(serverKey) == n.ServerKey && Ed25519.TryFromB64u(n.Sig, out var sig) && Ed25519.Verify(serverKey, Payload(serverKey, n.MovedAt, n.Url), sig);

    /// <summary>An absolute http(s) address without credentials, query or fragment, without a trailing slash; null if invalid.</summary>
    public static string? CleanUrl(string? raw)
    {
        var text = raw?.Trim().TrimEnd('/');
        if (string.IsNullOrEmpty(text) || text.Length > MaxUrlLength) return null;
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")) return null;
        if (uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.Host.Length == 0) return null;
        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
    }

    /// <summary>Loads moved.json at startup (a notice that doesn't verify is ignored).</summary>
    public static void Load(World world)
    {
        var path = Path.Combine(world.Path, FileName);
        if (!File.Exists(path)) return;
        try
        {
            var notice = JsonSerializer.Deserialize<MoveNotice>(File.ReadAllText(path), Json);
            if (notice is not null && Verify(notice, world.ServerPublicKey)) world.Moved = notice;
        }
        catch (JsonException) { /* not ours */ }
    }

    /// <summary>Publishes a notice (also used by `iskra-server move` while the server is stopped).</summary>
    public static MoveNotice Publish(World world, string url, long now)
    {
        var notice = Sign(world, url, now);
        AtomicFile.WriteAllText(Path.Combine(world.Path, FileName), JsonSerializer.Serialize(notice, Json));
        world.Moved = notice;
        return notice;
    }

    /// <summary>Called by the router for every request: true if it was refused because the server moved.</summary>
    public static bool Refuse(Session session, Envelope request)
    {
        if (session.World.Moved is not { } notice || AllowedWhileMoved.Contains(request.Type)) return false;
        session.Send(Frames.Error(request.Id, "moved", $"This server has moved to {notice.Url}."));
        return true;
    }

    private static void RequireOwner(Member me)
    {
        if (me.Role != Roles.Owner) throw RequestException.Forbidden("Only the owner can move this server.", "owner_move");
    }

    private static object Move(Session s, Member me, Body body)
    {
        RequireOwner(me);
        var url = CleanUrl(body.String("url", MaxUrlLength * 2))
            ?? throw RequestException.BadRequest("Enter the new address, like https://chat.example.com or http://192.168.1.20:47070.", "move_address");
        var current = new[] { s.World.Settings.PublicUrl, s.World.InternetUrl, s.Origin }.Select(CleanUrl);
        if (current.Contains(url)) throw RequestException.BadRequest("That's this server's current address. Enter where it runs now.", "move_same_address");
        var notice = Publish(s.World, url, s.Now);
        SecurityLog.Record(s, "server.move", details: new { url });
        s.Hub.Broadcast(Frames.Event("server.moved", new { notice = View(notice) }));
        return new { notice = View(notice) };
    }

    private static object? Cancel(Session s, Member me, Body body)
    {
        RequireOwner(me);
        File.Delete(Path.Combine(s.World.Path, FileName));
        s.World.Moved = null;
        SecurityLog.Record(s, "server.move.cancel");
        s.Hub.Broadcast(Frames.Event("server.moved", new { notice = (object?)null }));
        return null;
    }
}

using Iskra.Server.Backups;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>Backups (owner only): an encrypted download of everything, and the automatic daily copies.</summary>
public static class BackupFeature
{
    public static void Register(Router router, BackupService backups)
    {
        router.AddAsync("backup.create", (s, me, body) => Create(backups, s, me, body));
        router.Add("backup.status", (s, me, _) => Status(backups, s, me));
        router.Add("backup.settings", (s, me, body) => Settings(backups, s, me, body));
    }

    public static void MapEndpoints(WebApplication app) =>
        app.MapGet("/backup/{token}", (HttpContext context, string token, BackupService backups) => backups.Serve(context, token));

    private static void RequireOwner(Member me)
    {
        if (me.Role != Roles.Owner) throw RequestException.Forbidden("Only the owner can back up this server.");
    }

    private static async Task<object?> Create(BackupService backups, Session s, Member me, Body body)
    {
        RequireOwner(me);
        var passphrase = body.String("passphrase", BackupFile.MaxPassphrase);
        if (passphrase.Trim().Length < BackupFile.MinPassphrase)
            throw RequestException.BadRequest($"Use a passphrase of at least {BackupFile.MinPassphrase} characters.");

        long lastSent = 0;
        void Progress(long done, long total)
        {
            // About every 2%, so a big backup doesn't flood the socket.
            if (done < total && done - lastSent < Math.Max(total / 50, 1)) return;
            lastSent = done;
            s.Send(Frames.Event("backup.progress", new { done, total }));
        }
        var made = await backups.CreateDownloadAsync(passphrase, Progress, CancellationToken.None)
            ?? throw new RequestException("rate_limited", "A backup is being made right now. Try again in a moment.");
        return new
        {
            url = $"/backup/{made.Token}",
            name = made.FileName,
            size = made.Size,
            expiresAt = s.Now + (long)BackupService.DownloadLifetime.TotalMilliseconds,
        };
    }

    private static object Status(BackupService backups, Session s, Member me)
    {
        RequireOwner(me);
        var settings = s.World.Settings.Backups;
        return new
        {
            auto = new { enabled = settings.Enabled, keep = Math.Clamp(settings.Keep, 1, 30), includeUploads = settings.IncludeUploads },
            local = backups.LocalBackups().Select(b => new { name = b.Name, size = b.Size, createdAt = b.CreatedAt }),
            folder = backups.Folder,
        };
    }

    private static object Settings(BackupService backups, Session s, Member me, Body body)
    {
        RequireOwner(me);
        var enabled = body.OptionalBool("enabled");
        var keep = body.OptionalLong("keep", min: 1, max: 30);
        var includeUploads = body.OptionalBool("includeUploads");
        s.World.UpdateSettings(w => w with
        {
            Backups = w.Backups with
            {
                Enabled = enabled ?? w.Backups.Enabled,
                Keep = (int?)keep ?? w.Backups.Keep,
                IncludeUploads = includeUploads ?? w.Backups.IncludeUploads,
            },
        });
        return Status(backups, s, me);
    }
}

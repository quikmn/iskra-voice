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

    public const string PassphraseContext = "iskra/backup-passphrase/v1";
    private const int MaxSealedLength = 4096;

    /// <summary>
    /// The passphrase never crosses the network in the clear: the client seals it to the server key
    /// (crypto_box_seal to its X25519 form) as context || 0x00 || serverKey(32) || utf8(passphrase).
    /// </summary>
    public static string? OpenPassphrase(World world, string sealedB64u)
    {
        if (!Crypto.Ed25519.TryFromB64u(sealedB64u, out var sealedBox)) return null;
        var seed = world.ServerKey.Export(NSec.Cryptography.KeyBlobFormat.RawPrivateKey);
        try
        {
            var plain = Crypto.Sodium.OpenSealedWithEd25519(sealedBox, seed, world.ServerPublicKey);
            if (plain is null) return null;
            var prefix = Crypto.Ed25519.Payload(PassphraseContext, world.ServerPublicKey);
            if (!plain.AsSpan().StartsWith(prefix)) return null;
            try
            {
                var text = new System.Text.UTF8Encoding(false, throwOnInvalidBytes: true).GetString(plain, prefix.Length, plain.Length - prefix.Length);
                return text.Length is > 0 and <= BackupFile.MaxPassphrase ? text : null;
            }
            catch (ArgumentException) { return null; }
            finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(plain); }
        }
        finally
        {
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(seed);
        }
    }

    private static void RequireOwner(Member me)
    {
        if (!BaseRoles.Allows(me, BaseAbility.RunServer)) throw RequestException.Forbidden("Only the owner can back up this server.", "owner_backup");
    }

    private static async Task<object?> Create(BackupService backups, Session s, Member me, Body body)
    {
        RequireOwner(me);
        if (body.OptionalString("passphrase", BackupFile.MaxPassphrase) is not null)
            throw RequestException.BadRequest("Send the passphrase sealed to the server key ('sealedPassphrase'), never in the clear.");
        var passphrase = OpenPassphrase(s.World, body.String("sealedPassphrase", MaxSealedLength))
            ?? throw RequestException.BadRequest("The passphrase couldn't be read. Reconnect and try again.", "passphrase_unreadable");
        if (passphrase.Trim().Length < BackupFile.MinPassphrase)
            throw RequestException.BadRequest($"Use a passphrase of at least {BackupFile.MinPassphrase} characters.", "passphrase_length", new { min = BackupFile.MinPassphrase });

        long lastSent = 0;
        void Progress(long done, long total)
        {
            // About every 2%, so a big backup doesn't flood the socket.
            if (done < total && done - lastSent < Math.Max(total / 50, 1)) return;
            lastSent = done;
            s.Send(Frames.Event("backup.progress", new { done, total }));
        }
        var made = await backups.CreateDownloadAsync(passphrase, Progress, CancellationToken.None)
            ?? throw new RequestException("rate_limited", "A backup is being made right now. Try again in a moment.", "backup_busy");
        SecurityLog.Record(s, "backup.download", details: new { size = made.Size });
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
            copyTo = string.IsNullOrWhiteSpace(settings.CopyTo) ? null : settings.CopyTo,
            copy = backups.LastCopy is { } copy
                ? new
                {
                    at = copy.At,
                    ok = copy.Ok,
                    name = copy.Name,
                    error = copy.Error is { } e ? new { code = e.Code, message = e.Message, key = e.Key, args = e.Args } : null,
                }
                : null,
        };
    }

    public const int MaxCopyToLength = 1024;

    private static object Settings(BackupService backups, Session s, Member me, Body body)
    {
        RequireOwner(me);
        var enabled = body.OptionalBool("enabled");
        var keep = body.OptionalLong("keep", min: 1, max: 30);
        var includeUploads = body.OptionalBool("includeUploads");
        // "copyTo": a folder for copies of each daily backup; "" or null stops them.
        var copyToGiven = body.Has("copyTo");
        string? copyTo = null;
        if (copyToGiven && !body.IsNull("copyTo"))
        {
            var text = body.String("copyTo", MaxCopyToLength).Trim();
            if (text.Length > 0)
            {
                if (BackupService.CheckCopyFolder(s.World.Path, text, out var full) is { } invalid) throw invalid;
                if (!Directory.Exists(full))
                    throw RequestException.BadRequest("That folder doesn't exist. Create it first (and connect the disk or share).", "backup_copy_not_found");
                copyTo = full;
            }
        }
        var before = s.World.Settings.Backups;
        s.World.UpdateSettings(w => w with
        {
            Backups = w.Backups with
            {
                Enabled = enabled ?? w.Backups.Enabled,
                Keep = (int?)keep ?? w.Backups.Keep,
                IncludeUploads = includeUploads ?? w.Backups.IncludeUploads,
                CopyTo = copyToGiven ? copyTo : w.Backups.CopyTo,
            },
        });
        var after = s.World.Settings.Backups;
        if (after != before)
        {
            SecurityLog.Record(s, "backup.settings", details: new { from = before, to = after });
            // Copy the newest daily backup there right away (or forget the old folder's status).
            if (after.CopyTo != before.CopyTo || after.Keep != before.Keep) _ = backups.CopyNowAsync();
        }
        return Status(backups, s, me);
    }
}

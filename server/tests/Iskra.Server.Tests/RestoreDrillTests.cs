using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Backups;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;
using Microsoft.Data.Sqlite;

namespace Iskra.Server.Tests;

/// <summary>
/// The backup and restore drill (evidence for backup and recovery): a server with real data is backed up through the app's
/// own request, the encrypted file is restored into a new folder, and the copy is checked: database integrity, the same rows
/// in every table, every uploaded file byte for byte, and the same server key. CI runs it on every push (job
/// backup-restore-drill) and keeps the report when ISKRA_DRILL_REPORT names a file.
/// </summary>
public class RestoreDrillTests
{
    private const string Passphrase = "drill passphrase, long enough";

    /// <summary>Tables whose counts legitimately differ: the security log notes the backup and the restore.</summary>
    private static readonly HashSet<string> Changing = ["security_log"];

    private static Dictionary<string, long> TableCounts(string db, out string integrity)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = db, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        connection.Open();
        using (var check = connection.CreateCommand())
        {
            check.CommandText = "PRAGMA integrity_check;";
            integrity = (string)check.ExecuteScalar()!;
        }
        var tables = new List<string>();
        using (var list = connection.CreateCommand())
        {
            // Real tables only: FTS shadow tables follow from messages.
            list.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name;";
            using var reader = list.ExecuteReader();
            while (reader.Read()) tables.Add(reader.GetString(0));
        }
        var counts = new Dictionary<string, long>();
        foreach (var table in tables)
        {
            using var count = connection.CreateCommand();
            count.CommandText = $"SELECT COUNT(*) FROM \"{table}\";";
            counts[table] = (long)count.ExecuteScalar()!;
        }
        return counts;
    }

    private static Dictionary<string, string> UploadHashes(string world)
    {
        var root = Path.Combine(world, "uploads");
        return Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Where(f => !Path.GetFileName(f).StartsWith('.'))
            .ToDictionary(f => Path.GetRelativePath(root, f).Replace('\\', '/'), f => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(f))));
    }

    [Fact]
    public async Task A_backup_restores_to_an_identical_server()
    {
        var clock = Stopwatch.StartNew();
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        // Some of everything: channel messages, a thread, reactions, a file, a DM envelope, a custom role.
        var first = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "first" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        for (var i = 0; i < 5; i++) await bob.RequestAsync("chat.send", new { channelId = server.General, text = $"message {i}" });
        await bob.RequestAsync("chat.react", new { id = first, emoji = "🎉" });
        Assert.Equal("result", (await alice.RequestAsync("thread.create", new { messageId = first, name = "plans" })).Type());
        var ticket = (await alice.RequestAsync("upload.begin", new { name = "photo.png", size = 12 })).Body().GetProperty("url").GetString();
        using (var put = await server.CreateClient().PutAsync(ticket, new ByteArrayContent([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 4, 3, 2, 1])))
        {
            var fileId = JsonDocument.Parse(await put.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString();
            await alice.RequestAsync("chat.send", new { channelId = server.General, text = "a picture", attachments = new[] { fileId } });
        }
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1, ct = "AAAA", keys = Array.Empty<object>() } });
        Assert.Equal("result", (await owner.RequestAsync("role.create", new { name = "Raid lead" })).Type());

        var sealedPassphrase = Ed25519.ToB64u(Sodium.SealToEd25519(Ed25519.Payload(Features.BackupFeature.PassphraseContext,
            server.World.ServerPublicKey, System.Text.Encoding.UTF8.GetBytes(Passphrase)), server.World.ServerPublicKey));
        var before = TableCounts(Path.Combine(server.WorldPath, "iskra.db"), out _);
        var made = await owner.RequestAsync("backup.create", new { sealedPassphrase });
        Assert.Equal("result", made.Type());
        var bytes = await server.CreateClient().GetByteArrayAsync(made.Body().GetProperty("url").GetString());
        Assert.True(BackupFile.LooksEncrypted(bytes));

        var file = Path.Combine(Path.GetTempPath(), $"iskra-drill-{Guid.NewGuid():N}.iskrabackup");
        var target = Path.Combine(Path.GetTempPath(), $"iskra-drill-{Guid.NewGuid():N}");
        try
        {
            await File.WriteAllBytesAsync(file, bytes);
            var result = BackupArchive.Restore(file, target, () => Passphrase);

            var restored = TableCounts(Path.Combine(target, "iskra.db"), out var integrity);
            var sourceFiles = UploadHashes(server.WorldPath);
            var restoredFiles = UploadHashes(target);
            var mismatched = before.Keys.Union(restored.Keys)
                .Where(t => !Changing.Contains(t) && before.GetValueOrDefault(t, -1) != restored.GetValueOrDefault(t, -1)).ToList();
            var keyMatches = result.ServerKey == Ed25519.ToB64u(server.World.ServerPublicKey);
            var filesMatch = sourceFiles.Count > 0 && sourceFiles.OrderBy(f => f.Key).SequenceEqual(restoredFiles.OrderBy(f => f.Key));
            var passed = integrity == "ok" && mismatched.Count == 0 && keyMatches && filesMatch && before["messages"] >= 7;

            if (Environment.GetEnvironmentVariable("ISKRA_DRILL_REPORT") is { Length: > 0 } reportPath)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(reportPath))!);
                await File.WriteAllTextAsync(reportPath, JsonSerializer.Serialize(new
                {
                    drill = "backup-restore",
                    ranAt = DateTimeOffset.UtcNow,
                    passed,
                    integrityCheck = integrity,
                    serverKeyMatches = keyMatches,
                    backupBytes = bytes.Length,
                    uploads = new { source = sourceFiles.Count, restored = restoredFiles.Count, identical = filesMatch },
                    tables = before.Keys.Union(restored.Keys).Order().ToDictionary(t => t, t => new
                    {
                        source = before.GetValueOrDefault(t, -1), restored = restored.GetValueOrDefault(t, -1), compared = !Changing.Contains(t),
                    }),
                    mismatched,
                    durationMs = clock.ElapsedMilliseconds,
                }, new JsonSerializerOptions { WriteIndented = true }));
            }

            Assert.Equal("ok", integrity);
            Assert.Empty(mismatched);
            Assert.True(keyMatches);
            Assert.True(filesMatch);
            Assert.True(before["messages"] >= 7);
            Assert.True(passed);
        }
        finally
        {
            File.Delete(file);
            try { Directory.Delete(target, recursive: true); } catch (IOException) { }
        }
    }
}

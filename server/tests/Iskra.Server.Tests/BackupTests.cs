using System.IO.Compression;
using System.Security.Cryptography;
using Iskra.Server.Backups;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class BackupTests
{
    private static string TempPath(string name) => Path.Combine(Path.GetTempPath(), $"iskra-{name}-{Guid.NewGuid():N}");

    /// <summary>Encrypts <paramref name="plain"/> with a cheap KDF (the real one costs ~256 MB and a second).</summary>
    private static byte[] Encrypt(byte[] plain, string passphrase)
    {
        using var output = new MemoryStream();
        using (var stream = BackupFile.Encrypt(output, passphrase, "key", "Test", 1, ops: 1, mem: 8 * 1024 * 1024)) stream.Write(plain);
        return output.ToArray();
    }

    private static byte[] Decrypt(byte[] file, string passphrase)
    {
        var (_, plain) = BackupFile.Decrypt(new MemoryStream(file), passphrase);
        using var result = new MemoryStream();
        plain.CopyTo(result);
        return result.ToArray();
    }

    [Fact]
    public void Encrypted_backups_round_trip_and_detect_tampering()
    {
        var plain = RandomNumberGenerator.GetBytes(200_000); // several chunks
        var file = Encrypt(plain, "correct horse battery");
        Assert.Equal(plain, Decrypt(file, "correct horse battery"));
        Assert.Equal("Test", BackupFile.ReadHeader(new MemoryStream(file)).Name);
        // Same text in another Unicode normal form is the same passphrase.
        Assert.Equal(plain[..10], Decrypt(Encrypt(plain[..10], "café passphrase"), "café passphrase"));

        Assert.Throws<CryptographicException>(() => Decrypt(file, "wrong horse battery"));

        // Cut off the last chunk: the final tag is missing.
        var truncated = file[..^1000];
        Assert.Throws<InvalidDataException>(() => Decrypt(truncated, "correct horse battery"));

        // A flipped byte in the middle.
        var flipped = (byte[])file.Clone();
        flipped[flipped.Length / 2] ^= 1;
        Assert.Throws<InvalidDataException>(() => Decrypt(flipped, "correct horse battery"));

        // The header (outside the encryption) is authenticated too: change the name it claims.
        var renamed = (byte[])file.Clone();
        var index = IndexOf(renamed, "\"Test\""u8.ToArray());
        renamed[index + 1] = (byte)'B';
        Assert.Throws<CryptographicException>(() => Decrypt(renamed, "correct horse battery"));

        // Absurd KDF costs in a crafted header are refused before any work.
        var greedy = System.Text.Encoding.UTF8.GetBytes(System.Text.Encoding.UTF8.GetString(file).Replace("\"mem\":8388608", "\"mem\":9999999999"));
        Assert.Throws<InvalidDataException>(() => BackupFile.ReadHeader(new MemoryStream(greedy)));
    }

    private static int IndexOf(byte[] haystack, byte[] needle)
    {
        for (var i = 0; i <= haystack.Length - needle.Length; i++)
            if (haystack.AsSpan(i, needle.Length).SequenceEqual(needle)) return i;
        return -1;
    }

    [Fact]
    public async Task Owner_downloads_an_encrypted_backup_that_restores_to_the_same_server()
    {
        using var server = new IskraServer();
        server.Services.GetRequiredService<BackupService>().KdfCost = (1, 8 * 1024 * 1024);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        await owner.RequestAsync("chat.send", new { channelId = server.General, text = "remember me" });
        var ticket = (await owner.RequestAsync("upload.begin", new { name = "cat.png", size = 8 })).Body();
        using (var put = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])))
            Assert.True(put.IsSuccessStatusCode);

        Assert.Equal("forbidden", (await admin.RequestAsync("backup.create", new { passphrase = "long enough passphrase" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("backup.create", new { passphrase = "short" })).ErrorCode());

        var made = await owner.RequestAsync("backup.create", new { passphrase = "long enough passphrase" });
        Assert.Equal("result", made.Type());
        var url = made.Body().GetProperty("url").GetString()!;
        Assert.EndsWith(".iskrabackup", made.Body().GetProperty("name").GetString());
        Assert.Equal("backup.progress", (await owner.EventAsync("backup.progress")).Type());

        using var response = await server.CreateClient().GetAsync(url);
        Assert.True(response.IsSuccessStatusCode);
        Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        Assert.True(BackupFile.LooksEncrypted(bytes));
        Assert.Equal(System.Net.HttpStatusCode.NotFound, (await server.CreateClient().GetAsync("/backup/not-a-token")).StatusCode);

        var file = TempPath("backup") + ".iskrabackup";
        var target = TempPath("restored");
        await File.WriteAllBytesAsync(file, bytes);
        try
        {
            Assert.Throws<CryptographicException>(() => BackupArchive.Restore(file, target, () => "wrong passphrase!!"));
            Assert.False(Directory.Exists(target)); // nothing left behind

            var result = BackupArchive.Restore(file, target, () => "long enough passphrase");
            Assert.Equal(Ed25519.ToB64u(server.World.ServerPublicKey), result.ServerKey);
            Assert.Equal(1, result.Uploads);
            using var restored = Storage.World.OpenOrCreate(target);
            Assert.Equal(server.World.ServerPublicKey, restored.ServerPublicKey);
            Assert.Contains(restored.Store.History(restored.Store.AllChannels().Single(c => c.Name == "general").Id, null, null, 10), m => m.Text == "remember me");
            Assert.Equal("owner", restored.Store.GetMember(owner.Key)!.Role);

            // A server already living in the folder is never overwritten.
            Assert.Throws<IOException>(() => BackupArchive.Restore(file, target, () => "long enough passphrase"));
        }
        finally
        {
            File.Delete(file);
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            try { Directory.Delete(target, true); } catch (IOException) { }
        }
    }

    [Fact]
    public async Task Daily_backups_are_kept_for_the_configured_days_and_restore_without_a_passphrase()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var backups = server.Services.GetRequiredService<BackupService>();
        Assert.True(backups.RunDaily());
        Assert.False(backups.RunDaily()); // one a day

        // Pretend there are older ones; only `Keep` survive.
        for (var day = 1; day <= 9; day++) File.WriteAllText(Path.Combine(backups.Folder, $"auto-2020-01-0{day}.zip"), "old");
        var status = (await owner.RequestAsync("backup.settings", new { keep = 3 })).Body();
        Assert.Equal(3, status.GetProperty("auto").GetProperty("keep").GetInt32());
        Assert.Equal(3, server.World.Settings.Backups.Keep);
        backups.RunDaily();
        var left = backups.LocalBackups();
        Assert.Equal(3, left.Count);
        Assert.StartsWith($"auto-{DateTime.Now:yyyy-MM-dd}", left[0].Name);
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(backups.Folder, left[0].Name)));

        var target = TempPath("auto-restored");
        try
        {
            var result = BackupArchive.Restore(Path.Combine(backups.Folder, left[0].Name), target, () => throw new InvalidOperationException("no passphrase needed"));
            Assert.Equal(Ed25519.ToB64u(server.World.ServerPublicKey), result.ServerKey);
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            try { Directory.Delete(target, true); } catch (IOException) { }
        }
        Assert.Equal("forbidden", (await (await server.JoinAsync("Admin", "admin")).RequestAsync("backup.status")).ErrorCode());
    }

    [Fact]
    public void Restore_only_writes_the_files_a_backup_is_made_of()
    {
        // A crafted plain zip: a real world's files plus entries trying to escape the folder.
        var source = TempPath("source");
        var zipPath = TempPath("evil") + ".zip";
        var target = TempPath("target");
        var outside = Path.Combine(Path.GetTempPath(), $"iskra-escaped-{Guid.NewGuid():N}.txt");
        try
        {
            string key;
            using (var world = Storage.World.OpenOrCreate(source))
            {
                key = Ed25519.ToB64u(world.ServerPublicKey);
                using var file = File.Create(zipPath);
                BackupArchive.Write(world, file, includeUploads: true, 0);
            }
            using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Update))
            {
                using (var w = new StreamWriter(zip.CreateEntry("../" + Path.GetFileName(outside)).Open())) w.Write("escaped");
                using (var w = new StreamWriter(zip.CreateEntry(outside.Replace('\\', '/')).Open())) w.Write("escaped");
                using (var w = new StreamWriter(zip.CreateEntry("uploads/ab/../../server.key").Open())) w.Write("bad");
                using (var w = new StreamWriter(zip.CreateEntry("uploads/ab/" + new string('a', 64)).Open())) w.Write("wrong hash");
            }
            // The upload whose content doesn't match its name fails the whole restore...
            Assert.Throws<InvalidDataException>(() => BackupArchive.Restore(zipPath, target, () => ""));
            Assert.False(File.Exists(outside));
            Assert.False(Directory.Exists(target));

            // ...and without it, the rest is ignored and the world restores.
            using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Update)) zip.GetEntry("uploads/ab/" + new string('a', 64))!.Delete();
            var result = BackupArchive.Restore(zipPath, target, () => "");
            Assert.Equal(key, result.ServerKey);
            Assert.False(File.Exists(outside));
            string[] allowed = ["iskra.db", "iskra.db-wal", "iskra.db-shm", "server.json", "server.key", "livekit.key", "vapid.json", "uploads"];
            Assert.All(Directory.EnumerateFileSystemEntries(target).Select(Path.GetFileName), name => Assert.Contains(name, allowed));
            Assert.Empty(Directory.EnumerateFileSystemEntries(Path.Combine(target, "uploads")));
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            foreach (var dir in new[] { source, target }) try { Directory.Delete(dir, true); } catch (IOException) { }
            File.Delete(zipPath);
            File.Delete(outside);
        }
    }
}

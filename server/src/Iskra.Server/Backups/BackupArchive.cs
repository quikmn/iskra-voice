using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Iskra.Server.Crypto;
using Iskra.Server.Storage;

namespace Iskra.Server.Backups;

public sealed record BackupManifest(int IskraBackup, long CreatedAt, string ServerKey, string Name, int Uploads, bool IncludesUploads);

public sealed record RestoreResult(string Name, string ServerKey, int Uploads, long Messages, string Folder);

/// <summary>
/// The zip inside a backup: manifest.json, iskra.db (an online snapshot), server.json and the keys
/// (server.key, livekit.key, vapid.json), and uploads/ab/&lt;sha256&gt;. Certificates aren't included:
/// the new machine gets its own. Restoring only ever writes these exact names.
/// </summary>
public static partial class BackupArchive
{
    public const string ManifestName = "manifest.json";
    public static readonly string[] WorldFiles = ["server.json", "server.key", "livekit.key", "vapid.json"];

    [GeneratedRegex("^uploads/[0-9a-f]{2}/[0-9a-f]{64}$")]
    private static partial Regex UploadEntry();

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };

    /// <summary>Upload files on disk, as (zip name, path). Half-written uploads (.incoming-*) are skipped.</summary>
    private static List<(string Name, string Path)> UploadFiles(string worldPath)
    {
        var root = Path.Combine(worldPath, "uploads");
        if (!Directory.Exists(root)) return [];
        var files = new List<(string, string)>();
        foreach (var dir in Directory.EnumerateDirectories(root))
        {
            var prefix = Path.GetFileName(dir);
            foreach (var file in Directory.EnumerateFiles(dir))
            {
                var name = $"uploads/{prefix}/{Path.GetFileName(file)}";
                if (UploadEntry().IsMatch(name) && Path.GetFileName(file).StartsWith(prefix, StringComparison.Ordinal)) files.Add((name, file));
            }
        }
        return files;
    }

    /// <summary>Writes the whole backup zip to <paramref name="output"/> (which needn't be seekable).</summary>
    public static BackupManifest Write(World world, Stream output, bool includeUploads, long now,
        Action<long, long>? progress = null, CancellationToken cancel = default)
    {
        var temp = Path.Combine(world.Path, "backups", $".snapshot-{Guid.NewGuid():N}.db");
        AtomicFile.CreatePrivateDirectory(Path.GetDirectoryName(temp)!);
        try
        {
            world.Store.Snapshot(temp);
            var uploads = includeUploads ? UploadFiles(world.Path) : [];
            var total = new FileInfo(temp).Length + uploads.Sum(u => SafeLength(u.Path));
            long done = 0;
            var manifest = new BackupManifest(1, now, Ed25519.ToB64u(world.ServerPublicKey), world.Settings.Name, uploads.Count, includeUploads);

            using var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true);
            void Add(string name, string path, CompressionLevel level)
            {
                cancel.ThrowIfCancellationRequested();
                using var source = File.OpenRead(path);
                using var entry = zip.CreateEntry(name, level).Open();
                var buffer = new byte[81920];
                int read;
                while ((read = source.Read(buffer)) > 0)
                {
                    entry.Write(buffer, 0, read);
                    done += read;
                    progress?.Invoke(done, total);
                }
            }
            using (var entry = zip.CreateEntry(ManifestName, CompressionLevel.Fastest).Open())
                JsonSerializer.Serialize(entry, manifest, Json);
            Add("iskra.db", temp, CompressionLevel.Fastest);
            foreach (var name in WorldFiles)
            {
                var path = Path.Combine(world.Path, name);
                if (File.Exists(path)) Add(name, path, CompressionLevel.Fastest);
            }
            // Media is already compressed; storing it as is keeps backups fast.
            foreach (var (name, path) in uploads)
            {
                try { Add(name, path, CompressionLevel.NoCompression); }
                catch (FileNotFoundException) { /* swept meanwhile */ }
            }
            return manifest;
        }
        finally
        {
            File.Delete(temp);
        }
    }

    private static long SafeLength(string path)
    {
        try { return new FileInfo(path).Length; }
        catch (IOException) { return 0; }
    }

    /// <summary>
    /// Restores a backup (encrypted, or a plain automatic one) into <paramref name="target"/>, which must not exist
    /// or be empty. <paramref name="passphrase"/> is asked only for encrypted backups. On failure nothing is left behind.
    /// </summary>
    public static RestoreResult Restore(string backupPath, string target, Func<string> passphrase, Action<string>? log = null)
    {
        target = Path.GetFullPath(target);
        if (Directory.Exists(target) && Directory.EnumerateFileSystemEntries(target).Any())
            throw new IOException($"{target} isn't empty. Restore into a new folder, so no server is overwritten by accident.");
        if (File.Exists(target)) throw new IOException($"{target} is a file.");

        var createdTarget = !Directory.Exists(target);
        AtomicFile.CreatePrivateDirectory(target);
        string? plainZip = null;
        try
        {
            using var input = File.OpenRead(backupPath);
            var head = new byte[8];
            var got = input.ReadAtLeast(head, head.Length, throwOnEndOfStream: false);
            input.Position = 0;
            Stream zipStream;
            if (BackupFile.LooksEncrypted(head.AsSpan(0, got)))
            {
                // Zip reading needs to seek: decrypt to a private temp file next to the new world first.
                var (_, plain) = BackupFile.Decrypt(input, passphrase());
                plainZip = Path.Combine(target, $".restore-{Guid.NewGuid():N}.zip");
                using (var file = PrivateCreate(plainZip)) plain.CopyTo(file);
                zipStream = File.OpenRead(plainZip);
            }
            else if (got >= 4 && head[0] == 'P' && head[1] == 'K')
            {
                zipStream = input;
            }
            else
            {
                throw new InvalidDataException("This isn't an Iskra backup.");
            }

            BackupManifest manifest;
            var uploads = 0;
            using (zipStream)
            using (var zip = new ZipArchive(zipStream, ZipArchiveMode.Read, leaveOpen: false))
            {
                var manifestEntry = zip.GetEntry(ManifestName) ?? throw new InvalidDataException("This isn't an Iskra backup (no manifest).");
                if (manifestEntry.Length > 64 * 1024) throw new InvalidDataException("The backup is damaged.");
                using (var stream = manifestEntry.Open())
                {
                    try { manifest = JsonSerializer.Deserialize<BackupManifest>(stream, Json) ?? throw new InvalidDataException("The backup is damaged."); }
                    catch (JsonException) { throw new InvalidDataException("The backup is damaged."); }
                }
                if (manifest.IskraBackup != 1) throw new InvalidDataException("This backup was made by a newer Iskra. Update iskra-server.");
                if (zip.GetEntry("iskra.db") is null || zip.GetEntry("server.key") is null) throw new InvalidDataException("The backup is missing its database or key.");

                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var entry in zip.Entries)
                {
                    var name = entry.FullName;
                    if (name == ManifestName || name.EndsWith('/')) continue;
                    // Only names we wrote ourselves; anything else (../, absolute paths, odd files) is ignored.
                    var known = name == "iskra.db" || WorldFiles.Contains(name);
                    var upload = !known && UploadEntry().IsMatch(name);
                    if ((!known && !upload) || !seen.Add(name))
                    {
                        log?.Invoke($"Skipping unexpected entry {name}");
                        continue;
                    }
                    var path = Path.Combine(target, name.Replace('/', Path.DirectorySeparatorChar));
                    if (upload) AtomicFile.CreatePrivateDirectory(Path.GetDirectoryName(path)!);
                    using var source = entry.Open();
                    using var output = PrivateCreate(path);
                    if (upload)
                    {
                        // Uploads are stored by their SHA-256: check every one.
                        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                        var buffer = new byte[81920];
                        int read;
                        while ((read = source.Read(buffer)) > 0)
                        {
                            sha.AppendData(buffer, 0, read);
                            output.Write(buffer, 0, read);
                        }
                        if (Convert.ToHexStringLower(sha.GetHashAndReset()) != Path.GetFileName(path))
                            throw new InvalidDataException($"The backup is damaged ({name} doesn't match its checksum).");
                        uploads++;
                    }
                    else
                    {
                        source.CopyTo(output);
                    }
                }
            }
            if (plainZip is not null) File.Delete(plainZip);
            AtomicFile.CreatePrivateDirectory(Path.Combine(target, "uploads"));

            // The key in the backup must be the server the manifest says it is; then open it once to check the database.
            using var world = World.OpenOrCreate(target);
            var key = Ed25519.ToB64u(world.ServerPublicKey);
            if (key != manifest.ServerKey) throw new InvalidDataException("The backup is damaged (its key doesn't match).");
            var (messages, _, _) = world.Store.Counts();
            Features.SecurityLog.Record(world.Store, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), "backup.restored",
                details: new { backupMadeAt = manifest.CreatedAt, uploads });
            return new RestoreResult(world.Settings.Name, key, uploads, messages, target);
        }
        catch
        {
            if (plainZip is not null) TryDelete(plainZip);
            if (createdTarget) TryDeleteDirectory(target);
            else foreach (var entry in Directory.EnumerateFileSystemEntries(target)) TryDeleteAny(entry);
            throw;
        }
    }

    /// <summary>A new file readable only by its owner (0600) on Linux and macOS.</summary>
    public static FileStream PrivateCreate(string path)
    {
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        return new FileStream(path, options);
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private static void TryDeleteDirectory(string path)
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(path, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private static void TryDeleteAny(string path)
    {
        if (Directory.Exists(path)) TryDeleteDirectory(path);
        else TryDelete(path);
    }
}

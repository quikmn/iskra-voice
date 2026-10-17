using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>An activity's manifest.json, checked.</summary>
public sealed record ActivityManifest(string Name, string Description, string? Icon, int MinPlayers, int MaxPlayers, string Version);

/// <summary>A bundle that was refused. <see cref="Hostile"/>: it tried something no honest zip does (the security log hears).</summary>
public sealed class BundleException(string key, string message, object? args = null, bool hostile = false, string? reason = null) : Exception(message)
{
    public string Key { get; } = key;
    public object? Args { get; } = args;
    public bool Hostile { get; } = hostile;
    public string Reason { get; } = reason ?? key;

    public RequestException ToRequest() => RequestException.BadRequest(Message, Key, Args);
}

/// <summary>
/// Reads an activity bundle (a zip) and checks every part of it: the zip's size and file count, every path (no way out
/// of the bundle, nothing hidden, no two files differing only in case), every type (a fixed list, by extension), the
/// unpacked sizes (counted while reading, never taken from the zip's headers), UTF-8 for text, and the manifest.
/// </summary>
public static partial class ActivityBundle
{
    public const long MaxZipBytes = 5 * 1024 * 1024;
    public const int MaxFiles = 200;
    public const long MaxUnpackedBytes = 10 * 1024 * 1024;
    public const long MaxFileBytes = 5 * 1024 * 1024;
    public const int MaxManifestBytes = 16 * 1024;
    public const int MaxPathLength = 200;
    public const int MaxDepth = 8;
    public const int MaxNameLength = 40;
    public const int MaxDescriptionLength = 200;
    public const int MaxVersionLength = 20;
    public const int MaxPlayers = 25;
    /// <summary>Entries a zip may list at all, junk included (checked before reading any).</summary>
    private const int MaxEntries = 1000;

    /// <summary>Allowed files by extension, and the type they're served with.</summary>
    public static readonly IReadOnlyDictionary<string, string> Types = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["html"] = "text/html; charset=utf-8", ["htm"] = "text/html; charset=utf-8",
        ["js"] = "text/javascript; charset=utf-8", ["mjs"] = "text/javascript; charset=utf-8",
        ["css"] = "text/css; charset=utf-8", ["json"] = "application/json; charset=utf-8", ["txt"] = "text/plain; charset=utf-8",
        ["svg"] = "image/svg+xml", ["png"] = "image/png", ["jpg"] = "image/jpeg", ["jpeg"] = "image/jpeg", ["gif"] = "image/gif",
        ["webp"] = "image/webp", ["ico"] = "image/x-icon", ["avif"] = "image/avif",
        ["woff"] = "font/woff", ["woff2"] = "font/woff2", ["ttf"] = "font/ttf", ["otf"] = "font/otf",
        ["mp3"] = "audio/mpeg", ["ogg"] = "audio/ogg", ["oga"] = "audio/ogg", ["wav"] = "audio/wav", ["m4a"] = "audio/mp4", ["opus"] = "audio/ogg",
    };

    private static readonly HashSet<string> TextTypes = ["html", "htm", "js", "mjs", "css", "json", "svg", "txt"];
    private static readonly HashSet<string> IconTypes = ["png", "jpg", "jpeg", "webp", "gif", "svg"];

    [GeneratedRegex("^[A-Za-z0-9_.-]{1,64}$")]
    private static partial Regex PartPattern();

    public static string? Extension(string path)
    {
        var name = path[(path.LastIndexOf('/') + 1)..];
        var dot = name.LastIndexOf('.');
        return dot <= 0 ? null : name[(dot + 1)..].ToLowerInvariant();
    }

    public static string? TypeOf(string path) => Extension(path) is { } ext && Types.TryGetValue(ext, out var type) ? type : null;

    /// <summary>A path inside a bundle as stored and served: parts of [A-Za-z0-9_.-], none starting with a dot, not too deep or long.</summary>
    public static bool ValidPath(string path)
    {
        if (path.Length == 0 || path.Length > MaxPathLength) return false;
        var parts = path.Split('/');
        return parts.Length <= MaxDepth && parts.All(p => PartPattern().IsMatch(p) && p[0] != '.');
    }

    private static string Short(string path) => path.Length <= 100 ? path : path[..100];

    private static BundleException TooBig() =>
        new("act_zip", $"Activities must be a zip of up to {MaxZipBytes / 1024 / 1024} MB, with up to {MaxFiles} files and {MaxUnpackedBytes / 1024 / 1024} MB unpacked.",
            new { maxMb = MaxZipBytes / 1024 / 1024, maxFiles = MaxFiles });

    private static bool Junk(string path) =>
        path.StartsWith("__MACOSX/", StringComparison.Ordinal) || path.EndsWith("/.DS_Store", StringComparison.Ordinal) || path == ".DS_Store"
        || path.EndsWith("/Thumbs.db", StringComparison.Ordinal) || path == "Thumbs.db";

    /// <summary>Reads and checks a bundle. Throws <see cref="BundleException"/> for anything wrong with it.</summary>
    public static (ActivityManifest Manifest, List<ActivityFile> Files) Read(Stream zip)
    {
        if (zip.CanSeek && zip.Length > MaxZipBytes) throw TooBig();
        ZipArchive archive;
        try
        {
            archive = new ZipArchive(zip, ZipArchiveMode.Read, leaveOpen: true);
        }
        catch (Exception e) when (e is InvalidDataException or ArgumentException or IOException)
        {
            throw new BundleException("act_zip", "That isn't a zip file.", new { maxMb = MaxZipBytes / 1024 / 1024, maxFiles = MaxFiles });
        }
        using (archive)
        {
            if (archive.Entries.Count > MaxEntries) throw TooBig();
            var files = new List<ActivityFile>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long total = 0;
            foreach (var entry in archive.Entries)
            {
                var name = entry.FullName;
                if (name.Contains('\\') || name.StartsWith('/') || name.Contains(':') || name.Split('/').Any(p => p is ".." or "."))
                    throw new BundleException("act_path", $"The bundle has a path that isn't allowed: {Short(name)}", new { path = Short(name) }, hostile: true, reason: "path");
                if (name.EndsWith('/')) continue; // a folder
                if (Junk(name)) continue;
                if (!ValidPath(name))
                    throw new BundleException("act_path", $"The bundle has a path that isn't allowed: {Short(name)}", new { path = Short(name) });
                if (TypeOf(name) is null)
                    throw new BundleException("act_type", $"This kind of file can't be in an activity: {Short(name)}", new { path = Short(name) });
                if (!seen.Add(name))
                    throw new BundleException("act_path", $"The bundle has two files named {Short(name)}.", new { path = Short(name) }, hostile: true, reason: "duplicate");
                if (files.Count >= MaxFiles) throw TooBig();

                var data = ReadCapped(entry, Math.Min(MaxFileBytes, MaxUnpackedBytes - total));
                total += data.Length;
                files.Add(new ActivityFile(name, TypeOf(name)!, data));
            }

            files = WithoutTopFolder(files);
            foreach (var file in files.Where(f => TextTypes.Contains(Extension(f.Path)!)))
                if (!IsUtf8(file.Data))
                    throw new BundleException("act_utf8", $"Text files must be UTF-8: {Short(file.Path)}", new { path = Short(file.Path) });
            if (files.All(f => f.Path != "index.html")) throw new BundleException("act_index", "The bundle needs an index.html at the top.");
            var manifestFile = files.FirstOrDefault(f => f.Path == "manifest.json")
                ?? throw new BundleException("act_manifest", "The bundle needs a manifest.json at the top.");
            var manifest = Manifest(manifestFile.Data, files);
            return (manifest, files);
        }
    }

    /// <summary>Unpacks one entry, counting what actually comes out (a zip's own sizes can lie).</summary>
    private static byte[] ReadCapped(ZipArchiveEntry entry, long max)
    {
        try
        {
            using var input = entry.Open();
            using var output = new MemoryStream();
            var buffer = new byte[81920];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (output.Length + read > max)
                    throw new BundleException("act_zip", TooBig().Message, TooBig().Args, hostile: entry.Length <= max, reason: "size");
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }
        catch (InvalidDataException)
        {
            throw new BundleException("act_zip", "That zip file is damaged.", new { maxMb = MaxZipBytes / 1024 / 1024, maxFiles = MaxFiles });
        }
    }

    /// <summary>A zip of a folder has everything in that folder: then the folder is the bundle.</summary>
    private static List<ActivityFile> WithoutTopFolder(List<ActivityFile> files)
    {
        if (files.Count == 0 || files.Any(f => !f.Path.Contains('/'))) return files;
        var top = files[0].Path[..(files[0].Path.IndexOf('/') + 1)];
        if (files.Any(f => !f.Path.StartsWith(top, StringComparison.Ordinal))) return files;
        return files.Select(f => f with { Path = f.Path[top.Length..] }).ToList();
    }

    private static bool IsUtf8(byte[] data)
    {
        try
        {
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true).GetString(data);
            return !data.Contains((byte)0);
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }

    private static BundleException BadManifest(string why) => new("act_manifest", $"manifest.json: {why}");

    private static ActivityManifest Manifest(byte[] data, List<ActivityFile> files)
    {
        if (data.Length > MaxManifestBytes) throw BadManifest($"it can be up to {MaxManifestBytes / 1024} KB.");
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(data, new JsonDocumentOptions { MaxDepth = 16 });
            root = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw BadManifest("it isn't valid JSON.");
        }
        if (root.ValueKind != JsonValueKind.Object) throw BadManifest("it must be a JSON object.");

        string? Str(string field, int max)
        {
            if (!root.TryGetProperty(field, out var v) || v.ValueKind == JsonValueKind.Null) return null;
            if (v.ValueKind != JsonValueKind.String) throw BadManifest($"'{field}' must be text.");
            var raw = v.GetString()!;
            if (raw.Trim().Length == 0) return null;
            return Text.Normalize(raw, max, allowNewlines: false) ?? throw BadManifest($"'{field}' must be one line of up to {max} characters.");
        }
        int Int(string field, int fallback, int min, int max)
        {
            if (!root.TryGetProperty(field, out var v) || v.ValueKind == JsonValueKind.Null) return fallback;
            if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var n) || n < min || n > max)
                throw BadManifest($"'{field}' must be a whole number from {min} to {max}.");
            return n;
        }

        var name = Str("name", MaxNameLength) ?? throw BadManifest("'name' is required.");
        var description = Str("description", MaxDescriptionLength) ?? "";
        var version = Str("version", MaxVersionLength) ?? "";
        var min = Int("minPlayers", 1, 1, MaxPlayers);
        var max = Int("maxPlayers", MaxPlayers, min, MaxPlayers);
        if (root.TryGetProperty("sdk", out var sdk) && sdk.ValueKind != JsonValueKind.Null && !(sdk.ValueKind == JsonValueKind.Number && sdk.TryGetInt32(out var v1) && v1 == 1))
            throw BadManifest("'sdk' must be 1.");
        string? icon = null;
        if (Str("icon", MaxPathLength) is { } path)
        {
            if (!ValidPath(path) || !IconTypes.Contains(Extension(path) ?? "") || files.All(f => f.Path != path))
                throw BadManifest("'icon' must name a picture in the bundle (png, jpg, webp, gif or svg).");
            icon = path;
        }
        return new ActivityManifest(name, description, icon, min, max, version);
    }
}

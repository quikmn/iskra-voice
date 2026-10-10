using System.IO.Compression;

namespace Iskra.Server.Import;

/// <summary>One JSON export inside an upload (a channel, or one part of a partitioned channel).</summary>
public sealed record ExportDocument(string Name, string Directory, long Length);

/// <summary>
/// An uploaded export: a single JSON file, or a zip of exports with their downloaded media (the *_Files folders).
/// Nothing is ever extracted by its name: media is looked up in an index of entries and streamed straight into
/// uploads, so paths in the zip or the JSON can't point anywhere on disk.
/// </summary>
public abstract class ExportSource : IDisposable
{
    public const int MaxDocuments = 2000;
    public const int MaxEntries = 200_000;

    public abstract IReadOnlyList<ExportDocument> Documents { get; }

    /// <summary>Entries skipped because their names weren't safe (absolute, "..", drive letters).</summary>
    public int UnsafeEntries { get; protected set; }

    public abstract Stream OpenDocument(ExportDocument document);

    /// <summary>The media file a JSON reference (relative to the document, as the exporter writes it) points at, or null.</summary>
    public abstract (Stream Stream, long Length)? OpenMedia(ExportDocument document, string reference);

    public abstract void Dispose();

    /// <summary>Opens an upload by its content: a zip, or JSON (an object, after an optional BOM and whitespace).</summary>
    public static ExportSource Open(string path)
    {
        Span<byte> head = stackalloc byte[64];
        int got;
        using (var probe = File.OpenRead(path)) got = probe.ReadAtLeast(head, head.Length, throwOnEndOfStream: false);
        var kind = Sniff(head[..got]);
        return kind switch
        {
            "zip" => new ZipSource(path),
            "json" => new JsonFileSource(path),
            _ => throw new InvalidDataException("Upload a DiscordChatExporter JSON export, or a zip of them."),
        };
    }

    /// <summary>"zip", "json" or null, from the first bytes.</summary>
    public static string? Sniff(ReadOnlySpan<byte> head)
    {
        if (head.Length >= 4 && head[0] == 'P' && head[1] == 'K' && head[2] == 3 && head[3] == 4) return "zip";
        var i = head.StartsWith((ReadOnlySpan<byte>)[0xEF, 0xBB, 0xBF]) ? 3 : 0;
        while (i < head.Length && head[i] is (byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n') i++;
        return i < head.Length && head[i] == '{' ? "json" : null;
    }

    /// <summary>
    /// A zip entry name as a clean relative path ("a/b.json"), or null if it isn't safe: absolute, a drive letter,
    /// "..", control characters.
    /// </summary>
    public static string? SafeEntryName(string raw)
    {
        var name = raw.Replace('\\', '/');
        if (name.Length == 0 || name.Length > 1024 || name.StartsWith('/') || name.Contains(':') || name.Any(char.IsControl)) return null;
        var parts = new List<string>();
        foreach (var part in name.Split('/'))
        {
            if (part is "" or ".") continue;
            if (part == "..") return null;
            parts.Add(part);
        }
        return parts.Count == 0 ? null : string.Join('/', parts);
    }

    /// <summary>Resolves a relative reference against a directory, purely as text; null if it climbs out of the zip.</summary>
    public static string? Resolve(string directory, string reference)
    {
        var parts = directory.Length == 0 ? new List<string>() : [.. directory.Split('/')];
        foreach (var part in reference.Replace('\\', '/').Split('/'))
        {
            if (part is "" or ".") continue;
            if (part == "..")
            {
                if (parts.Count == 0) return null;
                parts.RemoveAt(parts.Count - 1);
                continue;
            }
            parts.Add(part);
        }
        return parts.Count == 0 ? null : string.Join('/', parts);
    }

    public static bool IsRemote(string reference) =>
        reference.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || reference.StartsWith("https://", StringComparison.OrdinalIgnoreCase);

    private sealed class JsonFileSource(string path) : ExportSource
    {
        public override IReadOnlyList<ExportDocument> Documents { get; } = [new ExportDocument(Path.GetFileName(path), "", new FileInfo(path).Length)];
        public override Stream OpenDocument(ExportDocument document) => File.OpenRead(path);
        // A lone JSON file has no media with it; files show as "not included".
        public override (Stream, long)? OpenMedia(ExportDocument document, string reference) => null;
        public override void Dispose() { }
    }

    private sealed class ZipSource : ExportSource
    {
        // Two archives over two handles: one streams the JSON while the other reads media from the same file.
        private readonly ZipArchive _documents;
        private readonly ZipArchive _media;
        private readonly Dictionary<string, string> _docEntries = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> _byPath = new(StringComparer.Ordinal);
        /// <summary>File name → entry, for references the exporter wrote as absolute paths (media folder elsewhere). Null if ambiguous.</summary>
        private readonly Dictionary<string, string?> _byName = new(StringComparer.Ordinal);
        private readonly List<ExportDocument> _list = [];

        public ZipSource(string path)
        {
            try
            {
                _documents = ZipFile.OpenRead(path);
                _media = ZipFile.OpenRead(path);
            }
            catch (InvalidDataException)
            {
                _documents?.Dispose();
                throw new InvalidDataException("That zip file is damaged.");
            }
            if (_documents.Entries.Count > MaxEntries) throw new InvalidDataException($"The zip has more than {MaxEntries:N0} files.");
            foreach (var entry in _documents.Entries)
            {
                if (entry.FullName.EndsWith('/') || entry.FullName.EndsWith('\\')) continue;
                var name = SafeEntryName(entry.FullName);
                if (name is null)
                {
                    UnsafeEntries++;
                    continue;
                }
                if (_byPath.ContainsKey(name)) continue;
                _byPath[name] = entry.FullName;
                var file = name[(name.LastIndexOf('/') + 1)..];
                _byName[file] = _byName.ContainsKey(file) ? null : entry.FullName;
                var inMediaFolder = name.Split('/').SkipLast(1).Any(p => p.EndsWith("_Files", StringComparison.Ordinal));
                if (name.EndsWith(".json", StringComparison.OrdinalIgnoreCase) && !inMediaFolder)
                {
                    if (_list.Count >= MaxDocuments) throw new InvalidDataException($"The zip has more than {MaxDocuments} exports.");
                    var slash = name.LastIndexOf('/');
                    _list.Add(new ExportDocument(name, slash < 0 ? "" : name[..slash], entry.Length));
                    _docEntries[name] = entry.FullName;
                }
            }
        }

        public override IReadOnlyList<ExportDocument> Documents => _list;

        public override Stream OpenDocument(ExportDocument document) => _documents.GetEntry(_docEntries[document.Name])!.Open();

        public override (Stream, long)? OpenMedia(ExportDocument document, string reference)
        {
            if (IsRemote(reference) || reference.Length > 2048) return null;
            var normalized = reference.Replace('\\', '/');
            string? entryName = null;
            var absolute = normalized.StartsWith('/') || (normalized.Length > 2 && normalized[1] == ':');
            if (!absolute && Resolve(document.Directory, normalized) is { } relative) _byPath.TryGetValue(relative, out entryName);
            if (entryName is null && !absolute && SafeEntryName(normalized) is { } fromRoot) _byPath.TryGetValue(fromRoot, out entryName);
            if (entryName is null)
            {
                var file = normalized[(normalized.LastIndexOf('/') + 1)..];
                if (_byName.TryGetValue(file, out var unique)) entryName = unique;
            }
            if (entryName is null || _media.GetEntry(entryName) is not { } entry) return null;
            return (entry.Open(), entry.Length);
        }

        public override void Dispose()
        {
            _documents.Dispose();
            _media.Dispose();
        }
    }
}

/// <summary>Counts what's read and refuses to go past a limit (zip bombs: the declared size can lie).</summary>
public sealed class LimitedStream(Stream inner, Func<long, bool> take) : Stream
{
    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> buffer)
    {
        var read = inner.Read(buffer);
        if (read > 0 && !take(read)) throw new InvalidDataException("The export unpacks to more than this server allows.");
        return read;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) inner.Dispose();
        base.Dispose(disposing);
    }

    public override void Flush() { }
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

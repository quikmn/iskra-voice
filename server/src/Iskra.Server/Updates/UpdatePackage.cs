using System.Formats.Tar;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Iskra.Server.Updates;

/// <summary>A release's server package for this machine, and the checksum list next to it.</summary>
public sealed record UpdateCandidate(Release Release, ReleaseAsset Package, ReleaseAsset Sums);

/// <summary>A check failed. <see cref="Code"/> tells apps which (they show it in the owner's language).</summary>
public sealed class UpdateVerificationException(string message, string code = "package") : Exception(message)
{
    /// <summary>"sums", "size", "checksum", "github_checksum", "package", "wont_run", "attestation_missing", "attestation_unknown".</summary>
    public string Code { get; } = code;
}

/// <summary>Which package fits which machine, and which release to take.</summary>
public static class UpdatePicker
{
    public const string SumsFile = "SHA256SUMS.txt";

    /// <summary>The runtime id our release packages use, or null when there's no package for this machine.</summary>
    public static string? Rid(OSPlatform os, Architecture arch) => (os, arch) switch
    {
        _ when os == OSPlatform.Linux && arch == Architecture.X64 => "linux-x64",
        _ when os == OSPlatform.OSX && arch == Architecture.Arm64 => "osx-arm64",
        _ when os == OSPlatform.OSX && arch == Architecture.X64 => "osx-x64",
        _ when os == OSPlatform.Windows && arch == Architecture.X64 => "win-x64",
        _ => null,
    };

    public static string? CurrentRid =>
        Rid(OperatingSystem.IsLinux() ? OSPlatform.Linux : OperatingSystem.IsMacOS() ? OSPlatform.OSX : OperatingSystem.IsWindows() ? OSPlatform.Windows : OSPlatform.FreeBSD,
            RuntimeInformation.OSArchitecture);

    public static string PackageName(string version, string rid) =>
        rid.StartsWith("win-", StringComparison.Ordinal) ? $"iskra-server-{version}-{rid}.zip" : $"iskra-server-{version}-{rid}.tar.gz";

    /// <summary>
    /// The newest release newer than <paramref name="current"/> on the channel ("stable": not marked prerelease on GitHub;
    /// "prerelease": everything). Null when there's none.
    /// </summary>
    public static Release? Newest(IEnumerable<Release> releases, string current, string channel) =>
        releases
            .Where(r => (channel == "prerelease" || !r.Prerelease) && Versions.Compare(r.Version, current) > 0)
            .OrderByDescending(r => r.Version, Comparer<string>.Create(Versions.Compare))
            .FirstOrDefault();

    /// <summary>This release's package for <paramref name="rid"/> plus its checksum list, or null if either is missing.</summary>
    public static UpdateCandidate? Candidate(Release release, string? rid) =>
        rid is not null && release.Asset(PackageName(release.Version, rid)) is { } package && release.Asset(SumsFile) is { } sums
            ? new UpdateCandidate(release, package, sums)
            : null;
}

/// <summary>Checks a downloaded package against the release's SHA256SUMS.txt and GitHub's own digest of the file.</summary>
public static partial class UpdateVerifier
{
    [GeneratedRegex(@"^([0-9a-fA-F]{64}) [ *]?(\S.*)$")]
    private static partial Regex SumLine();

    /// <summary>"&lt;sha256&gt;  &lt;name&gt;" lines (sha256sum's format) → name → lowercase hex.</summary>
    public static Dictionary<string, string> ParseSums(string text)
    {
        var sums = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in text.Split('\n'))
        {
            var match = SumLine().Match(raw.TrimEnd('\r'));
            if (!match.Success) continue;
            var name = match.Groups[2].Value.Trim();
            if (sums.ContainsKey(name)) throw new UpdateVerificationException($"{UpdatePicker.SumsFile} lists {name} twice.", "sums");
            sums[name] = match.Groups[1].Value.ToLowerInvariant();
        }
        return sums;
    }

    public static string Sha256File(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }

    /// <summary>Throws <see cref="UpdateVerificationException"/> unless the file matches every checksum we have for it. Returns its SHA-256.</summary>
    public static string Verify(string path, ReleaseAsset asset, string sumsText)
    {
        var sums = ParseSums(sumsText);
        if (!sums.TryGetValue(asset.Name, out var expected))
            throw new UpdateVerificationException($"{UpdatePicker.SumsFile} doesn't list {asset.Name}.", "sums");
        if (asset.Size > 0 && new FileInfo(path).Length != asset.Size)
            throw new UpdateVerificationException($"{asset.Name} has the wrong size.", "size");
        var actual = Sha256File(path);
        if (actual != expected) throw new UpdateVerificationException($"{asset.Name} doesn't match its checksum in {UpdatePicker.SumsFile}.", "checksum");
        if (asset.Sha256 is { } digest && digest != actual) throw new UpdateVerificationException($"{asset.Name} doesn't match GitHub's checksum for it.", "github_checksum");
        return actual;
    }
}

/// <summary>
/// Unpacks a server package (iskra-server-&lt;v&gt;-&lt;rid&gt;.tar.gz or .zip): only plain files at the top level, with
/// plain names, so nothing can land outside the folder it's unpacked into.
/// </summary>
public static partial class UpdateArchive
{
    public const long MaxTotalBytes = 1024L * 1024 * 1024;

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")]
    private static partial Regex SafeName();

    /// <summary>Unpacks into <paramref name="dest"/> (created empty) and returns the file names. <paramref name="exeName"/> must be among them.</summary>
    public static List<string> Extract(string package, string dest, string exeName)
    {
        if (Directory.Exists(dest)) Directory.Delete(dest, recursive: true);
        Directory.CreateDirectory(dest);
        var names = new List<string>();
        long total = 0;
        void Add(string entryName, long length, Action<string> write, UnixFileMode? mode)
        {
            var name = entryName.StartsWith("./", StringComparison.Ordinal) ? entryName[2..] : entryName;
            if (name is "" or "." or "./") return; // the archive's own root
            if (!SafeName().IsMatch(name)) throw new UpdateVerificationException($"The package contains an unexpected entry: {entryName}");
            if (names.Contains(name)) throw new UpdateVerificationException($"The package contains {name} twice.");
            total += length;
            if (total > MaxTotalBytes) throw new UpdateVerificationException("The package is too large.");
            var target = Path.Combine(dest, name);
            write(target);
            if (mode is { } m && !OperatingSystem.IsWindows()) File.SetUnixFileMode(target, m & (UnixFileMode)0b111_101_101); // no group/other write
            names.Add(name);
        }

        if (package.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            using var zip = ZipFile.OpenRead(package);
            foreach (var entry in zip.Entries)
            {
                if (entry.FullName.EndsWith('/')) throw new UpdateVerificationException($"The package contains a folder: {entry.FullName}");
                Add(entry.FullName, entry.Length, target => entry.ExtractToFile(target), null);
            }
        }
        else
        {
            using var file = File.OpenRead(package);
            using var gzip = new GZipStream(file, CompressionMode.Decompress);
            using var tar = new TarReader(gzip);
            while (tar.GetNextEntry() is { } entry)
            {
                if (entry.EntryType == TarEntryType.Directory && entry.Name.TrimEnd('/') is "." or "") continue;
                if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile))
                    throw new UpdateVerificationException($"The package contains something that isn't a plain file: {entry.Name}");
                Add(entry.Name, entry.Length, target =>
                {
                    using var output = File.Create(target);
                    entry.DataStream?.CopyTo(output);
                }, entry.Mode);
            }
        }
        if (!names.Contains(exeName)) throw new UpdateVerificationException($"The package has no {exeName}.");
        return names;
    }
}

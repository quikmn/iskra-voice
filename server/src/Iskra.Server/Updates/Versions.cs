using System.Reflection;
using System.Text.RegularExpressions;

namespace Iskra.Server.Updates;

/// <summary>Release versions: x.y.z with an optional prerelease (2.0.0-alpha.10), ordered as semver orders them.</summary>
public static partial class Versions
{
    /// <summary>What development builds call themselves. They never update.</summary>
    public const string Development = "0.0.0-dev";

    [GeneratedRegex(@"^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$")]
    private static partial Regex Pattern();

    public static bool IsValid(string? version) => version is { Length: <= 64 } && Pattern().IsMatch(version);

    /// <summary>A real release (not a development build).</summary>
    public static bool IsRelease(string? version) => IsValid(version) && version != Development;

    /// <summary>This build's version (set by the release build with -p:Version=...), without the "+commit" suffix.</summary>
    public static string Current { get; } = ReadCurrent();

    private static string ReadCurrent()
    {
        var info = typeof(Versions).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        var version = info?.Split('+')[0];
        return IsValid(version) ? version! : Development;
    }

    /// <summary>Negative if <paramref name="a"/> is older than <paramref name="b"/>, 0 if equal, positive if newer. Both must be valid.</summary>
    public static int Compare(string a, string b)
    {
        var x = Pattern().Match(a);
        var y = Pattern().Match(b);
        if (!x.Success || !y.Success) throw new ArgumentException($"Not a version: '{(x.Success ? b : a)}'.");
        for (var i = 1; i <= 3; i++)
        {
            var c = long.Parse(x.Groups[i].Value).CompareTo(long.Parse(y.Groups[i].Value));
            if (c != 0) return c;
        }
        var pa = x.Groups[4].Success ? x.Groups[4].Value : null;
        var pb = y.Groups[4].Success ? y.Groups[4].Value : null;
        if (pa is null || pb is null) return pa is null ? (pb is null ? 0 : 1) : -1; // a release beats its prereleases
        var ia = pa.Split('.');
        var ib = pb.Split('.');
        for (var i = 0; i < Math.Min(ia.Length, ib.Length); i++)
        {
            var na = long.TryParse(ia[i], out var va) && ia[i].All(char.IsAsciiDigit);
            var nb = long.TryParse(ib[i], out var vb) && ib[i].All(char.IsAsciiDigit);
            var c = na && nb ? va.CompareTo(vb) : na ? -1 : nb ? 1 : string.CompareOrdinal(ia[i], ib[i]);
            if (c != 0) return Math.Sign(c);
        }
        return ia.Length.CompareTo(ib.Length);
    }

    /// <summary>"v2.0.0-alpha.10" → "2.0.0-alpha.10"; null if the tag isn't a version.</summary>
    public static string? FromTag(string? tag) =>
        tag is { Length: > 1 } && tag[0] == 'v' && IsValid(tag[1..]) ? tag[1..] : null;
}

using System.Globalization;
using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Media channels (kind "media"): a forum where every post is pictures or videos, with an optional title and a caption.
/// The forum requests do the work (ForumFeature); this holds the rules that differ. No requests of its own.
/// </summary>
public static partial class MediaFeature
{
    /// <summary>A picture or a video (by the type found in the file's first bytes, never its name).</summary>
    public static bool IsMedia(StoredFile f) =>
        f.Type.StartsWith("image/", StringComparison.Ordinal) || f.Type.StartsWith("video/", StringComparison.Ordinal);

    /// <summary>A media post has 1–10 files, all pictures or videos.</summary>
    public static void CheckFiles(List<StoredFile> files)
    {
        if (files.Count == 0)
            throw RequestException.BadRequest("Add at least one picture or video.", "media_post_needs_media");
        if (!files.All(IsMedia))
            throw RequestException.BadRequest("Only pictures and videos can be posted here.", "media_post_only_media");
    }

    /// <summary>
    /// The name an untitled post's thread goes by (lists of threads, notifications): the caption's first line, else the first
    /// file's name. Apps show the caption instead when the post is <c>untitled</c>.
    /// </summary>
    public static string StandInTitle(string caption, List<StoredFile> files)
    {
        var line = caption.Split('\n').Select(l => Tokens().Replace(l, " ").Replace('\t', ' ').Trim()).FirstOrDefault(l => l.Length > 0);
        if (line is null && files.Count > 0)
        {
            var name = files[0].Name.StartsWith("SPOILER_", StringComparison.Ordinal) ? files[0].Name["SPOILER_".Length..] : files[0].Name;
            line = Path.GetFileNameWithoutExtension(name).Trim();
        }
        line = Spaces().Replace(line ?? "", " ");
        if (line.Length == 0) return "Media";
        if (line.Length <= ThreadFeature.MaxNameLength) return line;
        var cut = ThreadFeature.MaxNameLength - 1;
        if (char.IsHighSurrogate(line[cut - 1])) cut--;
        return line[..cut] + "…";
    }

    /// <summary>Posts where every word is in the title or one of the post's tag names (ignoring case and accents).</summary>
    public static IEnumerable<long> TagMatches(Store store, Channel forum, List<ForumPost> posts, List<string> terms)
    {
        var tags = store.ForumTags(forum.Id).ToDictionary(t => t.Id, t => t.Name);
        if (tags.Count == 0) return [];
        var compare = CultureInfo.InvariantCulture.CompareInfo;
        const CompareOptions loose = CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace;
        return posts
            .Where(p => p.Tags.Length > 0 && terms.All(term =>
                compare.IndexOf(p.Thread.Name, term, loose) >= 0
                || p.Tags.Any(id => tags.TryGetValue(id, out var name) && compare.IndexOf(name, term, loose) >= 0)))
            .Select(p => p.Id);
    }

    /// <summary>Mentions and custom emoji (&lt;@key&gt;, &lt;:name:id&gt;) don't read well as a title.</summary>
    [GeneratedRegex(@"<(?:[@#:]|a:)[^<>\s]{0,200}>")]
    private static partial Regex Tokens();

    [GeneratedRegex(@" {2,}")]
    private static partial Regex Spaces();
}

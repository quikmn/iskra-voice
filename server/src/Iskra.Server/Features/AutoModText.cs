using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Iskra.Server.Features;

/// <summary>
/// Text as AutoMod sees it: compatibility-decomposed (fullwidth and styled letters become plain ones), without accents,
/// other combining marks or invisible format characters, in lower case, and split into words (runs of letters and digits).
/// <see cref="Map"/> points every folded character back at the original, so matches can be masked in alerts.
/// </summary>
public sealed class FoldedText
{
    public required string Original { get; init; }
    public required string Text { get; init; }
    public required int[] Map { get; init; }
    /// <summary>Words as [start, end) in <see cref="Text"/>.</summary>
    public required List<(int Start, int End)> Words { get; init; }

    public string Word(int i) => Text[Words[i].Start..Words[i].End];

    public static FoldedText Of(string original, bool wildcards = false)
    {
        var text = new StringBuilder(original.Length);
        var map = new List<int>(original.Length);
        for (var i = 0; i < original.Length;)
        {
            var c = original[i];
            if (c < 0x80)
            {
                text.Append(char.ToLowerInvariant(c));
                map.Add(i++);
                continue;
            }
            var length = char.IsSurrogatePair(original, i) ? 2 : 1;
            var unit = original.Substring(i, length);
            string decomposed;
            try { decomposed = unit.Normalize(NormalizationForm.FormKD); }
            catch (ArgumentException) { decomposed = unit; } // a lone surrogate
            foreach (var rune in decomposed.EnumerateRunes())
            {
                if (Rune.GetUnicodeCategory(rune) is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark
                    or UnicodeCategory.EnclosingMark or UnicodeCategory.Format) continue;
                var lower = Rune.ToLowerInvariant(rune).ToString();
                text.Append(lower);
                for (var k = 0; k < lower.Length; k++) map.Add(i);
            }
            i += length;
        }

        var folded = text.ToString();
        var words = new List<(int, int)>();
        var start = -1;
        for (var i = 0; i < folded.Length;)
        {
            Rune.DecodeFromUtf16(folded.AsSpan(i), out var rune, out var used);
            var inWord = Rune.IsLetterOrDigit(rune) || (wildcards && rune.Value == '*');
            if (inWord && start < 0) start = i;
            else if (!inWord && start >= 0)
            {
                words.Add((start, i));
                start = -1;
            }
            i += used;
        }
        if (start >= 0) words.Add((start, folded.Length));
        return new FoldedText { Original = original, Text = folded, Map = [.. map], Words = words };
    }

    /// <summary>The original text from a folded start to a folded end, widened to whole characters (with their accents).</summary>
    public (int Start, int End) OriginalSpan(int start, int end)
    {
        var from = Map[start];
        var to = Map[end - 1] + (char.IsHighSurrogate(Original[Map[end - 1]]) ? 2 : 1);
        while (to < Original.Length && CharUnicodeInfo.GetUnicodeCategory(Original, to) is UnicodeCategory.NonSpacingMark
                   or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark or UnicodeCategory.Format)
            to++;
        return (from, to);
    }
}

/// <summary>
/// Blocked words and phrases, compiled once when the settings change. Entries match whole words, ignoring case, accents,
/// fullwidth or styled letters and invisible characters; <c>*</c> stands for any letters within a word (<c>bad*</c>).
/// Spelled-out words (<c>b a d</c>, <c>b.a.d</c>) are caught too. Allowed words are exceptions to wildcard matches.
/// </summary>
public sealed class WordMatcher
{
    private const int MaxHits = 50;

    private readonly HashSet<string> _single = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<string[]>> _byFirst = new(StringComparer.Ordinal);
    /// <summary>Entries whose first word has a wildcard, by that word's first character ('*' when it starts with one).</summary>
    private readonly Dictionary<char, List<string[]>> _wild = [];
    private readonly HashSet<string> _allowedSingle = new(StringComparer.Ordinal);
    private readonly List<string[]> _allowed = [];

    public bool IsEmpty => _single.Count == 0 && _byFirst.Count == 0 && _wild.Count == 0;

    public static string[] Pattern(string entry)
    {
        var folded = FoldedText.Of(entry, wildcards: true);
        var words = Enumerable.Range(0, folded.Words.Count).Select(folded.Word).ToArray();
        return words.Any(w => w.Any(ch => ch != '*')) ? words : []; // a lone * would match everything
    }

    public WordMatcher(IEnumerable<string> blocked, IEnumerable<string> allowed)
    {
        foreach (var words in blocked.Select(Pattern).Where(p => p.Length > 0))
        {
            if (words.Length == 1 && !words[0].Contains('*')) _single.Add(words[0]);
            else if (!words[0].Contains('*'))
            {
                if (!_byFirst.TryGetValue(words[0], out var list)) _byFirst[words[0]] = list = [];
                list.Add(words);
            }
            else
            {
                if (!_wild.TryGetValue(words[0][0], out var list)) _wild[words[0][0]] = list = [];
                list.Add(words);
            }
        }
        foreach (var words in allowed.Select(Pattern).Where(p => p.Length > 0))
        {
            if (words.Length == 1 && !words[0].Contains('*')) _allowedSingle.Add(words[0]);
            else _allowed.Add(words);
        }
    }

    /// <summary>Where blocked words occur, as [start, end) in the folded text (empty if nowhere).</summary>
    public List<(int Start, int End)> Find(FoldedText text) => Find(text, out _);

    /// <summary>
    /// <see cref="Find(FoldedText)"/>, also giving the work it took: characters compared against patterns. Tests check
    /// the matcher's speed with it, which (unlike a stopwatch) doesn't depend on the machine or how busy it is.
    /// </summary>
    internal List<(int Start, int End)> Find(FoldedText text, out long work)
    {
        work = 0;
        var hits = new List<(int, int)>();
        if (IsEmpty) return hits;
        var words = Enumerable.Range(0, text.Words.Count).Select(text.Word).ToList();
        Scan(words, text.Words, hits, ref work);
        // Spelled out: three or more single letters in a row are also read as one word.
        var squeezed = new List<string>();
        var spans = new List<(int, int)>();
        var changed = false;
        for (var i = 0; i < words.Count;)
        {
            var j = i;
            while (j < words.Count && IsOneLetter(words[j])) j++;
            if (j - i >= 3)
            {
                squeezed.Add(string.Concat(words.Skip(i).Take(j - i)));
                spans.Add((text.Words[i].Start, text.Words[j - 1].End));
                changed = true;
                i = j;
            }
            else
            {
                squeezed.Add(words[i]);
                spans.Add(text.Words[i]);
                i++;
            }
        }
        if (changed) Scan(squeezed, spans, hits, ref work);
        return hits;
    }

    private static bool IsOneLetter(string word) => word.Length == 1 || (word.Length == 2 && char.IsSurrogatePair(word, 0));

    private void Scan(List<string> words, List<(int Start, int End)> spans, List<(int, int)> hits, ref long work)
    {
        for (var i = 0; i < words.Count && hits.Count < MaxHits; i++)
        {
            var w = words[i];
            work += w.Length; // the hash lookups
            if (_single.Contains(w) && !Allowed(words, i, 1, ref work)) Hit(spans, i, 1, hits);
            if (_byFirst.TryGetValue(w, out var phrases))
                foreach (var p in phrases)
                    if (Matches(p, words, i, ref work) && !Allowed(words, i, p.Length, ref work)) Hit(spans, i, p.Length, hits);
            foreach (var key in (ReadOnlySpan<char>)[w[0], '*'])
                if (_wild.TryGetValue(key, out var wild))
                    foreach (var p in wild)
                        if (Matches(p, words, i, ref work) && !Allowed(words, i, p.Length, ref work)) Hit(spans, i, p.Length, hits);
        }
    }

    private static void Hit(List<(int Start, int End)> spans, int i, int count, List<(int, int)> hits)
    {
        var span = (spans[i].Start, spans[i + count - 1].End);
        if (!hits.Contains(span)) hits.Add(span);
    }

    private bool Allowed(List<string> words, int i, int count, ref long work)
    {
        if (count == 1 && _allowedSingle.Contains(words[i])) return true;
        foreach (var p in _allowed)
            if (p.Length == count && Matches(p, words, i, ref work)) return true;
        return false;
    }

    private static bool Matches(string[] pattern, List<string> words, int at, ref long work)
    {
        work++;
        if (at + pattern.Length > words.Count) return false;
        for (var k = 0; k < pattern.Length; k++)
            if (!Glob(pattern[k], words[at + k], ref work)) return false;
        return true;
    }

    /// <summary>Wildcard match where <c>*</c> is any run of characters (iterative, linear in practice).</summary>
    public static bool Glob(string pattern, string text)
    {
        long work = 0;
        return Glob(pattern, text, ref work);
    }

    private static bool Glob(string pattern, string text, ref long work)
    {
        if (!pattern.Contains('*'))
        {
            work += Math.Min(pattern.Length, text.Length) + 1;
            return pattern == text;
        }
        int p = 0, t = 0, star = -1, mark = 0;
        while (t < text.Length)
        {
            work++;
            if (p < pattern.Length && pattern[p] == text[t]) { p++; t++; }
            else if (p < pattern.Length && pattern[p] == '*') { star = p++; mark = t; }
            else if (star >= 0) { p = star + 1; t = ++mark; }
            else return false;
        }
        while (p < pattern.Length && pattern[p] == '*') p++;
        return p == pattern.Length;
    }

    /// <summary>The original text with every hit masked (first letter, then dots), cut to <paramref name="max"/> characters.</summary>
    public static string Masked(FoldedText text, List<(int Start, int End)> hits, int max)
    {
        var spans = hits.Select(h => text.OriginalSpan(h.Start, h.End)).OrderBy(s => s.Start).ToList();
        var output = new StringBuilder();
        var at = 0;
        foreach (var (start, end) in spans)
        {
            if (start < at) continue; // overlaps one already masked
            output.Append(text.Original, at, start - at);
            var first = char.IsHighSurrogate(text.Original[start]) && start + 1 < end ? 2 : 1;
            output.Append(text.Original, start, first).Append("•••");
            at = end;
        }
        output.Append(text.Original, at, text.Original.Length - at);
        return AutoModRules.Cut(output.ToString(), max);
    }
}

/// <summary>The link, mention and repeat checks, kept apart from the session so they can be tested on their own.</summary>
public static partial class AutoModRules
{
    [GeneratedRegex(@"(?:https?://|www\.)[^\s<>()\[\]]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex UrlPattern();

    [GeneratedRegex(@"(?:discord(?:app)?\.com/invite/|discord\.(?:gg|me|io)/|/#/join/|iskra://join/)\S", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex InvitePattern();

    [GeneratedRegex(@"<@([A-Za-z0-9_-]{43})>")]
    private static partial Regex UserMention();

    [GeneratedRegex(@"<@&([0-9]{1,12})>")]
    private static partial Regex RoleMention();

    [GeneratedRegex(@"(?<![\w@])@(everyone|here)\b")]
    private static partial Regex GroupMention();

    [GeneratedRegex(@"^(?=.{1,100}$)[a-z0-9-]+(\.[a-z0-9-]+)+$")]
    private static partial Regex DomainPattern();

    public static bool IsDomain(string domain) => DomainPattern().IsMatch(domain);

    public static string Cut(string text, int max) => text.Length <= max ? text : text[..max].TrimEnd() + "…";

    /// <summary>Distinct people and roles mentioned, with @everyone and @here counting once each.</summary>
    public static int Mentions(string text) =>
        UserMention().Matches(text).Select(m => m.Groups[1].Value).Distinct().Count()
        + RoleMention().Matches(text).Select(m => m.Groups[1].Value).Distinct().Count()
        + GroupMention().Matches(text).Select(m => m.Groups[1].Value).Distinct().Count();

    /// <summary>
    /// Does the (folded) text contain a link that isn't allowed? <paramref name="invitesOnly"/>: only invite links to other
    /// servers (Discord or Iskra). Otherwise any web link whose host isn't one of <paramref name="allowedDomains"/> (or under one).
    /// </summary>
    public static bool HasBlockedLink(string folded, bool invitesOnly, IReadOnlyCollection<string> allowedDomains)
    {
        if (invitesOnly) return InvitePattern().IsMatch(folded);
        foreach (Match m in UrlPattern().Matches(folded))
            if (!Allowed(Host(m.Value), allowedDomains)) return true;
        // Invites written without http:// or www.
        foreach (Match m in InvitePattern().Matches(folded))
        {
            var start = m.Index;
            while (start > 0 && !char.IsWhiteSpace(folded[start - 1])) start--;
            if (!Allowed(Host(folded[start..(m.Index + m.Length)]), allowedDomains)) return true;
        }
        return false;
    }

    private static string Host(string url)
    {
        var rest = url;
        var scheme = rest.IndexOf("://", StringComparison.Ordinal);
        if (scheme >= 0) rest = rest[(scheme + 3)..];
        var end = rest.IndexOfAny(['/', '?', '#', ':']);
        if (end >= 0) rest = rest[..end];
        var at = rest.LastIndexOf('@');
        return (at >= 0 ? rest[(at + 1)..] : rest).TrimEnd('.');
    }

    private static bool Allowed(string host, IReadOnlyCollection<string> domains) =>
        host.Length > 0 && domains.Any(d => host == d || host.EndsWith("." + d, StringComparison.Ordinal));

    /// <summary>The text that "the same message" compares: folded, with whitespace collapsed.</summary>
    public static string Repeatable(FoldedText text) => string.Join(' ', text.Text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
}

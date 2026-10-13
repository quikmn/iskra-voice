using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Iskra.Server.Features;

/// <summary>What the built-in bots' commands mean: dice notation, "me in 10m ..." and "Question | A | B". Pure, so it's easy to test.</summary>
public static partial class BuiltinCommands
{
    // ── /roll ────────────────────────────────────────────────────────────────

    public const int MaxDice = 100;
    public const int MaxSides = 1000;
    public const int MaxTerms = 10;
    public const int MaxConstant = 100_000;
    public const string DefaultDice = "1d6";

    /// <summary>One group of dice ("2d6"), negative when subtracted, with what each die showed.</summary>
    public sealed record DiceGroup(int Sign, int Count, int Sides, int[] Rolls);

    public sealed record DiceRoll(string Expression, List<DiceGroup> Groups, long Modifier, long Total);

    [GeneratedRegex(@"\G([+-])?(?:(\d{0,3})d(\d{1,4}|%)|(\d{1,6}))", RegexOptions.CultureInvariant)]
    private static partial Regex DiceTerm();

    [GeneratedRegex(@"[\p{L}\d%]\s+[\p{L}\d%]")]
    private static partial Regex SpacedTerm();

    /// <summary>
    /// Rolls dice notation like <c>2d6+3</c>, <c>d20</c>, <c>1d8+1d6-1</c> or <c>d%</c> (empty: 1d6). <paramref name="die"/>
    /// returns 1..sides. Null when it isn't valid notation or asks for too much.
    /// </summary>
    public static DiceRoll? Roll(string input, Func<int, int> die)
    {
        if (SpacedTerm().IsMatch(input)) return null; // "2d6 3": spaces only around + and -
        var text = new string(input.Where(c => !char.IsWhiteSpace(c)).ToArray()).ToLowerInvariant();
        if (text.Length == 0) text = DefaultDice;
        if (text.Length > 100) return null;
        var groups = new List<(int Sign, int Count, int Sides)>();
        long modifier = 0;
        var expression = new StringBuilder();
        var at = 0;
        var terms = 0;
        while (at < text.Length)
        {
            var match = DiceTerm().Match(text, at);
            if (!match.Success || match.Length == 0) return null;
            var signed = match.Groups[1].Success;
            if (terms > 0 && !signed) return null; // "2d6 3" or "2d63d4"-like leftovers
            if (++terms > MaxTerms) return null;
            var sign = match.Groups[1].Value == "-" ? -1 : 1;
            if (match.Groups[4].Success)
            {
                var constant = int.Parse(match.Groups[4].Value, CultureInfo.InvariantCulture);
                if (constant > MaxConstant) return null;
                modifier += sign * constant;
                expression.Append(sign < 0 ? "-" : expression.Length > 0 ? "+" : "").Append(constant);
            }
            else
            {
                var count = match.Groups[2].Value.Length == 0 ? 1 : int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
                var sides = match.Groups[3].Value == "%" ? 100 : int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
                if (count < 1 || sides < 2 || sides > MaxSides) return null;
                groups.Add((sign, count, sides));
                expression.Append(sign < 0 ? "-" : expression.Length > 0 ? "+" : "").Append(count).Append('d').Append(sides);
            }
            at += match.Length;
        }
        if (groups.Count == 0 || groups.Sum(g => g.Count) > MaxDice) return null;
        var rolled = groups.Select(g => new DiceGroup(g.Sign, g.Count, g.Sides, Enumerable.Range(0, g.Count).Select(_ => die(g.Sides)).ToArray())).ToList();
        var total = rolled.Sum(g => g.Sign * (long)g.Rolls.Sum()) + modifier;
        return new DiceRoll(expression.ToString(), rolled, modifier, total);
    }

    /// <summary>"Viktor rolled 2d6+3: [4, 2] +3 = 9": the plain text any app can show.</summary>
    public static string RollText(string who, DiceRoll roll)
    {
        var parts = new StringBuilder();
        foreach (var g in roll.Groups)
        {
            if (parts.Length > 0 || g.Sign < 0) parts.Append(g.Sign < 0 ? " - " : " + ");
            parts.Append('[').Append(string.Join(", ", g.Rolls)).Append(']');
        }
        if (roll.Modifier != 0) parts.Append(roll.Modifier < 0 ? " - " : " + ").Append(Math.Abs(roll.Modifier));
        return $"🎲 {who} rolled {roll.Expression}: {parts.ToString().TrimStart(' ', '+')} = {roll.Total}";
    }

    // ── /remind ──────────────────────────────────────────────────────────────

    public const long MinDelayMs = 60_000;
    public const long MaxDelayMs = 365L * 24 * 3600 * 1000;
    public const int MaxNote = 300;

    public sealed record Remind(long DelayMs, string Note);

    private static readonly Dictionary<string, long> Units = new(StringComparer.Ordinal)
    {
        // English
        ["m"] = 60_000, ["min"] = 60_000, ["mins"] = 60_000, ["minute"] = 60_000, ["minutes"] = 60_000,
        ["h"] = 3_600_000, ["hr"] = 3_600_000, ["hrs"] = 3_600_000, ["hour"] = 3_600_000, ["hours"] = 3_600_000,
        ["d"] = 86_400_000, ["day"] = 86_400_000, ["days"] = 86_400_000,
        ["w"] = 604_800_000, ["wk"] = 604_800_000, ["week"] = 604_800_000, ["weeks"] = 604_800_000,
        // Swedish
        ["minut"] = 60_000, ["minuter"] = 60_000, ["t"] = 3_600_000, ["tim"] = 3_600_000, ["timme"] = 3_600_000, ["timmar"] = 3_600_000,
        ["dag"] = 86_400_000, ["dagar"] = 86_400_000, ["v"] = 604_800_000, ["vecka"] = 604_800_000, ["veckor"] = 604_800_000,
    };

    [GeneratedRegex(@"\G(\d{1,6})\s*(\p{L}+)(?!\p{L})\s*,?\s*(?:(?:and|och)\s+(?=\d))?", RegexOptions.CultureInvariant)]
    private static partial Regex DurationPart();

    [GeneratedRegex(@"^(?:(?:me|mig)\s+)?(?:(?:in|om)\s+)?", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex RemindLead();

    [GeneratedRegex(@"^(?:(?:to|about|att|om)\s+|[:\-–]\s*)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex RemindJoin();

    /// <summary>"me in 1h30m take the pizza out" (also "in 10 minutes", Swedish "mig om 2 timmar ..."). Null if no time was given, or it's out of range.</summary>
    public static Remind? ParseRemind(string args)
    {
        var text = args.Trim();
        text = text[RemindLead().Match(text).Length..];
        long delay = 0;
        var at = 0;
        var any = false;
        while (DurationPart().Match(text, at) is { Success: true } m && Units.TryGetValue(m.Groups[2].Value.ToLowerInvariant(), out var unit))
        {
            delay += long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) * unit;
            if (delay > MaxDelayMs) return null;
            at += m.Length;
            any = true;
        }
        if (!any || delay < MinDelayMs) return null;
        var note = text[at..].Trim();
        note = note[RemindJoin().Match(note).Length..].Trim();
        if (note.Length > MaxNote) note = note[..(MaxNote - 1)] + "…";
        return new Remind(delay, note);
    }

    // ── /poll ────────────────────────────────────────────────────────────────

    [GeneratedRegex("[\"“”„]([^\"“”„]+)[\"“”„]")]
    private static partial Regex Quoted();

    /// <summary>"Question | Answer | Answer", or "\"Question\" \"Answer\" \"Answer\"". Null if there's no question and two answers.</summary>
    public static (string Question, string[] Answers)? ParsePoll(string args)
    {
        string[] parts;
        if (args.Contains('|')) parts = args.Split('|').Select(p => p.Trim()).Where(p => p.Length > 0).ToArray();
        else parts = Quoted().Matches(args).Select(m => m.Groups[1].Value.Trim()).Where(p => p.Length > 0).ToArray();
        if (parts.Length < 3) return null;
        return (parts[0], parts[1..]);
    }
}

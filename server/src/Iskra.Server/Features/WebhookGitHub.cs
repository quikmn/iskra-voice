using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Sessions;

namespace Iskra.Server.Features;

/// <summary>
/// GitHub's own webhook format (like Discord's ".../github" URL suffix): turns the common events into a short
/// message with an embed. Returns null for events that aren't worth a message.
/// </summary>
public static class WebhookGitHub
{
    private const int GitHubColor = 0x24292F;

    public static WebhookPostRequest? Translate(string? eventName, JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new PayloadException("The body must be a JSON object.");
        var repo = Str(root, "repository", "full_name") ?? "GitHub";
        var sender = Str(root, "sender", "login");
        var action = Str(root, "action");

        string? title = null, url = null, description = null;
        var color = GitHubColor;
        switch (eventName)
        {
            case "ping":
                title = $"[{repo}] Webhook connected";
                description = Str(root, "zen");
                break;
            case "push":
            {
                var commits = root.TryGetProperty("commits", out var c) && c.ValueKind == JsonValueKind.Array ? c.EnumerateArray().ToList() : [];
                if (commits.Count == 0) return null; // branch created/deleted without commits
                var branch = (Str(root, "ref") ?? "").Replace("refs/heads/", "");
                title = $"[{repo}:{branch}] {commits.Count} new commit{(commits.Count == 1 ? "" : "s")}";
                url = Str(root, "compare");
                description = string.Join("\n", commits.Take(MaxCommits).Select(CommitLine));
                if (commits.Count > MaxCommits) description += $"\n…and {commits.Count - MaxCommits} more";
                break;
            }
            case "issues" or "pull_request":
            {
                if (action is not ("opened" or "closed" or "reopened")) return null;
                var kind = eventName == "issues" ? "issue" : "pull_request";
                var what = eventName == "issues" ? "Issue" : "Pull request";
                var merged = eventName == "pull_request" && action == "closed" && root.TryGetProperty(kind, out var pr)
                    && pr.TryGetProperty("merged", out var m) && m.ValueKind == JsonValueKind.True;
                title = $"[{repo}] {what} {(merged ? "merged" : action)}: #{Num(root, kind, "number")} {Str(root, kind, "title")}";
                url = Str(root, kind, "html_url");
                if (action == "opened") description = Excerpt(Str(root, kind, "body") ?? "", 500);
                break;
            }
            case "issue_comment":
                if (action != "created") return null;
                title = $"[{repo}] New comment on #{Num(root, "issue", "number")}: {Str(root, "issue", "title")}";
                url = Str(root, "comment", "html_url");
                description = Excerpt(Str(root, "comment", "body") ?? "", 500);
                break;
            case "release":
                if (action != "published") return null;
                title = $"[{repo}] New release: {Str(root, "release", "name") ?? Str(root, "release", "tag_name")}";
                url = Str(root, "release", "html_url");
                description = Excerpt((Str(root, "release", "body") ?? "").Trim(), 1500);
                break;
            case "workflow_run":
            {
                // A finished workflow run (CI, releases, deploys): failures always, successes only for the workflows
                // people watch and not for scheduled runs, so a channel isn't flooded by uptime checks.
                if (action != "completed") return null;
                var conclusion = Str(root, "workflow_run", "conclusion");
                if (conclusion is null or "cancelled" or "skipped" or "neutral") return null;
                var name = Str(root, "workflow_run", "name") ?? "Workflow";
                var trigger = Str(root, "workflow_run", "event");
                var ok = conclusion == "success";
                if (ok && (trigger == "schedule" || !WatchedWorkflows.Any(w => name.StartsWith(w, StringComparison.Ordinal)))) return null;
                var branch = Str(root, "workflow_run", "head_branch");
                title = $"[{repo}{(branch is null ? "" : $":{branch}")}] {(ok ? "✅" : "❌")} {name} {(ok ? "passed" : conclusion.Replace('_', ' '))}";
                url = Str(root, "workflow_run", "html_url");
                var message = Str(root, "workflow_run", "head_commit", "message") ?? "";
                var sha = Str(root, "workflow_run", "head_sha");
                var subject = message.Split('\n', 2)[0];
                if (subject.Length > 0) description = $"{(sha is { Length: >= 7 } ? $"`{sha[..7]}` " : "")}{Short(subject, 200)}";
                color = ok ? 0x2EA043 : 0xCF222E;
                break;
            }
            case "star" or "watch":
                if (action is not ("created" or "started")) return null;
                title = $"[{repo}] New star";
                url = Str(root, "repository", "html_url");
                break;
            default:
                title = $"[{repo}] {eventName ?? "event"}{(action is null ? "" : $" {action}")}";
                url = Str(root, "repository", "html_url");
                break;
        }

        var embed = new JsonObject { ["title"] = Short(title, 256), ["color"] = color };
        if (IsWebUrl(url)) embed["url"] = url;
        var cleaned = Sanitize(description, 4096);
        if (!string.IsNullOrEmpty(cleaned)) embed["description"] = cleaned;
        if (sender is not null && Names.Normalize(Short(sender, 32)) is { } login) embed["author"] = new JsonObject { ["name"] = login };
        return new WebhookPostRequest("", null, [embed], MentionRules.None);
    }

    private const int MaxCommits = 8;

    /// <summary>Workflows whose successful runs are worth a message (prefixes of the workflow name); failures always are.</summary>
    private static readonly string[] WatchedWorkflows = ["CI", "Release", "Deploy", "Bot SDK", "Mobile"];

    /// <summary>
    /// "`abc1234` Subject · Author · 3 files", then the first paragraph of the message body on its own line
    /// (trailers such as Co-Authored-By left out).
    /// </summary>
    private static string CommitLine(JsonElement commit)
    {
        var id = (Str(commit, "id") ?? "").PadRight(7)[..7];
        var message = (Str(commit, "message") ?? "").Replace("\r\n", "\n").Trim();
        var parts = message.Split("\n\n", 2);
        var subject = parts[0].Replace('\n', ' ');
        var author = Str(commit, "author", "name") ?? Str(commit, "author", "username") ?? "someone";
        var files = new[] { "added", "modified", "removed" }
            .Sum(k => commit.TryGetProperty(k, out var a) && a.ValueKind == JsonValueKind.Array ? a.GetArrayLength() : 0);
        var line = $"`{id}` {Excerpt(subject, 160)} · {author}{(files > 0 ? $" · {files} file{(files == 1 ? "" : "s")}" : "")}";
        if (parts.Length > 1)
        {
            var paragraph = string.Join(' ', parts[1].Split("\n\n")[0].Split('\n')
                .Where(l => !Trailer.IsMatch(l))
                .Select(l => l.Trim())).Trim();
            if (paragraph.Length > 0) line += $"\n↳ {Excerpt(paragraph, 240)}";
        }
        return line;
    }

    private static readonly System.Text.RegularExpressions.Regex Trailer =
        new(@"^\s*[A-Za-z-]+-by:", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    private static string? Str(JsonElement element, params string[] path)
    {
        foreach (var part in path)
        {
            if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(part, out element)) return null;
        }
        return element.ValueKind == JsonValueKind.String ? element.GetString() : null;
    }

    private static long? Num(JsonElement element, params string[] path)
    {
        foreach (var part in path)
        {
            if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(part, out element)) return null;
        }
        return element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out var n) ? n : null;
    }

    private static bool IsWebUrl(string? url) =>
        url is not null && url.Length <= 2048 && Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme is "http" or "https";

    private static string Excerpt(string text, int max) => text.Length <= max ? text : Cut(text, max).TrimEnd() + "…";

    /// <summary>The first <paramref name="max"/> characters, without splitting a surrogate pair.</summary>
    private static string Cut(string text, int max) => text[..(char.IsHighSurrogate(text[max - 1]) ? max - 1 : max)];

    private static string Short(string text, int max) => Sanitize(text, max) ?? "GitHub";

    /// <summary>GitHub text is user-written: same rules as chat, invisible characters dropped rather than rejected.</summary>
    private static string? Sanitize(string? text, int max)
    {
        if (text is null) return null;
        var visible = new string(text.Replace("\r\n", "\n").Where(ch => ch is '\n' or '\t' or '‍' ||
            System.Globalization.CharUnicodeInfo.GetUnicodeCategory(ch) is not (System.Globalization.UnicodeCategory.Control
                or System.Globalization.UnicodeCategory.Format or System.Globalization.UnicodeCategory.LineSeparator
                or System.Globalization.UnicodeCategory.ParagraphSeparator)).ToArray());
        if (visible.Length > max) visible = Cut(visible, max - 1) + "…";
        return Text.Normalize(visible, max, allowNewlines: true);
    }
}

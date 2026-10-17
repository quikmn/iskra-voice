using System.Text.Json;
using static Iskra.Server.Features.WebhookText;

namespace Iskra.Server.Features;

/// <summary>
/// GitLab's webhook format (".../gitlab"): pushes, tags, merge requests, issues, comments and finished pipelines become a
/// short message with an embed. Confidential issues and notes are never posted. Returns null for anything else.
/// </summary>
public static class WebhookGitLab
{
    private const int GitLabColor = 0xFC6D26;

    public static WebhookPostRequest? Translate(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new PayloadException("The body must be a JSON object.");
        var kind = Str(root, "object_kind");
        var eventType = Str(root, "event_type");
        var repo = Str(root, "project", "path_with_namespace") ?? Str(root, "project", "name") ?? "GitLab";
        var web = Str(root, "project", "web_url");
        var sender = Str(root, "user_username") ?? Str(root, "user", "username") ?? Str(root, "user_name") ?? Str(root, "user", "name");
        var action = Str(root, "object_attributes", "action");

        string? title, url = null, description = null;
        var color = GitLabColor;
        switch (kind)
        {
            case "push":
            {
                var commits = Array(root, "commits");
                if (commits.Count == 0) return null; // a branch deleted, or created without new commits
                var total = (int)Math.Clamp(Num(root, "total_commits_count") ?? commits.Count, commits.Count, 1_000_000);
                var branch = (Str(root, "ref") ?? "").Replace("refs/heads/", "");
                title = $"[{repo}:{branch}] {total} new commit{(total == 1 ? "" : "s")}";
                var (before, after) = (Str(root, "before"), Str(root, "after"));
                url = web is not null && Sha(before) && Sha(after) && !Zero(before!) ? $"{web}/-/compare/{before}...{after}" : web;
                description = CommitLines(commits, total);
                break;
            }
            case "tag_push":
            {
                if (Str(root, "checkout_sha") is null || Zero(Str(root, "after") ?? "")) return null; // a tag deleted
                var tag = (Str(root, "ref") ?? "").Replace("refs/tags/", "");
                title = $"[{repo}] New tag: {tag}";
                url = web is null ? null : $"{web}/-/tags/{Uri.EscapeDataString(tag)}";
                description = Excerpt((Str(root, "message") ?? "").Trim(), 500);
                break;
            }
            case "merge_request":
            {
                if (action is not ("open" or "close" or "reopen" or "merge")) return null;
                var done = action switch { "open" => "opened", "close" => "closed", "reopen" => "reopened", _ => "merged" };
                title = $"[{repo}] Merge request {done}: !{Num(root, "object_attributes", "iid")} {Str(root, "object_attributes", "title")}";
                url = Str(root, "object_attributes", "url");
                if (action == "open") description = Excerpt(Str(root, "object_attributes", "description") ?? "", 500);
                break;
            }
            case "issue":
            {
                if (eventType == "confidential_issue" || IsTrue(root, "object_attributes", "confidential")) return null;
                if (action is not ("open" or "close" or "reopen")) return null;
                var done = action switch { "open" => "opened", "close" => "closed", _ => "reopened" };
                title = $"[{repo}] Issue {done}: #{Num(root, "object_attributes", "iid")} {Str(root, "object_attributes", "title")}";
                url = Str(root, "object_attributes", "url");
                if (action == "open") description = Excerpt(Str(root, "object_attributes", "description") ?? "", 500);
                break;
            }
            case "note":
            {
                if (eventType == "confidential_note" || IsTrue(root, "object_attributes", "confidential") || IsTrue(root, "issue", "confidential"))
                    return null;
                var on = Str(root, "object_attributes", "noteable_type") switch
                {
                    "MergeRequest" => $"!{Num(root, "merge_request", "iid")}: {Str(root, "merge_request", "title")}",
                    "Issue" => $"#{Num(root, "issue", "iid")}: {Str(root, "issue", "title")}",
                    "Commit" => $"commit `{(Str(root, "commit", "id") ?? "").PadRight(7)[..7]}`",
                    "Snippet" => $"snippet: {Str(root, "snippet", "title")}",
                    _ => null,
                };
                if (on is null) return null;
                title = $"[{repo}] New comment on {on}";
                url = Str(root, "object_attributes", "url");
                description = Excerpt(Str(root, "object_attributes", "note") ?? "", 500);
                break;
            }
            case "pipeline":
            {
                // Finished pipelines only: failures always, successes unless scheduled (so uptime jobs don't flood).
                var status = Str(root, "object_attributes", "status");
                if (status is not ("success" or "failed")) return null;
                var ok = status == "success";
                if (ok && Str(root, "object_attributes", "source") == "schedule") return null;
                var id = Num(root, "object_attributes", "id");
                var branch = Str(root, "object_attributes", "ref");
                title = $"[{repo}{(branch is null ? "" : $":{branch}")}] {(ok ? "✅" : "❌")} Pipeline #{id} {(ok ? "passed" : "failed")}";
                url = Str(root, "object_attributes", "url") ?? (web is null || id is null ? null : $"{web}/-/pipelines/{id}");
                var sha = Str(root, "object_attributes", "sha");
                var subject = (Str(root, "commit", "title") ?? Str(root, "commit", "message") ?? "").Split('\n', 2)[0];
                if (subject.Length > 0) description = $"{(sha is { Length: >= 7 } ? $"`{sha[..7]}` " : "")}{Short(subject, 200, "")}";
                color = ok ? 0x2EA043 : 0xCF222E;
                break;
            }
            default:
                return null;
        }

        return new WebhookPostRequest("", null, [Embed(title, url, description, color, sender, "GitLab")], MentionRules.None);
    }

    private static bool Sha(string? s) => s is { Length: 40 } && s.All(char.IsAsciiHexDigit);

    private static bool Zero(string s) => s.Length > 0 && s.All(c => c == '0');

    private static bool IsTrue(JsonElement root, string obj, string field) =>
        root.TryGetProperty(obj, out var o) && o.ValueKind == JsonValueKind.Object && o.TryGetProperty(field, out var v) && v.ValueKind == JsonValueKind.True;
}

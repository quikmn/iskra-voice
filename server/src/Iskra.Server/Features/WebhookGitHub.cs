using System.Text.Json;
using static Iskra.Server.Features.WebhookText;

namespace Iskra.Server.Features;

/// <summary>
/// GitHub's own webhook format (like Discord's ".../github" URL suffix), and Gitea's, which copies it: turns the common
/// events into a short message with an embed. Returns null for events and actions that aren't worth a message.
/// </summary>
public static class WebhookGitHub
{
    private const int GitHubColor = 0x24292F;
    private const int GiteaColor = 0x609926;

    public static WebhookPostRequest? Translate(string? eventName, JsonElement root, bool gitea = false)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new PayloadException("The body must be a JSON object.");
        var vendor = gitea ? "Gitea" : "GitHub";
        var repo = Str(root, "repository", "full_name") ?? vendor;
        var sender = Str(root, "sender", "login") ?? Str(root, "sender", "username");
        var action = Str(root, "action");

        string? title = null, url = null, description = null;
        var color = gitea ? GiteaColor : GitHubColor;
        switch (eventName)
        {
            case "ping":
                title = $"[{repo}] Webhook connected";
                description = Str(root, "zen");
                break;
            case "push":
            {
                var commits = Array(root, "commits");
                if (commits.Count == 0) return null; // branch created/deleted without commits
                var branch = (Str(root, "ref") ?? "").Replace("refs/heads/", "");
                title = $"[{repo}:{branch}] {commits.Count} new commit{(commits.Count == 1 ? "" : "s")}";
                url = Str(root, "compare") ?? Str(root, "compare_url");
                description = CommitLines(commits, commits.Count);
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
            case "issue_comment" or "pull_request_comment":
                if (action != "created") return null;
                title = $"[{repo}] New comment on #{Num(root, "issue", "number") ?? Num(root, "pull_request", "number")}: {Str(root, "issue", "title") ?? Str(root, "pull_request", "title")}";
                url = Str(root, "comment", "html_url");
                description = Excerpt(Str(root, "comment", "body") ?? "", 500);
                break;
            case "release":
                if (action != "published") return null;
                title = $"[{repo}] New release: {(Str(root, "release", "name") is { Length: > 0 } n ? n : Str(root, "release", "tag_name"))}";
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
                if (subject.Length > 0) description = $"{(sha is { Length: >= 7 } ? $"`{sha[..7]}` " : "")}{Short(subject, 200, "")}";
                color = ok ? 0x2EA043 : 0xCF222E;
                break;
            }
            case "star" or "watch":
                if (action is not ("created" or "started")) return null;
                title = $"[{repo}] New star";
                url = Str(root, "repository", "html_url");
                break;
            default:
                return null; // events we don't post about are answered 204, so the sender doesn't retry
        }

        var embed = Embed(title, url, description, color, sender, vendor);
        return new WebhookPostRequest("", null, [embed], MentionRules.None);
    }

    /// <summary>Workflows whose successful runs are worth a message (prefixes of the workflow name); failures always are.</summary>
    private static readonly string[] WatchedWorkflows = ["CI", "Release", "Deploy", "Bot SDK", "Mobile"];
}

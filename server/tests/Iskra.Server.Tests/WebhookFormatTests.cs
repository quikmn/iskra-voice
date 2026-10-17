using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>
/// The vendor formats of incoming webhooks (/github, /gitea, /gitlab, /slack) with sample payloads shaped like the
/// vendors' documentation, their signatures, and events we don't post about.
/// </summary>
public class WebhookFormatTests
{
    private const string Secret = "It's a Secret to Everybody";

    private static async Task<string> Hook(User admin, long channelId, string? signing = null)
    {
        var created = (await admin.RequestAsync("webhook.create", new { channelId, name = "Dev" })).Body();
        var id = created.GetProperty("webhook").GetProperty("id").GetString()!;
        if (signing is not null) Assert.Equal("result", (await admin.RequestAsync("webhook.signing.set", new { id, secret = signing })).Type());
        return created.GetProperty("path").GetString()!;
    }

    private static async Task<HttpResponseMessage> Send(IskraServer server, string path, string body, params (string Name, string Value)[] headers)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        foreach (var (name, value) in headers) request.Headers.TryAddWithoutValidation(name, value);
        return await server.CreateClient().SendAsync(request);
    }

    private static string Hmac(string secret, string body) =>
        "sha256=" + Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body)));

    private static async Task<JsonElement> Card(User reader)
    {
        var message = (await reader.EventAsync("chat.message")).Body().GetProperty("message");
        return message.GetProperty("webhook").GetProperty("embeds")[0];
    }

    // ── GitHub ───────────────────────────────────────────────────────────────

    private const string GitHubPush = """
        {"ref":"refs/heads/main","before":"6113728f27ae82c7b1a177c8d03f9e96e0adf246","after":"59b20b8d5c6ff8d09518454d4dd8b7a2b5d5a4e3",
         "repository":{"id":1296269,"name":"Hello-World","full_name":"octocat/Hello-World","html_url":"https://github.com/octocat/Hello-World"},
         "pusher":{"name":"octocat","email":"octocat@github.com"},"sender":{"login":"octocat","id":1,"avatar_url":"https://github.com/images/error/octocat_happy.gif"},
         "created":false,"deleted":false,"forced":false,"compare":"https://github.com/octocat/Hello-World/compare/6113728f27ae...59b20b8d5c6f",
         "commits":[{"id":"59b20b8d5c6ff8d09518454d4dd8b7a2b5d5a4e3","tree_id":"f9d2a07e9488b91af2641b26b9407fe22a451433","distinct":true,
           "message":"Update README.md","timestamp":"2015-05-05T19:40:15-04:00","url":"https://github.com/octocat/Hello-World/commit/59b20b8d",
           "author":{"name":"The Octocat","email":"octocat@github.com","username":"octocat"},"committer":{"name":"GitHub","email":"noreply@github.com"},
           "added":[],"removed":[],"modified":["README.md"]}],
         "head_commit":null}
        """;

    [Fact]
    public async Task GitHub_events_become_cards_and_a_signing_secret_is_enforced()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var path = await Hook(admin, server.General, Secret) + "/github";

        // Good signature: posted. Wrong or missing: 401 and nothing posted.
        using (var r = await Send(server, path, GitHubPush, ("X-GitHub-Event", "push"), ("X-Hub-Signature-256", Hmac(Secret, GitHubPush))))
            Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        var push = await Card(admin);
        Assert.Equal("[octocat/Hello-World:main] 1 new commit", push.GetProperty("title").GetString());
        Assert.Equal("https://github.com/octocat/Hello-World/compare/6113728f27ae...59b20b8d5c6f", push.GetProperty("url").GetString());
        Assert.Equal("`59b20b8` Update README.md · The Octocat · 1 file", push.GetProperty("description").GetString());
        Assert.Equal("octocat", push.GetProperty("author").GetProperty("name").GetString());
        Assert.DoesNotContain("octocat_happy.gif", push.GetRawText()); // no third-party images

        using (var r = await Send(server, path, GitHubPush, ("X-GitHub-Event", "push"), ("X-Hub-Signature-256", Hmac("wrong secret!!!!!!", GitHubPush))))
            Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        using (var r = await Send(server, path, GitHubPush, ("X-GitHub-Event", "push")))
            Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        using (var r = await Send(server, path, GitHubPush + " ", ("X-GitHub-Event", "push"), ("X-Hub-Signature-256", Hmac(Secret, GitHubPush))))
            Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode); // the body changed
        // Unknown events and actions we skip: 204 without a message, so GitHub doesn't retry.
        using (var r = await Send(server, path, """{"forkee":{"full_name":"x/y"},"repository":{"full_name":"octocat/Hello-World"}}""", ("X-GitHub-Event", "fork"), ("X-Hub-Signature-256", Hmac(Secret, """{"forkee":{"full_name":"x/y"},"repository":{"full_name":"octocat/Hello-World"}}"""))))
            Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        await admin.NoEventAsync("chat.message");
    }

    [Fact]
    public async Task GitHub_pull_requests_issues_comments_releases_and_stars()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var path = await Hook(admin, server.General) + "/github";
        var repo = """ "repository":{"full_name":"octocat/Hello-World","html_url":"https://github.com/octocat/Hello-World"},"sender":{"login":"octocat"} """;

        await Send(server, path, $$$"""{"action":"closed","number":1347,"pull_request":{"number":1347,"html_url":"https://github.com/octocat/Hello-World/pull/1347","title":"Amazing new feature","body":"Please pull these awesome changes in!","merged":true},{{{repo}}}}""", ("X-GitHub-Event", "pull_request"));
        var pr = await Card(admin);
        Assert.Equal("[octocat/Hello-World] Pull request merged: #1347 Amazing new feature", pr.GetProperty("title").GetString());
        Assert.Equal("https://github.com/octocat/Hello-World/pull/1347", pr.GetProperty("url").GetString());

        await Send(server, path, $$$"""{"action":"opened","issue":{"number":1347,"html_url":"https://github.com/octocat/Hello-World/issues/1347","title":"Found a bug","body":"I'm having a problem with this."},{{{repo}}}}""", ("X-GitHub-Event", "issues"));
        var issue = await Card(admin);
        Assert.Equal("[octocat/Hello-World] Issue opened: #1347 Found a bug", issue.GetProperty("title").GetString());
        Assert.Equal("I'm having a problem with this.", issue.GetProperty("description").GetString());

        await Send(server, path, $$$"""{"action":"created","issue":{"number":1347,"title":"Found a bug"},"comment":{"html_url":"https://github.com/octocat/Hello-World/issues/1347#issuecomment-1","body":"Me too"},{{{repo}}}}""", ("X-GitHub-Event", "issue_comment"));
        Assert.Equal("[octocat/Hello-World] New comment on #1347: Found a bug", (await Card(admin)).GetProperty("title").GetString());

        await Send(server, path, $$$"""{"action":"published","release":{"tag_name":"v1.0.0","name":"","html_url":"https://github.com/octocat/Hello-World/releases/tag/v1.0.0","body":"Description of the release"},{{{repo}}}}""", ("X-GitHub-Event", "release"));
        Assert.Equal("[octocat/Hello-World] New release: v1.0.0", (await Card(admin)).GetProperty("title").GetString());

        await Send(server, path, $$$"""{"action":"created","starred_at":"2019-05-15T15:20:40Z",{{{repo}}}}""", ("X-GitHub-Event", "star"));
        Assert.Equal("[octocat/Hello-World] New star", (await Card(admin)).GetProperty("title").GetString());
    }

    // ── Gitea ────────────────────────────────────────────────────────────────

    private const string GiteaPush = """
        {"secret":"","ref":"refs/heads/develop","before":"28e1879d029cb852e4844d9c718537df08844e03","after":"bffeb74224043ba2feb48d137756c8a9331c449a",
         "compare_url":"http://localhost:3000/gitea/webhooks/compare/28e1879d029cb852e4844d9c718537df08844e03...bffeb74224043ba2feb48d137756c8a9331c449a",
         "commits":[{"id":"bffeb74224043ba2feb48d137756c8a9331c449a","message":"Webhooks Yay!","url":"http://localhost:3000/gitea/webhooks/commit/bffeb74224043ba2feb48d137756c8a9331c449a",
           "author":{"name":"Gitea","email":"someone@gitea.io","username":"gitea"},"committer":{"name":"Gitea","email":"someone@gitea.io","username":"gitea"},"timestamp":"2017-03-13T13:52:11-04:00"}],
         "repository":{"id":140,"owner":{"id":1,"login":"gitea","avatar_url":"https://localhost:3000/avatars/1"},"name":"webhooks","full_name":"gitea/webhooks","html_url":"http://localhost:3000/gitea/webhooks"},
         "pusher":{"id":1,"login":"gitea","username":"gitea"},"sender":{"id":1,"login":"gitea","username":"gitea","avatar_url":"https://localhost:3000/avatars/1"}}
        """;

    [Fact]
    public async Task Gitea_posts_like_GitHub_with_its_own_signature_header()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var path = await Hook(admin, server.General, Secret) + "/gitea";
        var hex = Hmac(Secret, GiteaPush)["sha256=".Length..];

        using (var r = await Send(server, path, GiteaPush, ("X-Gitea-Event", "push"), ("X-Gitea-Signature", hex)))
            Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        var card = await Card(admin);
        Assert.Equal("[gitea/webhooks:develop] 1 new commit", card.GetProperty("title").GetString());
        Assert.StartsWith("http://localhost:3000/gitea/webhooks/compare/", card.GetProperty("url").GetString());
        Assert.Equal("`bffeb74` Webhooks Yay! · Gitea", card.GetProperty("description").GetString());
        Assert.Equal(0x609926, card.GetProperty("color").GetInt32());

        using (var r = await Send(server, path, GiteaPush, ("X-Gitea-Event", "push"), ("X-Gitea-Signature", new string('0', 64))))
            Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        using (var r = await Send(server, path, """{"repository":{"full_name":"gitea/webhooks"}}""", ("X-Gitea-Event", "wiki"), ("X-Gitea-Signature", Hmac(Secret, """{"repository":{"full_name":"gitea/webhooks"}}""")["sha256=".Length..])))
            Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        await admin.NoEventAsync("chat.message");
    }

    // ── GitLab ───────────────────────────────────────────────────────────────

    private const string GitLabProject = """
        "project":{"id":15,"name":"Diaspora","path_with_namespace":"mike/diaspora","web_url":"http://example.com/mike/diaspora","avatar_url":null}
        """;

    private const string GitLabPush = """
        {"object_kind":"push","event_name":"push","before":"95790bf891e76fee5e1747ab589903a6a1f80f22","after":"da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
         "ref":"refs/heads/master","checkout_sha":"da1560886d4f094c3e6c9ef40349f7d38b5d27d7","user_id":4,"user_name":"John Smith","user_username":"jsmith",
         "user_avatar":"https://s.gravatar.com/avatar/d4c74594d841139328695756648b6bd6?s=8://s.gravatar.com/avatar/d4c74594d841139328695756648b6bd6?s=80",
         "project_id":15,
        """ + GitLabProject + """
        ,"commits":[{"id":"b6568db1bc1dcd7f8b4d5a946b0b91f9dacd7327","message":"Update Catalan translation to e38cb41.\n\nSee https://gitlab.com/gitlab-org/gitlab for more information",
           "title":"Update Catalan translation to e38cb41.","timestamp":"2011-12-12T14:27:31+02:00","url":"http://example.com/mike/diaspora/commit/b6568db1",
           "author":{"name":"Jordi Mallach","email":"jordi@softcatala.org"},"added":["CHANGELOG"],"modified":["app/controller/application.rb"],"removed":[]},
          {"id":"da1560886d4f094c3e6c9ef40349f7d38b5d27d7","message":"fixed readme","title":"fixed readme","timestamp":"2012-01-03T23:36:29+02:00",
           "url":"http://example.com/mike/diaspora/commit/da1560886d4f094c3e6c9ef40349f7d38b5d27d7","author":{"name":"GitLab dev user","email":"gitlabdev@dv6700.(none)"},
           "added":["CHANGELOG"],"modified":["app/controller/application.rb"],"removed":[]}],
         "total_commits_count":4,"repository":{"name":"Diaspora","url":"git@example.com:mike/diaspora.git"}}
        """;

    [Fact]
    public async Task GitLab_events_become_cards_and_its_token_is_checked()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var path = await Hook(admin, server.General, Secret) + "/gitlab";

        using (var r = await Send(server, path, GitLabPush, ("X-Gitlab-Event", "Push Hook"), ("X-Gitlab-Token", Secret)))
            Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        var push = await Card(admin);
        Assert.Equal("[mike/diaspora:master] 4 new commits", push.GetProperty("title").GetString());
        Assert.Equal("http://example.com/mike/diaspora/-/compare/95790bf891e76fee5e1747ab589903a6a1f80f22...da1560886d4f094c3e6c9ef40349f7d38b5d27d7", push.GetProperty("url").GetString());
        Assert.Equal("`b6568db` Update Catalan translation to e38cb41. · Jordi Mallach · 2 files\n↳ See https://gitlab.com/gitlab-org/gitlab for more information\n`da15608` fixed readme · GitLab dev user · 2 files\n…and 2 more",
            push.GetProperty("description").GetString());
        Assert.Equal("jsmith", push.GetProperty("author").GetProperty("name").GetString());
        Assert.DoesNotContain("gravatar", push.GetRawText());

        using (var r = await Send(server, path, GitLabPush, ("X-Gitlab-Event", "Push Hook"), ("X-Gitlab-Token", "not the token at all")))
            Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        using (var r = await Send(server, path, GitLabPush, ("X-Gitlab-Event", "Push Hook")))
            Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        await admin.NoEventAsync("chat.message");
    }

    [Fact]
    public async Task GitLab_merge_requests_issues_notes_pipelines_and_tags()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var path = await Hook(admin, server.General) + "/gitlab";
        var user = """ "user":{"id":1,"name":"Administrator","username":"root","avatar_url":"http://www.gravatar.com/avatar/e64c7d89f26bd1972efa854d13d7dd61?s=40&d=identicon"} """;

        await Send(server, path, $$$"""{"object_kind":"merge_request","event_type":"merge_request",{{{user}}},{{{GitLabProject}}},"object_attributes":{"id":99,"iid":1,"target_branch":"master","source_branch":"ms-viewport","title":"MS-Viewport","description":"","state":"merged","action":"merge","url":"http://example.com/diaspora/merge_requests/1"}}""");
        var mr = await Card(admin);
        Assert.Equal("[mike/diaspora] Merge request merged: !1 MS-Viewport", mr.GetProperty("title").GetString());
        Assert.Equal("http://example.com/diaspora/merge_requests/1", mr.GetProperty("url").GetString());
        Assert.Equal("root", mr.GetProperty("author").GetProperty("name").GetString());

        await Send(server, path, $$$"""{"object_kind":"issue","event_type":"issue",{{{user}}},{{{GitLabProject}}},"object_attributes":{"id":301,"iid":23,"title":"New API: create/update/delete file","description":"Create new API for manipulations with repository","state":"opened","action":"open","confidential":false,"url":"http://example.com/diaspora/issues/23"}}""");
        var issue = await Card(admin);
        Assert.Equal("[mike/diaspora] Issue opened: #23 New API: create/update/delete file", issue.GetProperty("title").GetString());
        Assert.Equal("Create new API for manipulations with repository", issue.GetProperty("description").GetString());

        await Send(server, path, $$$"""{"object_kind":"note","event_type":"note",{{{user}}},{{{GitLabProject}}},"object_attributes":{"id":1244,"note":"This MR needs work.","noteable_type":"MergeRequest","url":"http://example.com/gitlab-org/gitlab-test/merge_requests/1#note_1244"},"merge_request":{"id":7,"iid":1,"title":"Tempora et eos debitis quae laborum et."}}""");
        var note = await Card(admin);
        Assert.Equal("[mike/diaspora] New comment on !1: Tempora et eos debitis quae laborum et.", note.GetProperty("title").GetString());
        Assert.Equal("This MR needs work.", note.GetProperty("description").GetString());

        await Send(server, path, $$$"""{"object_kind":"pipeline",{{{user}}},{{{GitLabProject}}},"object_attributes":{"id":31,"iid":3,"ref":"master","tag":false,"sha":"bcbb5ec396a2c0f828686f14fac9b80b780504f2","source":"merge_request_event","status":"failed","stages":["build","test","deploy"],"url":"http://example.com/gitlab-org/gitlab-test/-/pipelines/31"},"commit":{"id":"bcbb5ec396a2c0f828686f14fac9b80b780504f2","message":"test\n","title":"test"}}""");
        var pipeline = await Card(admin);
        Assert.Equal("[mike/diaspora:master] ❌ Pipeline #31 failed", pipeline.GetProperty("title").GetString());
        Assert.Equal("`bcbb5ec` test", pipeline.GetProperty("description").GetString());

        // A fresh webhook: the burst of five is used up.
        var more = await Hook(admin, server.General) + "/gitlab";
        await Send(server, more, $$$"""{"object_kind":"tag_push","event_name":"tag_push","before":"0000000000000000000000000000000000000000","after":"82b3d5ae55f7080f1e6022629cdb57bfae7cccc7","ref":"refs/tags/v1.0.0","checkout_sha":"82b3d5ae55f7080f1e6022629cdb57bfae7cccc7","message":"Tag message","user_username":"jsmith",{{{GitLabProject}}},"commits":[],"total_commits_count":0}""");
        var tag = await Card(admin);
        Assert.Equal("[mike/diaspora] New tag: v1.0.0", tag.GetProperty("title").GetString());
        Assert.Equal("http://example.com/mike/diaspora/-/tags/v1.0.0", tag.GetProperty("url").GetString());

        // Confidential issues and notes, running pipelines and unknown kinds: 204 and no message.
        foreach (var skipped in new[]
        {
            $$$"""{"object_kind":"issue","event_type":"confidential_issue",{{{user}}},{{{GitLabProject}}},"object_attributes":{"iid":24,"title":"Secret","action":"open","confidential":true}}""",
            $$$"""{"object_kind":"pipeline",{{{user}}},{{{GitLabProject}}},"object_attributes":{"id":32,"ref":"master","status":"running"}}""",
            $$$"""{"object_kind":"wiki_page",{{{user}}},{{{GitLabProject}}},"object_attributes":{"title":"Home","action":"update"}}""",
        })
            using (var r = await Send(server, more, skipped)) Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        await admin.NoEventAsync("chat.message");
    }

    // ── Slack ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Slack_text_blocks_and_attachments_without_pings_or_images()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var path = await Hook(admin, server.General) + "/slack";

        using (var r = await Send(server, path, """{"text":"*Deploy* finished ~maybe~ <https://example.com/run/1|see run> &amp; <!channel> <@U012AB3CD>","icon_url":"https://evil.example/i.png","username":"Deploy bot"}"""))
        {
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            Assert.Equal("ok", await r.Content.ReadAsStringAsync());
        }
        var message = (await alice.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal("**Deploy** finished ~~maybe~~ [see run](https://example.com/run/1) & @‍here @U012AB3CD", message.GetProperty("text").GetString());
        Assert.Equal("Deploy bot", message.GetProperty("webhook").GetProperty("name").GetString());
        Assert.DoesNotContain("evil.example", message.GetRawText());

        // Block Kit (from Slack's docs): header, section with fields, context; images and buttons left out.
        await Send(server, path, """
            {"text":"fallback only","blocks":[
              {"type":"header","text":{"type":"plain_text","text":"New request","emoji":true}},
              {"type":"section","fields":[{"type":"mrkdwn","text":"*Type:*\nPaid Time Off"},{"type":"mrkdwn","text":"*Created by:*\n<example.com|Fred Enriquez>"}]},
              {"type":"section","text":{"type":"mrkdwn","text":"<https://example.com|View request>"},"accessory":{"type":"image","image_url":"https://evil.example/a.png","alt_text":"x"}},
              {"type":"actions","elements":[{"type":"button","text":{"type":"plain_text","text":"Approve"},"value":"click_me_123"}]},
              {"type":"context","elements":[{"type":"mrkdwn","text":"Requested today"},{"type":"image","image_url":"https://evil.example/b.png","alt_text":"x"}]}]}
            """);
        var blocks = (await alice.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal("", blocks.GetProperty("text").GetString());
        var card = blocks.GetProperty("webhook").GetProperty("embeds")[0];
        Assert.Equal("New request", card.GetProperty("title").GetString());
        Assert.Equal("**Type:**\nPaid Time Off\n**Created by:**\nFred Enriquez\n\n[View request](https://example.com)", card.GetProperty("description").GetString());
        Assert.Equal("Requested today", card.GetProperty("footer").GetProperty("text").GetString());
        Assert.DoesNotContain("evil.example", blocks.GetRawText());
        Assert.DoesNotContain("Approve", blocks.GetRawText());

        // Legacy attachments, as Alertmanager and Jenkins send them.
        await Send(server, path, """
            {"attachments":[{"fallback":"Required plain-text summary","color":"#36a64f","pretext":"Optional text above","author_name":"Bobby Tables",
              "author_icon":"https://evil.example/c.png","title":"Slack API Documentation","title_link":"https://api.slack.com/",
              "text":"Optional text in the attachment","fields":[{"title":"Priority","value":"High","short":false}],
              "image_url":"https://evil.example/d.png","footer":"Slack API","ts":123456789}]}
            """);
        var legacy = (await alice.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("webhook").GetProperty("embeds")[0];
        Assert.Equal("Slack API Documentation", legacy.GetProperty("title").GetString());
        Assert.Equal("https://api.slack.com/", legacy.GetProperty("url").GetString());
        Assert.Equal("Optional text above\n\nOptional text in the attachment", legacy.GetProperty("description").GetString());
        Assert.Equal(0x36A64F, legacy.GetProperty("color").GetInt32());
        Assert.Equal("Bobby Tables", legacy.GetProperty("author").GetProperty("name").GetString());
        Assert.Equal("Priority", legacy.GetProperty("fields")[0].GetProperty("name").GetString());
        Assert.Equal(123456789000, legacy.GetProperty("timestamp").GetInt64());
        Assert.DoesNotContain("evil.example", legacy.GetRawText());

        // Nothing to post: 400. A form post with payload= works too (Slack's other way).
        using (var r = await Send(server, path, """{"blocks":[{"type":"divider"}]}""")) Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        using (var form = await server.CreateClient().PostAsync(path, new FormUrlEncodedContent(new Dictionary<string, string> { ["payload"] = """{"text":"from a form"}""" })))
            Assert.Equal(HttpStatusCode.OK, form.StatusCode);
        Assert.Equal("from a form", (await alice.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("text").GetString());
    }

    // ── Limits and settings ──────────────────────────────────────────────────

    [Fact]
    public async Task Sizes_unknown_formats_and_who_sets_signing_secrets()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var created = (await admin.RequestAsync("webhook.create", new { channelId = server.General, name = "Dev" })).Body();
        var id = created.GetProperty("webhook").GetProperty("id").GetString()!;
        var path = created.GetProperty("path").GetString()!;
        Assert.False(created.GetProperty("webhook").GetProperty("signed").GetBoolean());

        using (var r = await Send(server, path + "/bitbucket", "{}")) Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        var big = "{\"text\":\"" + new string('a', 1024 * 1024) + "\"}";
        using (var r = await Send(server, path + "/slack", big)) Assert.Equal(HttpStatusCode.RequestEntityTooLarge, r.StatusCode);
        using (var r = await Send(server, path + "/gitlab", "[1,2]")) Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);

        // Only webhook managers set a signing secret: 16–256 visible characters, "" removes it, never shown back.
        Assert.Equal("forbidden", (await alice.RequestAsync("webhook.signing.set", new { id, secret = Secret })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("webhook.signing.set", new { id, secret = "short" })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("webhook.signing.set", new { id, secret = " leading-space-is-not-ok" })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("webhook.signing.set", new { id = "nope", secret = "0123456789abcdef" })).ErrorCode());
        var set = await admin.RequestAsync("webhook.signing.set", new { id, secret = "0123456789abcdef" });
        Assert.True(set.Body().GetProperty("webhook").GetProperty("signed").GetBoolean());
        var list = (await admin.RequestAsync("webhook.list")).GetRawText();
        Assert.DoesNotContain("0123456789abcdef", list);
        Assert.True((await admin.RequestAsync("webhook.list")).Body().GetProperty("webhooks")[0].GetProperty("signed").GetBoolean());
        Assert.False((await admin.RequestAsync("webhook.signing.set", new { id, secret = "" })).Body().GetProperty("webhook").GetProperty("signed").GetBoolean());
        Assert.Null(server.World.Store.WebhookSigningSecret(id));

        // The plain Discord format ignores the signing secret (it has none); deleting the webhook drops the secret.
        await admin.RequestAsync("webhook.signing.set", new { id, secret = "0123456789abcdef" });
        using (var r = await Send(server, path, """{"content":"plain"}""")) Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        await admin.RequestAsync("webhook.delete", new { id });
        Assert.Null(server.World.Store.WebhookSigningSecret(id));
    }
}

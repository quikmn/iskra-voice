using System.Net;
using System.Text.Json;
using Iskra.Server.Translate;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>
/// GET /models/translate/{dir}/{part}: translation models from the group's own server, for members only, each fetched
/// once and only when someone needs it, and only once the owner offers them (never from the internet here).
/// </summary>
public class TranslateModelTests
{
    private const string EnSv = "translate-ensv-test";

    private static string Url(string part, string dir = EnSv) => $"/models/translate/{dir}/{part}";

    private static async Task Offer(User owner, bool offer = true)
    {
        var config = (await owner.RequestAsync("translate.configure", new { offer })).Body();
        Assert.Equal(offer, config.GetProperty("offer").GetBoolean());
    }

    /// <summary>A member's link (translate.models.link) to a part.</summary>
    private static async Task<string> Link(User user, string part, string dir = EnSv)
    {
        var body = (await user.RequestAsync("translate.models.link")).Body();
        Assert.True(body.GetProperty("offered").GetBoolean());
        Assert.Equal("/models/translate", body.GetProperty("path").GetString());
        return $"{body.GetProperty("path").GetString()}/{dir}/{part}?{body.GetProperty("query").GetString()}";
    }

    [Fact]
    public async Task Off_until_the_owner_offers_them()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        Assert.False(server.World.Settings.Translate.Offer);

        var answer = (await member.RequestAsync("translate.models.link")).Body();
        Assert.False(answer.GetProperty("offered").GetBoolean());
        Assert.False(answer.TryGetProperty("query", out _));
        var signed = $"{Url("vocab.spm.gz.part0.bin")}?a={member.Key}&exp={DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60_000}&sig={TranslateFeature.Sign(member.Key, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60_000)}";
        using (var off = await server.CreateClient().GetAsync(signed)) Assert.Equal(HttpStatusCode.NotFound, off.StatusCode);

        // The owner turns it on: saved to server.json, in the security log, and members get links.
        await Offer(owner);
        Assert.True(server.World.Settings.Translate.Offer);
        Assert.Single(server.World.Store.SecurityEvents("translate.settings", null, null, 10));
        var on = (await member.RequestAsync("translate.models.link")).Body();
        Assert.Equal(["en-sv", "sv-en"], on.GetProperty("models").EnumerateArray().Select(m => m.GetString()));
        Assert.True(on.GetProperty("expires").GetInt64() > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

        // Turning it off again stops links already handed out.
        var link = await Link(member, "vocab.spm.gz.part0.bin");
        await Offer(owner, false);
        using (var stopped = await server.CreateClient().GetAsync(link)) Assert.Equal(HttpStatusCode.NotFound, stopped.StatusCode);
        Assert.Empty(server.Translations.Fetches);
    }

    [Fact]
    public async Task Only_the_owner_sees_and_changes_the_setting()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        foreach (var user in new[] { admin, member })
        {
            foreach (var (type, body) in new (string, object)[] { ("translate.configure", new { offer = true }), ("translate.config", new { }) })
            {
                var refused = await user.RequestAsync(type, body);
                Assert.Equal("error", refused.Type());
                Assert.Equal("forbidden", refused.Body().GetProperty("code").GetString());
            }
        }
        Assert.False(server.World.Settings.Translate.Offer);

        using var owner = await server.JoinAsync("Owner", "owner");
        var bad = await owner.RequestAsync("translate.configure", new { });
        Assert.Equal("error", bad.Type());
        var config = (await owner.RequestAsync("translate.config")).Body();
        Assert.False(config.GetProperty("offer").GetBoolean());
        Assert.Empty(config.GetProperty("downloaded").EnumerateArray());
    }

    [Fact]
    public async Task Fetches_a_model_once_when_a_member_needs_it_then_serves_it_from_the_world_folder()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        await Offer(owner);
        var http = server.CreateClient();

        // HEAD answers without fetching anything.
        using (var head = await http.SendAsync(new HttpRequestMessage(HttpMethod.Head, await Link(member, "model.bin.gz.part0.bin"))))
            Assert.Equal(HttpStatusCode.OK, head.StatusCode);
        Assert.Empty(server.Translations.Fetches);

        using var first = await http.GetAsync(await Link(member, "model.bin.gz.part1.bin"));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(FakeTranslationUpstream.Model[200..], await first.Content.ReadAsByteArrayAsync());
        Assert.Equal("*", first.Headers.GetValues("Access-Control-Allow-Origin").Single());
        Assert.Contains("immutable", first.Headers.CacheControl!.ToString());
        Assert.Equal(FakeTranslationUpstream.Model[..200], await http.GetByteArrayAsync(await Link(member, "model.bin.gz.part0.bin")));
        Assert.Equal(FakeTranslationUpstream.Vocab, await http.GetByteArrayAsync(await Link(member, "vocab.spm.gz.part0.bin")));

        // Only the model that was asked for, and only once.
        Assert.Equal(1, server.Translations.Fetches[$"{EnSv}/model.bin.gz"]);
        Assert.Equal(1, server.Translations.Fetches[$"{EnSv}/vocab.spm.gz"]);
        Assert.DoesNotContain(server.Translations.Fetches.Keys, k => k.StartsWith("translate-sven-test"));
        Assert.True(File.Exists(Path.Combine(server.WorldPath, "models", "translate", EnSv, "model.bin.gz.part1.bin")));

        var config = (await owner.RequestAsync("translate.config")).Body();
        Assert.Equal(["en-sv"], config.GetProperty("downloaded").EnumerateArray().Select(m => m.GetString()));
        var entry = server.World.Store.SecurityEvents("translate.model.download", null, null, 10).Single();
        using var details = JsonDocument.Parse(entry.Details!);
        Assert.Equal(EnSv, details.RootElement.GetProperty("model").GetString());
        Assert.Equal(FakeTranslationUpstream.Model.Length + FakeTranslationUpstream.Vocab.Length, details.RootElement.GetProperty("bytes").GetInt32());

        using var options = await http.SendAsync(new HttpRequestMessage(HttpMethod.Options, Url("vocab.spm.gz.part0.bin")));
        Assert.Equal("*", options.Headers.GetValues("Access-Control-Allow-Origin").Single());
    }

    [Fact]
    public async Task A_file_that_is_not_the_pinned_one_is_refused_and_never_kept()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        await Offer(owner);
        server.Translations.Tampered = new byte[300];
        var link = await Link(owner, "model.bin.gz.part0.bin");
        var http = server.CreateClient();
        using (var refused = await http.GetAsync(link)) Assert.Equal(HttpStatusCode.BadGateway, refused.StatusCode);
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(server.WorldPath, "models", "translate", EnSv)));
        Assert.NotEmpty(server.World.Store.SecurityEvents("translate.model.rejected", null, null, 10));
        Assert.Empty(server.World.Store.SecurityEvents("translate.model.download", null, null, 10));

        server.Translations.Tampered = null;
        Assert.Equal(FakeTranslationUpstream.Model[..200], await http.GetByteArrayAsync(link));
    }

    [Fact]
    public async Task Only_members_can_download_them_or_make_the_server_fetch_them()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        using var other = await server.JoinAsync("Other");
        await Offer(owner);
        var http = server.CreateClient();
        const string part = "vocab.spm.gz.part0.bin";
        var link = await Link(member, part);
        var query = System.Web.HttpUtility.ParseQueryString(new Uri("http://x" + link).Query);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        string Signed(string account, long exp) => $"{Url(part)}?a={account}&exp={exp}&sig={TranslateFeature.Sign(account, exp)}";

        async Task Refused(string url)
        {
            using (var get = await http.GetAsync(url)) Assert.Equal(HttpStatusCode.Forbidden, get.StatusCode);
            using (var head = await http.SendAsync(new HttpRequestMessage(HttpMethod.Head, url))) Assert.Equal(HttpStatusCode.Forbidden, head.StatusCode);
        }

        await Refused(Url(part));
        await Refused($"{Url(part)}?a={member.Key}&exp={now + 60_000}&sig=AAAA");
        await Refused($"{Url(part)}?a={other.Key}&exp={query["exp"]}&sig={query["sig"]}");
        await Refused(Signed(member.Key, now - 1000));
        await Refused(Signed(member.Key, now + 3 * 3600_000)); // further ahead than a link ever lasts
        await Refused(Signed(new string('f', 64), now + 60_000));
        // A captions link isn't a translation link.
        await Refused($"{Url(part)}?a={member.Key}&exp={now + 60_000}&sig={Iskra.Server.Captions.CaptionModelFeature.Sign(EnSv, member.Key, now + 60_000)}");
        Assert.Empty(server.Translations.Fetches);

        using (var stranger = await server.ConnectAsync())
        {
            await stranger.ReceiveAsync(); // hello
            await stranger.SendRawAsync("""{"type":"translate.models.link","id":"r1","body":{}}""");
            var error = await stranger.ReceiveAsync();
            Assert.Equal("auth_failed", error.GetProperty("body").GetProperty("code").GetString());
        }

        using (var ok = await http.GetAsync(link)) Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal("result", (await owner.RequestAsync("member.kick", new { accountKey = member.Key })).Type());
        await Refused(link);
    }

    [Theory]
    [InlineData("/models/translate/translate-ensv-test/server.key")]
    [InlineData("/models/translate/translate-ensv-test/..%2Fserver.key")]
    [InlineData("/models/translate/..%2F..%2Fserver.key/vocab.spm.gz.part0.bin")]
    [InlineData("/models/translate/translate-ende-test/vocab.spm.gz.part0.bin")]
    [InlineData("/models/translate/translate-ensv-test/vocab.spm.gz.part1.bin")]
    [InlineData("/models/translate/translate-ensv-test/vocab.spm.gz")]
    [InlineData("/models/translate/../server.key")]
    public async Task Only_the_pinned_parts_are_served(string path)
    {
        using var server = new IskraServer();
        server.World.UpdateSettings(s => s with { Translate = s.Translate with { Offer = true } });
        using var response = await server.CreateClient().GetAsync(path);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(server.Translations.Fetches);
    }

    [Fact]
    public void The_server_and_the_app_pin_the_same_models()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "client", "src", "state", "translate", "models.json"))) dir = dir.Parent;
        Assert.NotNull(dir);
        using var client = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir!.FullName, "client", "src", "state", "translate", "models.json")));
        var models = client.RootElement.GetProperty("models").EnumerateArray().ToArray();
        var pinned = TranslationPins.Pinned.Models;
        Assert.Equal(models.Length, pinned.Length);
        Assert.Equal(pinned.Length, pinned.Select(m => m.Dir).Distinct().Count());
        for (var i = 0; i < models.Length; i++)
        {
            Assert.Equal(models[i].GetProperty("dir").GetString(), pinned[i].Dir);
            Assert.Equal($"{pinned[i].From}-{pinned[i].To}", pinned[i].Name);
            Assert.True(pinned[i].From == "en" || pinned[i].To == "en");
            Assert.StartsWith("https://storage.googleapis.com/moz-fx-translations-data", pinned[i].Source);
            Assert.StartsWith("translate-", pinned[i].Dir);
            Assert.Equal(3, pinned[i].Files.Length);
            foreach (var file in pinned[i].Files)
            {
                Assert.Equal(file.Bytes, file.Parts.Sum(p => p.Bytes));
                Assert.All(file.Parts, p => Assert.InRange(p.Bytes, 1, 20 * 1024 * 1024));
                Assert.Matches("^[0-9a-f]{64}$", file.Sha256);
                Assert.StartsWith($"models/{pinned[i].Name}/", file.From); // the pinned training run's own folder
            }
        }
        // Every language both ways.
        var languages = pinned.Select(m => m.From == "en" ? m.To : m.From).Distinct().ToArray();
        Assert.All(languages, l => Assert.Contains(pinned, m => m.Name == $"{l}-en"));
        Assert.All(languages, l => Assert.Contains(pinned, m => m.Name == $"en-{l}"));
    }
}

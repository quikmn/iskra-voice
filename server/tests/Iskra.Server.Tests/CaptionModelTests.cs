using System.Net;
using System.Text.Json;
using Iskra.Server.Captions;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>GET /models/{dir}/{part}: the captions model from the group's own server, for members only, fetched once (never from the internet here).</summary>
public class CaptionModelTests
{
    private static string Url(IskraServer server, string part, string? dir = null) => $"/models/{dir ?? server.Models.Manifest.Dir}/{part}";

    /// <summary>A member's link (captions.model.link) to a part.</summary>
    private static async Task<string> Link(IskraServer server, User user, string part)
    {
        var body = (await user.RequestAsync("captions.model.link")).Body();
        Assert.True(body.GetProperty("offered").GetBoolean());
        Assert.Equal($"/models/{server.Models.Manifest.Dir}", body.GetProperty("path").GetString());
        return $"{body.GetProperty("path").GetString()}/{part}?{body.GetProperty("query").GetString()}";
    }

    [Fact]
    public async Task Fetches_once_checks_every_byte_then_serves_from_the_world_folder()
    {
        using var server = new IskraServer();
        using var member = await server.JoinAsync("Member");
        var http = server.CreateClient();

        // HEAD says captions are offered, without fetching anything.
        using (var head = await http.SendAsync(new HttpRequestMessage(HttpMethod.Head, await Link(server, member, "vocab.json.part0.bin"))))
            Assert.Equal(HttpStatusCode.OK, head.StatusCode);
        Assert.Empty(server.Models.Fetches);

        using var first = await http.GetAsync(await Link(server, member, "encoder.q8.onnx.part1.bin"));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(FakeModelUpstream.Encoder[200..], await first.Content.ReadAsByteArrayAsync());
        Assert.Equal("*", first.Headers.GetValues("Access-Control-Allow-Origin").Single());
        Assert.Contains("immutable", first.Headers.CacheControl!.ToString());
        Assert.True(first.Headers.CacheControl!.Private);
        Assert.Equal("application/octet-stream", first.Content.Headers.ContentType!.MediaType);

        Assert.Equal(FakeModelUpstream.Encoder[..200], await http.GetByteArrayAsync(await Link(server, member, "encoder.q8.onnx.part0.bin")));
        Assert.Equal(FakeModelUpstream.Vocab, await http.GetByteArrayAsync(await Link(server, member, "vocab.json.part0.bin")));
        Assert.Equal(1, server.Models.Fetches["encoder.q8.onnx"]);
        Assert.Equal(1, server.Models.Fetches["vocab.json"]);
        Assert.True(File.Exists(Path.Combine(server.WorldPath, "models", "test-model-1234", "encoder.q8.onnx.part1.bin")));

        // The owner sees that the server downloaded it (no secrets: what and how much).
        var entry = server.World.Store.SecurityEvents("captions.model.download", null, null, 10).Single();
        using var details = JsonDocument.Parse(entry.Details!);
        Assert.Equal("test-model-1234", details.RootElement.GetProperty("model").GetString());
        Assert.Equal(FakeModelUpstream.Encoder.Length + FakeModelUpstream.Vocab.Length, details.RootElement.GetProperty("bytes").GetInt32());

        // CORS preflight for the apps' pages.
        using var options = await http.SendAsync(new HttpRequestMessage(HttpMethod.Options, Url(server, "vocab.json.part0.bin")));
        Assert.Equal("*", options.Headers.GetValues("Access-Control-Allow-Origin").Single());
    }

    [Fact]
    public async Task Requests_at_the_same_time_share_one_download()
    {
        using var server = new IskraServer();
        server.Models.Gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var member = await server.JoinAsync("Member");
        var http = server.CreateClient();
        string[] parts = ["encoder.q8.onnx.part0.bin", "encoder.q8.onnx.part1.bin", "vocab.json.part0.bin", "encoder.q8.onnx.part0.bin", "vocab.json.part0.bin"];
        var links = new List<string>();
        foreach (var p in parts) links.Add(await Link(server, member, p));
        var requests = links.Select(l => http.GetAsync(l)).ToArray();
        await Task.Delay(300);
        server.Models.Gate.SetResult();
        foreach (var response in await Task.WhenAll(requests))
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            response.Dispose();
        }
        Assert.Equal(1, server.Models.Fetches["encoder.q8.onnx"]);
        Assert.Equal(1, server.Models.Fetches["vocab.json"]);
    }

    [Fact]
    public async Task A_file_that_is_not_the_pinned_one_is_refused_and_never_kept()
    {
        using var server = new IskraServer();
        server.Models.Tampered = new byte[300];
        using var member = await server.JoinAsync("Member");
        var http = server.CreateClient();
        var link = await Link(server, member, "encoder.q8.onnx.part0.bin");
        using (var refused = await http.GetAsync(link))
            Assert.Equal(HttpStatusCode.BadGateway, refused.StatusCode);
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(server.WorldPath, "models", "test-model-1234")));
        Assert.NotEmpty(server.World.Store.SecurityEvents("captions.model.rejected", null, null, 10));
        Assert.Empty(server.World.Store.SecurityEvents("captions.model.download", null, null, 10));

        // Upstream down: the same answer. Once it's right again, the next request fetches it.
        server.Models.Tampered = null;
        server.Models.Fail = true;
        using (var down = await http.GetAsync(link))
            Assert.Equal(HttpStatusCode.BadGateway, down.StatusCode);
        server.Models.Fail = false;
        Assert.Equal(FakeModelUpstream.Encoder[..200], await http.GetByteArrayAsync(link));
    }

    [Fact]
    public async Task Off_in_server_json_means_not_offered()
    {
        using var server = new IskraServer();
        using var member = await server.JoinAsync("Member");
        var link = await Link(server, member, "vocab.json.part0.bin");
        server.World.UpdateSettings(s => s with { Captions = s.Captions with { ModelDownload = false } });
        var answer = (await member.RequestAsync("captions.model.link")).Body();
        Assert.False(answer.GetProperty("offered").GetBoolean());
        Assert.False(answer.TryGetProperty("query", out _));
        var http = server.CreateClient();
        using (var linked = await http.GetAsync(link))
            Assert.Equal(HttpStatusCode.NotFound, linked.StatusCode);
        using (var get = await http.GetAsync(Url(server, "vocab.json.part0.bin")))
            Assert.Equal(HttpStatusCode.NotFound, get.StatusCode);
        using (var head = await http.SendAsync(new HttpRequestMessage(HttpMethod.Head, Url(server, "vocab.json.part0.bin"))))
            Assert.Equal(HttpStatusCode.NotFound, head.StatusCode);
        Assert.Empty(server.Models.Fetches);
    }

    [Fact]
    public async Task Only_members_can_download_it_or_make_the_server_fetch_it()
    {
        using var server = new IskraServer();
        using var member = await server.JoinAsync("Member");
        using var other = await server.JoinAsync("Other");
        using var owner = await server.JoinAsync("Owner", "owner");
        var http = server.CreateClient();
        var dir = server.Models.Manifest.Dir;
        const string part = "vocab.json.part0.bin";
        var link = await Link(server, member, part);
        var query = System.Web.HttpUtility.ParseQueryString(new Uri("http://x" + link).Query);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        string Signed(string forDir, string account, long exp) =>
            $"{Url(server, part)}?a={account}&exp={exp}&sig={Iskra.Server.Captions.CaptionModelFeature.Sign(forDir, account, exp)}";

        async Task Refused(string url)
        {
            using (var get = await http.GetAsync(url)) Assert.Equal(HttpStatusCode.Forbidden, get.StatusCode);
            using (var head = await http.SendAsync(new HttpRequestMessage(HttpMethod.Head, url))) Assert.Equal(HttpStatusCode.Forbidden, head.StatusCode);
        }

        // Anonymous: no link, a made-up one, someone else's name on a member's link, one that ran out, one for another model.
        await Refused(Url(server, part));
        await Refused($"{Url(server, part)}?a={member.Key}&exp={now + 60_000}&sig=AAAA");
        await Refused($"{Url(server, part)}?a={other.Key}&exp={query["exp"]}&sig={query["sig"]}");
        await Refused(Signed(dir, member.Key, now - 1000));
        await Refused(Signed("other-model", member.Key, now + 60_000));
        // Signed for someone who isn't a member.
        await Refused(Signed(dir, new string('f', 64), now + 60_000));
        Assert.Empty(server.Models.Fetches); // none of them made the server fetch anything

        // A connection that hasn't signed in can't ask for a link.
        using (var stranger = await server.ConnectAsync())
        {
            await stranger.ReceiveAsync(); // hello
            await stranger.SendRawAsync("""{"type":"captions.model.link","id":"r1","body":{}}""");
            var error = await stranger.ReceiveAsync();
            Assert.Equal("auth_failed", error.GetProperty("body").GetProperty("code").GetString());
        }

        // A member's link works.
        using (var ok = await http.GetAsync(link)) Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal(1, server.Models.Fetches["vocab.json"]);

        // Removed from the server: their link stops working at once.
        Assert.Equal("result", (await owner.RequestAsync("member.kick", new { accountKey = member.Key })).Type());
        await Refused(link);
    }

    [Theory]
    [InlineData("/models/test-model-1234/server.key")]
    [InlineData("/models/test-model-1234/..%2Fserver.key")]
    [InlineData("/models/..%2F..%2Fserver.key/vocab.json.part0.bin")]
    [InlineData("/models/test-model-0000/vocab.json.part0.bin")]
    [InlineData("/models/test-model-1234/vocab.json.part1.bin")]
    [InlineData("/models/test-model-1234/vocab.json")]
    [InlineData("/models/../server.key")]
    public async Task Only_the_pinned_parts_are_served(string path)
    {
        using var server = new IskraServer();
        using var response = await server.CreateClient().GetAsync(path);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(server.Models.Fetches);
    }

    [Fact]
    public async Task Each_address_is_rate_limited()
    {
        using var server = new IskraServer();
        using var member = await server.JoinAsync("Member");
        var link = await Link(server, member, "vocab.json.part0.bin");
        var http = server.CreateClient();
        var codes = new List<HttpStatusCode>();
        for (var i = 0; i < 40; i++)
        {
            using var response = await http.GetAsync(link);
            codes.Add(response.StatusCode);
        }
        Assert.Equal(30, codes.Count(c => c == HttpStatusCode.OK));
        Assert.Contains(HttpStatusCode.TooManyRequests, codes);
    }

    [Fact]
    public void The_server_and_the_app_pin_the_same_model()
    {
        // The server compiles in client/src/state/captions/model.json: one file, read the same by both.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "client", "src", "state", "captions", "model.json"))) dir = dir.Parent;
        Assert.NotNull(dir);
        using var client = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir!.FullName, "client", "src", "state", "captions", "model.json")));
        var pinned = ModelManifest.Pinned;
        Assert.Equal(client.RootElement.GetProperty("dir").GetString(), pinned.Dir);
        Assert.Equal(client.RootElement.GetProperty("source").GetString(), pinned.Source);
        var files = client.RootElement.GetProperty("files").EnumerateArray().ToArray();
        Assert.Equal(files.Length, pinned.Files.Length);
        for (var i = 0; i < files.Length; i++)
        {
            Assert.Equal(files[i].GetProperty("sha256").GetString(), pinned.Files[i].Sha256);
            Assert.Equal(files[i].GetProperty("parts").EnumerateArray().Select(p => p.GetProperty("sha256").GetString()), pinned.Files[i].Parts.Select(p => p.Sha256));
            Assert.Equal(pinned.Files[i].Bytes, pinned.Files[i].Parts.Sum(p => p.Bytes));
            Assert.All(pinned.Files[i].Parts, p => Assert.InRange(p.Bytes, 1, 20 * 1024 * 1024));
        }
        Assert.StartsWith("https://huggingface.co/", pinned.Source);
        Assert.Contains(pinned.Source.Split('/').Last()[..8], pinned.Dir);
    }
}

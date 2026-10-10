using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class LinkTests
{
    private static string Random32() => Ed25519.ToB64u(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));

    private static object NewDeviceRequest(string info = "Safari on iPhone") => new { epk = Random32(), mac = Random32(), info };

    private static async Task<(string Token, string PutKey)> CreateAsync(User user)
    {
        var body = (await user.RequestAsync("link.create")).Body();
        return (body.GetProperty("token").GetString()!, body.GetProperty("putKey").GetString()!);
    }

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    [Fact]
    public async Task A_new_device_and_an_existing_one_exchange_keys_and_a_payload_through_the_relay()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var http = server.CreateClient();
        var (token, putKey) = await CreateAsync(alice);

        // New device: announce its key, no account needed.
        var request = new { epk = Random32(), mac = Random32(), info = "Safari on iPhone" };
        using var posted = await http.PostAsJsonAsync($"/link/{token}", request);
        Assert.Equal("*", posted.Headers.GetValues("Access-Control-Allow-Origin").Single());
        var readKey = (await JsonAsync(posted)).GetProperty("key").GetString();

        // Existing device hears about it.
        var heard = (await alice.EventAsync("link.request")).Body();
        Assert.Equal(token, heard.GetProperty("token").GetString());
        Assert.Equal(request.epk, heard.GetProperty("epk").GetString());
        Assert.Equal("Safari on iPhone", heard.GetProperty("info").GetString());

        Assert.Equal("waiting", (await JsonAsync(await http.GetAsync($"/link/{token}?key={readKey}"))).GetProperty("state").GetString());

        var answer = new { token, epk = Random32(), mac = Random32() };
        Assert.Null((await alice.RequestAsync("link.respond", answer)).ErrorCode());
        var answered = await JsonAsync(await http.GetAsync($"/link/{token}?key={readKey}"));
        Assert.Equal("answered", answered.GetProperty("state").GetString());
        Assert.Equal(answer.epk, answered.GetProperty("epk").GetString());

        var payload = System.Security.Cryptography.RandomNumberGenerator.GetBytes(100_000);
        using (var put = await http.PutAsync($"/link/{token}?key={putKey}", new ByteArrayContent(payload)))
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var done = await JsonAsync(await http.GetAsync($"/link/{token}?key={readKey}"));
        Assert.Equal("done", done.GetProperty("state").GetString());
        Assert.Equal(payload, System.Buffers.Text.Base64Url.DecodeFromChars(done.GetProperty("payload").GetString()));

        // Handed out once, then gone.
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/link/{token}?key={readKey}")).StatusCode);
    }

    [Fact]
    public async Task The_relay_enforces_sizes_keys_and_order()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var mallory = await server.JoinAsync("Mallory");
        using var http = server.CreateClient();
        var (token, putKey) = await CreateAsync(alice);

        Assert.Equal(HttpStatusCode.NotFound, (await http.PostAsJsonAsync("/link/not-a-token", NewDeviceRequest())).StatusCode);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge,
            (await http.PostAsJsonAsync($"/link/{token}", new { epk = Random32(), mac = Random32(), info = new string('x', 2000) })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await http.PostAsJsonAsync($"/link/{token}", new { epk = "short", mac = Random32() })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await http.PostAsync($"/link/{token}", new StringContent("not json"))).StatusCode);
        // Nobody can poll before a device has asked (there's no read key yet).
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/link/{token}?key=x")).StatusCode);

        using var first = await http.PostAsJsonAsync($"/link/{token}", NewDeviceRequest());
        var readKey = (await JsonAsync(first)).GetProperty("key").GetString();
        // Only one device per link.
        Assert.Equal(HttpStatusCode.Conflict, (await http.PostAsJsonAsync($"/link/{token}", NewDeviceRequest())).StatusCode);
        // Polling needs the read key the new device got.
        Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync($"/link/{token}?key=wrong")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync($"/link/{token}")).StatusCode);

        // The payload can't come before the answer, or from someone without the put key.
        Assert.Equal(HttpStatusCode.Conflict, (await http.PutAsync($"/link/{token}?key={putKey}", new ByteArrayContent([1, 2, 3]))).StatusCode);
        // Another account can't answer.
        Assert.Equal("not_found", (await mallory.RequestAsync("link.respond", new { token, epk = Random32(), mac = Random32() })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("link.respond", new { token, epk = "x", mac = Random32() })).ErrorCode());
        Assert.Null((await alice.RequestAsync("link.respond", new { token, epk = Random32(), mac = Random32() })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("link.respond", new { token, epk = Random32(), mac = Random32() })).ErrorCode());

        Assert.Equal(HttpStatusCode.Forbidden, (await http.PutAsync($"/link/{token}?key=wrong", new ByteArrayContent([1, 2, 3]))).StatusCode);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge,
            (await http.PutAsync($"/link/{token}?key={putKey}", new ByteArrayContent(new byte[1024 * 1024 + 1]))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await http.PutAsync($"/link/{token}?key={putKey}", new ByteArrayContent([1, 2, 3]))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await http.PutAsync($"/link/{token}?key={putKey}", new ByteArrayContent([4]))).StatusCode);
    }

    [Fact]
    public async Task A_payload_is_only_read_after_token_key_and_state_check_out()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var http = server.CreateClient();
        var (token, putKey) = await CreateAsync(alice);
        var big = new ByteArrayContent(new byte[2 * 1024 * 1024]);

        // Wrong key or no device waiting yet: refused before the (oversized) body is looked at.
        using (var wrong = await http.PutAsync($"/link/{token}?key={Random32()}", big)) Assert.Equal(HttpStatusCode.Forbidden, wrong.StatusCode);
        using (var early = await http.PutAsync($"/link/{token}?key={putKey}", new ByteArrayContent([1]))) Assert.Equal(HttpStatusCode.Conflict, early.StatusCode);
        using (var unknown = await http.PutAsync($"/link/{Random32()}?key={putKey}", big)) Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
    }

    [Fact]
    public async Task The_relay_is_rate_limited_per_address()
    {
        using var server = new IskraServer();
        using var http = server.CreateClient();
        var codes = new List<HttpStatusCode>();
        for (var i = 0; i < 70; i++)
        {
            using var response = await http.GetAsync($"/link/{Random32()}?key=x");
            codes.Add(response.StatusCode);
        }
        Assert.Equal(HttpStatusCode.NotFound, codes[0]);
        Assert.Contains(HttpStatusCode.TooManyRequests, codes);
    }

    [Fact]
    public async Task Links_expire()
    {
        using var server = new IskraServer { Settings = { ["Link:TtlMs"] = "400" } };
        using var alice = await server.JoinAsync("Alice");
        using var http = server.CreateClient();
        var (token, _) = await CreateAsync(alice);
        using var posted = await http.PostAsJsonAsync($"/link/{token}", NewDeviceRequest());
        var readKey = (await JsonAsync(posted)).GetProperty("key").GetString();

        await Task.Delay(600, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/link/{token}?key={readKey}")).StatusCode);
        Assert.Equal("not_found", (await alice.RequestAsync("link.respond", new { token, epk = Random32(), mac = Random32() })).ErrorCode());
    }

    [Fact]
    public async Task Links_are_limited_per_account_and_can_be_cancelled()
    {
        using var server = new IskraServer { Settings = { ["Link:MaxActivePerAccount"] = "1" } };
        using var alice = await server.JoinAsync("Alice");
        using var http = server.CreateClient();

        var (token, _) = await CreateAsync(alice);
        var refused = await alice.RequestAsync("link.create");
        Assert.Equal("rate_limited", refused.ErrorCode());
        Assert.Contains("in progress", refused.Body().GetProperty("message").GetString());

        Assert.Null((await alice.RequestAsync("link.cancel", new { token })).ErrorCode());
        Assert.Equal(HttpStatusCode.NotFound, (await http.PostAsJsonAsync($"/link/{token}", NewDeviceRequest())).StatusCode);
        Assert.Null((await alice.RequestAsync("link.create")).ErrorCode()); // the slot is free again
    }

    [Fact]
    public async Task Polling_is_capped()
    {
        using var server = new IskraServer { Settings = { ["Link:MaxPolls"] = "5" } };
        using var alice = await server.JoinAsync("Alice");
        using var http = server.CreateClient();
        var (token, _) = await CreateAsync(alice);
        using var posted = await http.PostAsJsonAsync($"/link/{token}", NewDeviceRequest());
        var readKey = (await JsonAsync(posted)).GetProperty("key").GetString();

        for (var i = 0; i < 5; i++) Assert.Equal(HttpStatusCode.OK, (await http.GetAsync($"/link/{token}?key={readKey}")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await http.GetAsync($"/link/{token}?key={readKey}")).StatusCode);
    }
}

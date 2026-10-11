using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>History parts: after the account payload, a link carries more sealed parts, in order and a few at a time.</summary>
public class LinkHistoryTests
{
    private static string Random32() => Ed25519.ToB64u(RandomNumberGenerator.GetBytes(32));

    private static async Task<(HttpClient Http, string Token, string PutKey, string ReadKey)> AnsweredLinkAsync(IskraServer server, User user)
    {
        var http = server.CreateClient();
        var created = (await user.RequestAsync("link.create")).Body();
        var token = created.GetProperty("token").GetString()!;
        var putKey = created.GetProperty("putKey").GetString()!;
        using var posted = await http.PostAsJsonAsync($"/link/{token}", new { epk = Random32(), mac = Random32(), info = "Phone" });
        var readKey = JsonDocument.Parse(await posted.Content.ReadAsStringAsync()).RootElement.GetProperty("key").GetString()!;
        await user.RequestAsync("link.respond", new { token, epk = Random32(), mac = Random32() });
        return (http, token, putKey, readKey);
    }

    [Fact]
    public async Task Parts_follow_the_payload_in_order_and_each_is_handed_out_once()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var (http, token, putKey, readKey) = await AnsweredLinkAsync(server, alice);
        using var _ = http;

        Assert.Equal(HttpStatusCode.BadRequest, (await http.PutAsync($"/link/{token}?key={putKey}&parts=9999", new ByteArrayContent([1]))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await http.PutAsync($"/link/{token}?key={putKey}&parts=3", new ByteArrayContent([1, 2, 3]))).StatusCode);
        // Parts can't be taken before the payload.
        Assert.Equal(HttpStatusCode.Conflict, (await http.GetAsync($"/link/{token}/part/0?key={readKey}")).StatusCode);
        var done = JsonDocument.Parse(await (await http.GetAsync($"/link/{token}?key={readKey}")).Content.ReadAsStringAsync()).RootElement;
        Assert.Equal(3, done.GetProperty("parts").GetInt32());
        // The payload was handed out once; the link lives on for the parts.
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/link/{token}?key={readKey}")).StatusCode);

        var parts = Enumerable.Range(0, 3).Select(_ => RandomNumberGenerator.GetBytes(50_000)).ToArray();
        // Out of order, or without the put key: refused.
        Assert.Equal(HttpStatusCode.Conflict, (await http.PutAsync($"/link/{token}/part/1?key={putKey}", new ByteArrayContent(parts[1]))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await http.PutAsync($"/link/{token}/part/0?key={readKey}", new ByteArrayContent(parts[0]))).StatusCode);

        // The new device waits for part 0 while it's on its way.
        var waiting = http.GetAsync($"/link/{token}/part/0?key={readKey}");
        await Task.Delay(100);
        Assert.False(waiting.IsCompleted);
        Assert.Equal(HttpStatusCode.OK, (await http.PutAsync($"/link/{token}/part/0?key={putKey}", new ByteArrayContent(parts[0]))).StatusCode);
        using (var first = await waiting)
        {
            Assert.Equal(HttpStatusCode.OK, first.StatusCode);
            Assert.Equal(parts[0], await first.Content.ReadAsByteArrayAsync());
        }
        Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync($"/link/{token}/part/1?key={putKey}")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await http.GetAsync($"/link/{token}/part/0?key={readKey}")).StatusCode); // once only

        for (var i = 1; i < 3; i++)
            Assert.Equal(HttpStatusCode.OK, (await http.PutAsync($"/link/{token}/part/{i}?key={putKey}", new ByteArrayContent(parts[i]))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await http.PutAsync($"/link/{token}/part/3?key={putKey}", new ByteArrayContent([1]))).StatusCode);
        for (var i = 1; i < 3; i++)
            Assert.Equal(parts[i], await (await http.GetAsync($"/link/{token}/part/{i}?key={readKey}")).Content.ReadAsByteArrayAsync());
        // All taken: the link is gone.
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/link/{token}/part/3?key={readKey}")).StatusCode);
    }

    [Fact]
    public async Task Only_a_few_parts_wait_in_memory_and_a_slow_reader_gets_204()
    {
        using var server = new IskraServer { Settings = { ["Link:MaxBufferedParts"] = "2", ["Link:PartWaitMs"] = "200" } };
        using var alice = await server.JoinAsync("Alice");
        var (http, token, putKey, readKey) = await AnsweredLinkAsync(server, alice);
        using var _ = http;
        await http.PutAsync($"/link/{token}?key={putKey}&parts=5", new ByteArrayContent([1]));
        await http.GetAsync($"/link/{token}?key={readKey}");

        Assert.Equal(HttpStatusCode.NoContent, (await http.GetAsync($"/link/{token}/part/0?key={readKey}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await http.PutAsync($"/link/{token}/part/0?key={putKey}", new ByteArrayContent([0]))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await http.PutAsync($"/link/{token}/part/1?key={putKey}", new ByteArrayContent([1]))).StatusCode);
        // Two are waiting: the sender has to wait for the reader.
        Assert.Equal(HttpStatusCode.TooManyRequests, (await http.PutAsync($"/link/{token}/part/2?key={putKey}", new ByteArrayContent([2]))).StatusCode);
        await http.GetAsync($"/link/{token}/part/0?key={readKey}");
        Assert.Equal(HttpStatusCode.OK, (await http.PutAsync($"/link/{token}/part/2?key={putKey}", new ByteArrayContent([2]))).StatusCode);

        // Cancelling drops the link and whatever was waiting.
        await alice.RequestAsync("link.cancel", new { token });
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/link/{token}/part/1?key={readKey}")).StatusCode);
    }
}

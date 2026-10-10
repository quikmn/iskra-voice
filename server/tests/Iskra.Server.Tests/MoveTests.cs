using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class MoveTests
{
    private static MoveNotice Notice(JsonElement n) =>
        new(n.GetProperty("serverKey").GetString()!, n.GetProperty("url").GetString()!, n.GetProperty("movedAt").GetInt64(), n.GetProperty("sig").GetString()!);

    [Fact]
    public async Task Owner_publishes_a_signed_move_notice_and_the_old_copy_stops_taking_messages()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        Assert.Equal("forbidden", (await admin.RequestAsync("server.move", new { url = "https://new.example.com" })).ErrorCode());
        foreach (var bad in new[] { "ftp://x.example.com", "https://user:pw@x.example.com", "not a url", "https://x.example.com/?a=1", "http://localhost" })
            Assert.Equal("bad_request", (await owner.RequestAsync("server.move", new { url = bad })).ErrorCode());

        var result = await owner.RequestAsync("server.move", new { url = "https://new.example.com/" });
        Assert.Equal("result", result.Type());
        var evt = Notice((await member.EventAsync("server.moved")).Body().GetProperty("notice"));
        Assert.Equal("https://new.example.com", evt.Url);
        Assert.True(MoveFeature.Verify(evt, server.World.ServerPublicKey));
        Assert.False(MoveFeature.Verify(evt with { Url = "https://evil.example.com" }, server.World.ServerPublicKey));
        Assert.False(MoveFeature.Verify(evt, Ed25519.PublicKeyOf(Ed25519.KeyFromSeed(Ed25519.NewSeed()))));

        // The old copy refuses ordinary requests now.
        var refused = await member.RequestAsync("chat.send", new { channelId = server.General, text = "hello?" });
        Assert.Equal("moved", refused.ErrorCode());
        Assert.Equal("result", (await member.RequestAsync("ping")).Type());

        // New connections see it in welcome, and anyone can fetch it over HTTP.
        using var later = await server.ConnectAsync();
        var welcome = await later.LoginAsync(member.Identity, "Member");
        Assert.Equal("https://new.example.com", welcome.Body().GetProperty("server").GetProperty("moved").GetProperty("url").GetString());
        using var response = await server.CreateClient().GetAsync("/.well-known/iskra-moved");
        Assert.True(response.IsSuccessStatusCode);
        Assert.Equal("*", response.Headers.GetValues("Access-Control-Allow-Origin").Single());
        var fetched = Notice(JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement);
        Assert.True(MoveFeature.Verify(fetched, server.World.ServerPublicKey));

        // A restart keeps it; a tampered file is ignored.
        var path = Path.Combine(server.World.Path, MoveFeature.FileName);
        server.World.Moved = null;
        MoveFeature.Load(server.World);
        Assert.Equal("https://new.example.com", server.World.Moved?.Url);
        File.WriteAllText(path, File.ReadAllText(path).Replace("new.example.com", "evil.example.com"));
        server.World.Moved = null;
        MoveFeature.Load(server.World);
        Assert.Null(server.World.Moved);
        server.World.Moved = evt;

        // Cancelling takes it down.
        Assert.Equal("forbidden", (await admin.RequestAsync("server.move.cancel")).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("server.move.cancel")).Type());
        Assert.Equal(JsonValueKind.Null, (await member.EventAsync("server.moved")).Body().GetProperty("notice").ValueKind);
        Assert.Equal("result", (await member.RequestAsync("chat.send", new { channelId = server.General, text = "back" })).Type());
        Assert.Equal(System.Net.HttpStatusCode.NotFound, (await server.CreateClient().GetAsync("/.well-known/iskra-moved")).StatusCode);
    }
}

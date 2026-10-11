using System.Text.Json.Nodes;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class LimitsTests
{
    [Fact]
    public async Task Limits_are_high_by_default_and_the_owner_changes_them_live()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");

        var limits = (await member.RequestAsync("limits.get")).Body();
        Assert.Equal(512, limits.GetProperty("maxUploadMb").GetInt32());
        Assert.Equal(0, limits.GetProperty("soundMaxSeconds").GetInt32());
        Assert.Equal(0, limits.GetProperty("soundMaxMb").GetInt32());

        Assert.Equal("forbidden", (await member.RequestAsync("limits.update", new { maxUploadMb = 1 })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("limits.update", new { maxUploadMb = 0 })).ErrorCode());

        var updated = (await owner.RequestAsync("limits.update", new { maxUploadMb = 2048, soundMaxSeconds = 10 })).Body();
        Assert.Equal(2048, updated.GetProperty("maxUploadMb").GetInt32());
        Assert.Equal(10, updated.GetProperty("soundMaxSeconds").GetInt32());
        Assert.Equal(2048, server.World.Settings.MaxUploadMb);

        // Saved to server.json, alongside everything else in it.
        var json = JsonNode.Parse(File.ReadAllText(Path.Combine(server.WorldPath, "server.json")))!;
        Assert.Equal(2048, json["MaxUploadMb"]!.GetValue<int>());
        Assert.Equal(10, json["Limits"]!["SoundMaxSeconds"]!.GetValue<int>());
    }

    [Fact]
    public async Task Sound_limits_apply_only_when_set()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");

        Assert.Equal("result", (await AddSound(server, owner, SoundboardTests.Wav(30_000), "long")).Type());
        await owner.RequestAsync("limits.update", new { soundMaxSeconds = 10 });
        Assert.Equal("bad_request", (await AddSound(server, owner, SoundboardTests.Wav(30_000), "long2")).ErrorCode());
        Assert.Equal("result", (await AddSound(server, owner, SoundboardTests.Wav(9_000), "short")).Type());
    }

    private static async Task<System.Text.Json.JsonElement> AddSound(IskraServer server, User user, byte[] audio, string name) =>
        await user.RequestAsync("sound.create", new { name, fileId = await EmojiTests.Upload(server, user, audio, name + ".wav") });
}

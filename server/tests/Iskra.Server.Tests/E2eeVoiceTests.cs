using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>End-to-end encrypted voice channels: only people holding the channel's key get into the room.</summary>
public class E2eeVoiceTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static void Webhook(IskraServer server, string type, long channel, string identity)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new { @event = type, room = new { name = $"voice-{channel}" }, participant = new { identity } }));
        server.Services.GetRequiredService<VoiceRegistry>().HandleWebhook(doc.RootElement, Now);
    }

    private static string? Key(JsonElement reply) =>
        reply.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    [Fact]
    public async Task Only_people_in_the_chain_join_and_the_token_is_the_usual_one()
    {
        using var t = await E2eeChannelTests.CreateAsync("voice");
        // Members of the chain join as in any voice channel (the key is theirs; LiveKit tokens don't change).
        var joined = await t.Bob.RequestAsync("voice.join", new { channelId = t.ChannelId });
        Assert.Equal("result", joined.Type());
        Assert.Equal($"voice-{t.ChannelId}", joined.Body().GetProperty("room").GetString());
        Assert.True(joined.Body().GetProperty("canSpeak").GetBoolean());
        // Whispers aren't encrypted, so they're never offered here.
        Assert.False(joined.Body().GetProperty("whisper").GetBoolean());

        // Erin can read the channel but isn't in its encryption yet: told why, no token.
        using var erin = await t.Server.JoinAsync("Erin", "trusted");
        var waiting = await erin.RequestAsync("voice.join", new { channelId = t.ChannelId });
        Assert.Equal("bad_request", waiting.ErrorCode());
        Assert.Equal("e2ee_voice_waiting", Key(waiting));
        // A LiveKit join without the key (an old or borrowed token) is removed.
        Webhook(t.Server, "participant_joined", t.ChannelId, erin.Key);
        Assert.Contains(($"voice-{t.ChannelId}", erin.Key), t.Server.Voice.Removed);
        Assert.Null(t.Server.Services.GetRequiredService<VoiceRegistry>().ChannelOfMember(erin.Key));

        // Once a member adds her (a new epoch), she joins.
        var (add, _) = E2eeChannelTests.Change(t.Owner, t.Chain, 2, t.Head, "add", [erin.Key], [t.Owner.Key, t.Bob.Key, t.Carol.Key, erin.Key]);
        Assert.Equal("result", (await t.Owner.RequestAsync("echan.change", new
        {
            channelId = t.ChannelId, change = add, keys = new[] { E2eeChannelTests.KeyEnvelope(t.Owner, t.Chain, 2, t.Owner, t.Bob, t.Carol, erin) },
        })).Type());
        Assert.Equal("result", (await erin.RequestAsync("voice.join", new { channelId = t.ChannelId })).Type());
        Webhook(t.Server, "participant_joined", t.ChannelId, erin.Key);
        Assert.Equal(t.ChannelId, t.Server.Services.GetRequiredService<VoiceRegistry>().ChannelOfMember(erin.Key));
    }

    [Fact]
    public async Task A_full_chain_says_so()
    {
        using var t = await E2eeChannelTests.CreateAsync("voice");
        var members = new[] { t.Owner.Key, t.Bob.Key, t.Carol.Key }.Concat(Enumerable.Range(0, E2eeChannelFeature.MaxMembers - 3).Select(i => $"someone-{i}")).ToArray();
        t.Server.World.Store.SaveE2eeChange(new E2eeChannel(t.ChannelId, t.Chain, 2, "h2", members, Now), new E2eeChange(2, "p", "s", t.Owner.Key, Now), [], fresh: false);
        using var erin = await t.Server.JoinAsync("Erin", "trusted");
        var full = await erin.RequestAsync("voice.join", new { channelId = t.ChannelId });
        Assert.Equal("e2ee_voice_full", Key(full));
        Assert.Equal(E2eeChannelFeature.MaxMembers, full.Body().GetProperty("args").GetProperty("max").GetInt32());
    }

    [Fact]
    public async Task Losing_access_takes_people_out_and_a_chain_change_rechecks_the_room()
    {
        using var t = await E2eeChannelTests.CreateAsync("voice");
        var registry = t.Server.Services.GetRequiredService<VoiceRegistry>();
        foreach (var u in new[] { t.Owner, t.Bob, t.Carol })
        {
            Assert.Equal("result", (await u.RequestAsync("voice.join", new { channelId = t.ChannelId })).Type());
            Webhook(t.Server, "participant_joined", t.ChannelId, u.Key);
        }
        Assert.Equal(3, registry.Participants(t.ChannelId).Count);

        // Carol can't read it any more: out of the room at once (her app's chain members then rekey without her).
        await t.Owner.RequestAsync("member.setRole", new { accountKey = t.Carol.Key, role = "member" });
        Assert.Contains(($"voice-{t.ChannelId}", t.Carol.Key), t.Server.Voice.Removed);
        Assert.DoesNotContain(registry.Participants(t.ChannelId), p => p.AccountKey == t.Carol.Key);

        // Someone left out of the chain while still in the room (whatever the reason) is taken out by the next change.
        await t.Owner.RequestAsync("member.setRole", new { accountKey = t.Carol.Key, role = "trusted" });
        Webhook(t.Server, "participant_joined", t.ChannelId, t.Carol.Key); // in the chain still: allowed
        Assert.Contains(registry.Participants(t.ChannelId), p => p.AccountKey == t.Carol.Key);
        t.Server.World.Store.SaveE2eeChange(new E2eeChannel(t.ChannelId, t.Chain, 2, "h2", [t.Owner.Key, t.Bob.Key], Now),
            new E2eeChange(2, "p", "s", t.Owner.Key, Now), [], fresh: false);
        var (rekey, _) = E2eeChannelTests.Change(t.Owner, t.Chain, 3, "h2", "rekey", [], [t.Owner.Key, t.Bob.Key]);
        Assert.Equal("result", (await t.Owner.RequestAsync("echan.change", new
        {
            channelId = t.ChannelId, change = rekey, keys = new[] { E2eeChannelTests.KeyEnvelope(t.Owner, t.Chain, 3, t.Owner, t.Bob) },
        })).Type());
        Assert.DoesNotContain(registry.Participants(t.ChannelId), p => p.AccountKey == t.Carol.Key);
        Assert.Equal(2, registry.Participants(t.ChannelId).Count);
    }

    [Fact]
    public async Task Moves_afk_and_watch_parties_respect_the_key()
    {
        using var t = await E2eeChannelTests.CreateAsync("voice");
        var lounge = t.Server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var erin = await t.Server.JoinAsync("Erin", "trusted");
        Webhook(t.Server, "participant_joined", lounge, erin.Key);
        Webhook(t.Server, "participant_joined", lounge, t.Bob.Key);

        // A moderator can't move someone without the key into the encrypted channel; someone with it, yes.
        var refused = await t.Owner.RequestAsync("voice.move", new { accountKey = erin.Key, channelId = t.ChannelId });
        Assert.Equal("forbidden", refused.ErrorCode());
        Assert.Equal("e2ee_voice_they_waiting", Key(refused));
        Assert.Equal("result", (await t.Owner.RequestAsync("voice.move", new { accountKey = t.Bob.Key, channelId = t.ChannelId })).Type());

        // It can't be the AFK channel (people are moved there by the server, key or not).
        var afk = await t.Owner.RequestAsync("afk.update", new { channelId = t.ChannelId });
        Assert.Equal("afk_encrypted", Key(afk));

        // Watch parties would show the server what's played and the chat: off here.
        Webhook(t.Server, "participant_joined", t.ChannelId, t.Owner.Key);
        var watch = await t.Owner.RequestAsync("watch.start", new { channelId = t.ChannelId, source = new { kind = "youtube", videoId = "dQw4w9WgXcQ" } });
        Assert.Equal("watch_e2ee", Key(watch));
        Assert.Equal("watch_e2ee", Key(await t.Owner.RequestAsync("watch.chat", new { channelId = t.ChannelId, text = "hi" })));

        // Clip notices are plaintext messages: refused (apps announce clips in the room instead).
        await t.Owner.RequestAsync("voice.state", new { muted = false, deafened = false, clips = true });
        Assert.Equal("bad_request", (await t.Owner.RequestAsync("voice.clip", new { channelId = t.ChannelId })).ErrorCode());
    }
}

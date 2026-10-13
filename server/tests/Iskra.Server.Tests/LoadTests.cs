using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Iskra.Server.Features;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Channel = System.Threading.Channels.Channel;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Iskra.Server.Tests;

/// <summary>The batched paths busy servers take (see design/PERF_REVIEW.md) give exactly what the one-at-a-time ones do.</summary>
public class LoadTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    [Fact]
    public async Task Welcome_member_list_matches_each_members_own_view()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var store = server.World.Store;
        var role = store.CreateRole("Mods", "#ff0000", null, true, Perm.ManageMessages, Now);
        store.SetMemberRoles(alice.Key, [role.Id]);
        store.UpdateProfile(alice.Key, bio: "hello", pronouns: "she/her", accent: "#123456");
        store.SetNickname(alice.Key, "Ali");
        store.SetPresence(bob.Key, new PresenceRecord("dnd", "🎮", "busy", null, Now));
        store.SetTimeout(new MemberTimeout(bob.Key, Now + 60_000, "calm down", alice.Key, Now));
        store.AddMember("offline-member-key", "Carol", "member", Now); // never connected

        var hub = server.Services.GetRequiredService<Hub>();
        var one = store.AllMembers().Select(hub.PublicMember).Select(m => JsonSerializer.Serialize(m, Json.Options)).ToList();
        var batched = hub.PublicMembers().Select(m => JsonSerializer.Serialize(m, Json.Options)).ToList();
        Assert.Equal(one, batched);
        Assert.Contains(batched, m => m.Contains("\"Ali\"") && m.Contains("\"hello\""));
        Assert.Contains(batched, m => m.Contains("\"dnd\"") && m.Contains("\"timedOutUntil\":1"));

        // What a new connection actually gets.
        using var dave = await server.JoinAsync("Dave");
        var welcome = dave.Welcome.Body().GetProperty("members").EnumerateArray().ToList();
        Assert.Equal(4, welcome.Count); // Alice, Bob, Carol (offline) and Dave
        Assert.Equal("Ali", welcome.Single(m => m.GetProperty("accountKey").GetString() == alice.Key).GetProperty("name").GetString());
        Assert.Equal([role.Id], welcome.Single(m => m.GetProperty("accountKey").GetString() == alice.Key).GetProperty("roles").EnumerateArray().Select(r => r.GetInt64()));
        Assert.Equal("dnd", welcome.Single(m => m.GetProperty("accountKey").GetString() == bob.Key).GetProperty("status").GetString());
    }

    [Fact]
    public async Task GetMembers_matches_GetMember()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob", "admin");
        var store = server.World.Store;
        var low = store.CreateRole("Low", null, null, false, Perm.None, Now);
        var high = store.CreateRole("High", null, null, false, Perm.ManageMessages, Now);
        store.SetMemberRoles(alice.Key, [low.Id, high.Id]);

        var many = store.GetMembers([alice.Key, bob.Key, "nobody"]);
        Assert.Equal(2, many.Count);
        foreach (var key in new[] { alice.Key, bob.Key })
        {
            var single = store.GetMember(key)!;
            Assert.Equal(single with { RoleIds = [] }, many[key] with { RoleIds = [] });
            Assert.Equal(single.RoleIds, many[key].RoleIds);
        }
        Assert.Empty(store.GetMembers([]));
    }

    [Fact]
    public async Task Typing_reaches_readers_but_not_the_typist_or_hidden_channels()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice", "admin");
        using var bob = await server.JoinAsync("Bob");
        var aliceAgain = await server.ConnectAsync();
        using var aliceId = new TestIdentity(alice.Identity.Account);
        await aliceAgain.LoginAsync(aliceId, "Alice");

        await alice.RequestAsync("chat.typing", new { channelId = server.General });
        var typing = await bob.EventAsync("chat.typing");
        Assert.Equal(alice.Key, typing.Body().GetProperty("accountKey").GetString());
        await aliceAgain.NoEventAsync("chat.typing");

        var created = await alice.RequestAsync("channel.create", new { name = "admins", readRole = "admin", writeRole = "admin" });
        var hidden = created.Body().GetProperty("channel").GetProperty("id").GetInt64();
        await alice.RequestAsync("chat.typing", new { channelId = hidden });
        await bob.NoEventAsync("chat.typing");
        aliceAgain.Dispose();
    }

    [Fact]
    public async Task A_client_that_stops_reading_is_dropped_instead_of_queueing_forever()
    {
        using var server = new IskraServer();
        var services = server.Services;
        var hub = services.GetRequiredService<Hub>();
        var socket = new StalledSocket();
        var session = new Session(socket, server.World, hub, services.GetRequiredService<VoiceRegistry>(), services.GetRequiredService<Uploads>(),
            services.GetRequiredService<LinkPreviews>(), services.GetRequiredService<Router>(), new SessionLimits { MaxQueuedChars = 200_000 },
            NullLogger.Instance, TimeProvider.System)
        {
            Push = services.GetRequiredService<Iskra.Server.Push.PushService>(),
            Gifs = services.GetRequiredService<Iskra.Server.Gifs.GifService>(),
        };
        var run = session.RunAsync(CancellationToken.None);

        // Log in, then never read again: the welcome is the last frame the socket takes.
        using var identity = new TestIdentity();
        var hello = JsonDocument.Parse(await socket.Sent.Reader.ReadAsync()).RootElement;
        socket.Deliver(identity.AuthFrame(hello, "Stuck", invite: server.Invite()).ToJsonString());
        Assert.Contains("welcome", await socket.Sent.Reader.ReadAsync());
        socket.Stall();
        await WaitUntil(() => hub.Sessions.Contains(session));

        var big = Frames.Event("test.filler", new { text = new string('x', 10_000) });
        for (var i = 0; i < 30 && !run.IsCompleted; i++) hub.Broadcast(big);

        await run.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(WebSocketState.Aborted, socket.State);
        Assert.DoesNotContain(session, hub.Sessions);
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        for (var i = 0; i < 100 && !condition(); i++) await Task.Delay(50);
        Assert.True(condition());
    }

    /// <summary>A client connection that takes frames until <see cref="Stall"/>, then never again (a dead or stuck peer).</summary>
    private sealed class StalledSocket : WebSocket
    {
        private readonly Channel<string> _inbound = Channel.CreateUnbounded<string>();
        private readonly CancellationTokenSource _aborted = new();
        private volatile bool _stalled;
        private WebSocketState _state = WebSocketState.Open;

        public Channel<string> Sent { get; } = Channel.CreateUnbounded<string>();
        public void Deliver(string text) => _inbound.Writer.TryWrite(text);
        public void Stall() => _stalled = true;

        public override WebSocketCloseStatus? CloseStatus => null;
        public override string? CloseStatusDescription => null;
        public override string? SubProtocol => null;
        public override WebSocketState State => _state;

        public override void Abort()
        {
            _state = WebSocketState.Aborted;
            _aborted.Cancel();
        }

        public override async Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType type, bool endOfMessage, CancellationToken cancel)
        {
            if (_stalled) await Task.Delay(Timeout.Infinite, _aborted.Token).ContinueWith(_ => throw new WebSocketException("aborted"));
            Sent.Writer.TryWrite(Encoding.UTF8.GetString(buffer));
        }

        public override async Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancel)
        {
            string text;
            try
            {
                text = await _inbound.Reader.ReadAsync(_aborted.Token);
            }
            catch (OperationCanceledException)
            {
                throw new WebSocketException("aborted");
            }
            var bytes = Encoding.UTF8.GetBytes(text);
            bytes.CopyTo(buffer.Array!, buffer.Offset);
            return new WebSocketReceiveResult(bytes.Length, WebSocketMessageType.Text, true);
        }

        public override Task CloseAsync(WebSocketCloseStatus status, string? description, CancellationToken cancel) => CloseOutputAsync(status, description, cancel);

        public override Task CloseOutputAsync(WebSocketCloseStatus status, string? description, CancellationToken cancel)
        {
            _state = WebSocketState.CloseSent;
            return Task.CompletedTask;
        }

        public override void Dispose() => _aborted.Dispose();
    }
}

using System.Net;
using System.Net.Sockets;
using Iskra.Server.Storage;
using Iskra.Server.Voice;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Iskra.Server.Tests;

/// <summary>
/// Before voice is said to be available the server has LiveKit validate one join (LiveKitHost.WarmUpAsync), so the
/// slow part of LiveKit's first join (building its user-agent parser) isn't paid by the first person who joins.
/// </summary>
public class LiveKitWarmUpTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "iskra-warm-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    /// <summary>The pinned livekit-server in .tools (scripts/get-livekit), or null.</summary>
    private static string? LiveKit()
    {
        var name = OperatingSystem.IsWindows() ? "livekit-server.exe" : "livekit-server";
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, ".tools", name);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    [Fact]
    public async Task The_warm_up_asks_LiveKit_to_validate_a_join_nobody_makes()
    {
        var cancel = TestContext.Current.CancellationToken;
        // Something that answers like LiveKit's /rtc/validate and keeps what it was asked.
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        await using var fake = builder.Build();
        string? authorization = null;
        fake.MapGet("/rtc/validate", (HttpContext context) =>
        {
            authorization = context.Request.Headers.Authorization.ToString();
            return Results.Text("success");
        });
        await fake.StartAsync(cancel);
        var port = new Uri(fake.Urls.First()).Port;

        using var world = World.OpenOrCreate(Path.Combine(_dir, "asked"));
        world.UpdateSettings(s => s with { LocalOnly = true, Voice = s.Voice with { Port = port } });
        using var livekit = new LiveKitHost(world, NullLogger<LiveKitHost>.Instance);
        Assert.Equal(HttpStatusCode.OK, await livekit.WarmUpAsync(cancel));

        // A join token for a room that is no voice channel, call or whisper, good for a minute, with no rights in it.
        Assert.StartsWith("Bearer ", authorization);
        var claims = LiveKitTokens.Verify(authorization![7..], livekit.ApiKey, livekit.ApiSecret, DateTimeOffset.UtcNow);
        Assert.NotNull(claims);
        var video = claims.Value.GetProperty("video");
        Assert.Equal(LiveKitHost.WarmUpRoom, video.GetProperty("room").GetString());
        Assert.Null(VoiceRegistry.ChannelOf(LiveKitHost.WarmUpRoom));
        Assert.True(video.GetProperty("roomJoin").GetBoolean());
        Assert.False(video.GetProperty("canPublish").GetBoolean());
        Assert.False(video.GetProperty("canSubscribe").GetBoolean());
        Assert.InRange(claims.Value.GetProperty("exp").GetInt64() - DateTimeOffset.UtcNow.ToUnixTimeSeconds(), 1, 60);
        // No admin or create rights: it could not make or change a room.
        Assert.False(video.TryGetProperty("roomAdmin", out _));
        Assert.False(video.TryGetProperty("roomCreate", out _));
    }

    [Fact]
    public async Task Any_answer_ends_the_warm_up_and_no_answer_does_not()
    {
        var cancel = TestContext.Current.CancellationToken;
        // A LiveKit without that address (a later version): it answered, so there is nothing more to wait for.
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        await using var fake = builder.Build();
        await fake.StartAsync(cancel);
        using var world = World.OpenOrCreate(Path.Combine(_dir, "answers"));
        world.UpdateSettings(s => s with { LocalOnly = true, Voice = s.Voice with { Port = new Uri(fake.Urls.First()).Port } });
        using var livekit = new LiveKitHost(world, NullLogger<LiveKitHost>.Instance);
        Assert.Equal(HttpStatusCode.NotFound, await livekit.WarmUpAsync(cancel));

        // Nothing listening (LiveKit not up yet): no answer, so it is asked again.
        await fake.StopAsync(cancel);
        Assert.Null(await livekit.WarmUpAsync(cancel));
    }

    /// <summary>
    /// The real LiveKit takes the question (200): if a new version stopped doing so, the warm-up would do nothing and
    /// the first join would be slow again without any test noticing. Skipped without livekit-server in .tools.
    /// </summary>
    [Fact]
    public async Task The_real_LiveKit_accepts_the_warm_up_before_voice_is_available()
    {
        var binary = LiveKit();
        Assert.SkipWhen(binary is null, "livekit-server isn't in .tools");
        var cancel = TestContext.Current.CancellationToken;
        using var world = World.OpenOrCreate(Path.Combine(_dir, "real"));
        world.UpdateSettings(s => s with
        {
            LocalOnly = true,
            Voice = s.Voice with { LiveKitPath = binary, Port = FreePort(), RtcTcpPort = FreePort(), RtcUdpPort = 40300 + Random.Shared.Next(15000) },
        });
        var livekit = new LiveKitHost(world, NullLogger<LiveKitHost>.Instance);
        var up = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        livekit.AvailabilityChanged += available => { if (available) up.TrySetResult(); };
        await livekit.StartAsync(cancel);
        try
        {
            await up.Task.WaitAsync(TimeSpan.FromSeconds(60), cancel);
            Assert.Equal(HttpStatusCode.OK, await livekit.WarmUpAsync(cancel));
        }
        finally
        {
            await livekit.StopAsync(CancellationToken.None);
            livekit.Dispose();
        }
    }
}

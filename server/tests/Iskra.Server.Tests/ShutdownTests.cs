using System.Text;
using System.Text.Json;
using Iskra.Server.Sessions;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Iskra.Server.Tests;

public class ShutdownTests
{
    [Fact]
    public async Task Stopping_the_server_for_good_says_so()
    {
        using var server = new IskraServer();
        using var ann = await server.JoinAsync("Ann");

        // Without this, open sockets held shutdown open until the host gave up (about 30 seconds on Linux).
        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();

        // A plain stop (Ctrl+C, SIGTERM, the desktop host closing): 1001 "Going Away", so apps show it as offline.
        Assert.Equal(1001, await ann.Client.ReceiveCloseAsync());
        Assert.Equal("""{"v":1,"reason":"stop"}""", ann.Client.CloseReason);
    }

    [Fact]
    public async Task A_restart_says_restarting()
    {
        using var server = new IskraServer();
        using var ann = await server.JoinAsync("Ann");

        server.Services.GetRequiredService<Hub>().Restart.Expect("restart", null);
        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();

        // 1012 "Service Restart" with a machine-readable reason: apps say "restarting, hold on" and retry quickly.
        Assert.Equal(1012, await ann.Client.ReceiveCloseAsync());
        using var reason = JsonDocument.Parse(ann.Client.CloseReason!);
        Assert.Equal(1, reason.RootElement.GetProperty("v").GetInt32());
        Assert.Equal("restart", reason.RootElement.GetProperty("reason").GetString());
        Assert.False(reason.RootElement.TryGetProperty("etaMs", out _));
    }

    [Fact]
    public async Task A_restart_with_a_known_downtime_says_how_long()
    {
        using var server = new IskraServer();
        using var ann = await server.JoinAsync("Ann");
        using var bob = await server.JoinAsync("Bob");

        server.Services.GetRequiredService<Hub>().Restart.Expect("update", TimeSpan.FromSeconds(20));
        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();

        foreach (var client in new[] { ann, bob })
        {
            Assert.Equal(1012, await client.Client.ReceiveCloseAsync());
            Assert.Equal("""{"v":1,"reason":"update","etaMs":20000}""", client.Client.CloseReason);
            Assert.True(Encoding.UTF8.GetByteCount(client.Client.CloseReason!) <= 123); // WebSocket close reasons are short
        }
    }

    [Fact]
    public void The_downtime_hint_is_capped()
    {
        var signal = new RestartSignal();
        signal.Expect("update", TimeSpan.FromHours(3));
        Assert.Equal("""{"v":1,"reason":"update","etaMs":600000}""", signal.Reason);
    }
    private static void WriteMarker(IskraServer server, string json) =>
        File.WriteAllText(Path.Combine(server.WorldPath, RestartMarker.FileName), json);

    private static long Now(int secondsAgo = 0) => DateTimeOffset.UtcNow.AddSeconds(-secondsAgo).ToUnixTimeMilliseconds();

    [Fact]
    public async Task A_stop_with_a_restart_marker_says_restarting()
    {
        // What iskra-update does before `systemctl restart`: the SIGTERM that follows is a restart, not a stop.
        using var server = new IskraServer();
        using var ann = await server.JoinAsync("Ann");
        RestartMarker.Write(server.WorldPath, "update", 30, DateTimeOffset.UtcNow);

        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();

        Assert.Equal(1012, await ann.Client.ReceiveCloseAsync());
        Assert.Equal("""{"v":1,"reason":"update","etaMs":30000}""", ann.Client.CloseReason);
        Assert.False(File.Exists(Path.Combine(server.WorldPath, RestartMarker.FileName))); // used once
    }

    [Fact]
    public async Task The_desktop_apps_update_marker_says_restarting_for_an_update()
    {
        // desktop/src/restartMarker.ts writes exactly this before the app installs an update, then closes the server's
        // stdin without a "restart" line, so the marker's reason (update) is the one members see.
        using var server = new IskraServer();
        using var ann = await server.JoinAsync("Ann");
        WriteMarker(server, $$"""{"v":1,"reason":"update","etaSeconds":60,"at":{{Now(1)}}}""" + "\n");

        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();

        Assert.Equal(1012, await ann.Client.ReceiveCloseAsync());
        Assert.Equal("""{"v":1,"reason":"update","etaMs":60000}""", ann.Client.CloseReason);
    }

    [Fact]
    public async Task A_marker_without_an_eta_or_reason_choice_is_a_plain_restart()
    {
        using var server = new IskraServer();
        using var ann = await server.JoinAsync("Ann");
        WriteMarker(server, $$"""{"v":1,"reason":"restart","at":{{Now(5)}}}""");

        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();

        Assert.Equal(1012, await ann.Client.ReceiveCloseAsync());
        Assert.Equal("""{"v":1,"reason":"restart"}""", ann.Client.CloseReason);
    }

    [Fact]
    public async Task A_stale_marker_is_an_ordinary_stop()
    {
        using var server = new IskraServer();
        using var ann = await server.JoinAsync("Ann");
        WriteMarker(server, $$"""{"v":1,"reason":"update","etaSeconds":30,"at":{{Now(3 * 60)}}}""");

        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();

        Assert.Equal(1001, await ann.Client.ReceiveCloseAsync());
        Assert.Equal("""{"v":1,"reason":"stop"}""", ann.Client.CloseReason);
        Assert.False(File.Exists(Path.Combine(server.WorldPath, RestartMarker.FileName)));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"v":1,"reason":"went offline\"}, \"x\":\"","at":0}""")]
    [InlineData("""{"v":1,"reason":"<b>hi</b>","at":NOW}""")]
    [InlineData("""{"v":1,"reason":"update","etaSeconds":"30\",\"evil\":1","at":NOW}""")]
    [InlineData("""{"v":1,"reason":"update","etaSeconds":99999,"at":NOW}""")]
    [InlineData("""{"v":1,"reason":"update","etaSeconds":-1,"at":NOW}""")]
    [InlineData("""{"v":2,"reason":"update","at":NOW}""")]
    [InlineData("""{"v":1,"reason":"update"}""")]
    [InlineData("""["update"]""")]
    public async Task A_malformed_marker_is_ignored(string json)
    {
        using var server = new IskraServer();
        using var ann = await server.JoinAsync("Ann");
        WriteMarker(server, json.Replace("NOW", Now().ToString()));

        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();

        Assert.Equal(1001, await ann.Client.ReceiveCloseAsync());
        Assert.Equal("""{"v":1,"reason":"stop"}""", ann.Client.CloseReason);
        Assert.False(File.Exists(Path.Combine(server.WorldPath, RestartMarker.FileName)));
    }

    [Fact]
    public async Task An_oversized_marker_is_ignored()
    {
        using var server = new IskraServer();
        using var ann = await server.JoinAsync("Ann");
        WriteMarker(server, $$"""{"v":1,"reason":"update","at":{{Now()}},"pad":"{{new string('x', 2000)}}"}""");

        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();

        Assert.Equal(1001, await ann.Client.ReceiveCloseAsync());
    }

    [Fact]
    public async Task A_marker_left_from_before_the_start_is_deleted()
    {
        var world = Path.Combine(Path.GetTempPath(), "iskra-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(world);
        File.WriteAllText(Path.Combine(world, RestartMarker.FileName), $$"""{"v":1,"reason":"update","at":{{Now()}}}""");
        using var server = new IskraServer { Settings = { ["World"] = world } };
        using var ann = await server.JoinAsync("Ann");
        Assert.False(File.Exists(Path.Combine(world, RestartMarker.FileName)));

        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();
        Assert.Equal(1001, await ann.Client.ReceiveCloseAsync());
    }

    [Fact]
    public async Task The_servers_own_update_keeps_its_reason_over_a_marker()
    {
        using var server = new IskraServer();
        using var ann = await server.JoinAsync("Ann");
        server.Services.GetRequiredService<Hub>().Restart.Expect("update", TimeSpan.FromSeconds(20));
        RestartMarker.Write(server.WorldPath, "restart", 90, DateTimeOffset.UtcNow);

        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();

        Assert.Equal(1012, await ann.Client.ReceiveCloseAsync());
        Assert.Equal("""{"v":1,"reason":"update","etaMs":20000}""", ann.Client.CloseReason);
    }

    [Fact]
    public void The_cli_writes_the_marker()
    {
        var world = Path.Combine(Path.GetTempPath(), "iskra-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(world);
        try
        {
            // Not a world folder: refused, nothing written.
            Assert.Equal(1, Cli.Run(["expect-restart", world, "--reason", "update"]));
            Assert.False(File.Exists(Path.Combine(world, RestartMarker.FileName)));
            File.WriteAllText(Path.Combine(world, "server.key"), "x");

            Assert.Equal(2, Cli.Run(["expect-restart", world, "--reason", "offline"]));
            Assert.Equal(2, Cli.Run(["expect-restart", world, "--eta", "soon"]));
            Assert.Equal(2, Cli.Run(["expect-restart", world, "--eta", "601"]));
            Assert.Equal(2, Cli.Run(["expect-restart", world, "--eta", "-5"]));
            Assert.False(File.Exists(Path.Combine(world, RestartMarker.FileName)));

            var before = DateTimeOffset.UtcNow;
            Assert.Equal(0, Cli.Run(["expect-restart", world, "--reason", "update", "--eta", "30"]));
            var file = Path.Combine(world, RestartMarker.FileName);
            using (var doc = JsonDocument.Parse(File.ReadAllText(file)))
            {
                Assert.Equal(1, doc.RootElement.GetProperty("v").GetInt32());
                Assert.Equal("update", doc.RootElement.GetProperty("reason").GetString());
                Assert.Equal(30, doc.RootElement.GetProperty("etaSeconds").GetInt32());
                Assert.InRange(doc.RootElement.GetProperty("at").GetInt64(), before.ToUnixTimeMilliseconds(), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            }
            Assert.False(File.Exists(file + ".tmp"));
            Assert.Equal(("update", (TimeSpan?)TimeSpan.FromSeconds(30)), RestartMarker.Consume(world, DateTimeOffset.UtcNow));
            Assert.False(File.Exists(file));

            // Defaults: a restart, no ETA.
            Assert.Equal(0, Cli.Run(["expect-restart", world]));
            Assert.Equal(("restart", (TimeSpan?)null), RestartMarker.Consume(world, DateTimeOffset.UtcNow));
        }
        finally
        {
            Directory.Delete(world, recursive: true);
        }
    }
}
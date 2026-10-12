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
    public async Task Stopping_the_server_says_goodbye_to_connected_clients()
    {
        using var server = new IskraServer();
        using var ann = await server.JoinAsync("Ann");

        // Without this, open sockets held shutdown open until the host gave up (about 30 seconds on Linux).
        server.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();

        // 1012 "Service Restart" with a machine-readable reason: apps say "restarting, hold on" and retry quickly.
        Assert.Equal(1012, await ann.Client.ReceiveCloseAsync());
        using var reason = JsonDocument.Parse(ann.Client.CloseReason!);
        Assert.Equal(1, reason.RootElement.GetProperty("v").GetInt32());
        Assert.Equal("restart", reason.RootElement.GetProperty("reason").GetString());
        Assert.False(reason.RootElement.TryGetProperty("etaMs", out _)); // a plain stop doesn't know how long it takes
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
}

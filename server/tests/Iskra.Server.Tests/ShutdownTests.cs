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

        Assert.Equal(1001, await ann.Client.ReceiveCloseAsync());
    }
}

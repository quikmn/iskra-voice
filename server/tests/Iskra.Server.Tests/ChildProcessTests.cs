using System.IO.Pipes;
using Iskra.Server.Hosting;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace Iskra.Server.Tests;

/// <summary>The desktop app stops its servers by closing their stdin, so they shut down cleanly instead of being killed.</summary>
public class ChildProcessTests
{
    private sealed class Lifetime : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource _stopping = new();
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => _stopping.Token;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public int StopCalls;
        public void StopApplication()
        {
            Interlocked.Increment(ref StopCalls);
            _stopping.Cancel();
        }
    }

    [Fact]
    public void Closing_stdin_stops_the_server_gracefully()
    {
        using var server = new AnonymousPipeServerStream(PipeDirection.Out);
        var input = new AnonymousPipeClientStream(PipeDirection.In, server.ClientSafePipeHandle);
        var lifetime = new Lifetime();
        var watch = ChildProcesses.StopWhenClosed(input, lifetime, NullLogger.Instance);

        server.Write([1, 2, 3]); // anything written is ignored
        Assert.False(watch.Join(300));
        Assert.Equal(0, lifetime.StopCalls);

        server.Dispose(); // the app closes our stdin (or goes away)
        Assert.True(watch.Join(5000));
        Assert.Equal(1, lifetime.StopCalls);
    }

    [Fact]
    public void Already_stopping_is_left_alone()
    {
        var lifetime = new Lifetime();
        lifetime.StopApplication();
        var watch = ChildProcesses.StopWhenClosed(new MemoryStream(), lifetime, NullLogger.Instance);
        Assert.True(watch.Join(5000));
        Assert.Equal(1, lifetime.StopCalls);
    }
}

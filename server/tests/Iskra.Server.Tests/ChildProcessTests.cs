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

    /// <summary>
    /// Regression: Process.BeginOutputReadLine reads on the thread pool, and on Windows each pipe then holds one of its
    /// threads in a blocking read for as long as the child lives. Two children took every pool thread of a 4-core CI
    /// runner, and tests in other classes timed out waiting for replies.
    /// </summary>
    [Fact]
    public async Task A_childs_output_is_read_off_the_thread_pool()
    {
        var info = new System.Diagnostics.ProcessStartInfo("dotnet", "--version") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        using var child = System.Diagnostics.Process.Start(info)!;
        var lines = new System.Collections.Concurrent.ConcurrentQueue<(string Text, bool OnPool)>();
        void Keep(string line) => lines.Enqueue((line, Thread.CurrentThread.IsThreadPoolThread));
        await ChildOutput.Read(child, Keep, Keep).WaitAsync(TimeSpan.FromSeconds(60), TestContext.Current.CancellationToken);
        Assert.Contains(lines, l => l.Text.Length > 0 && char.IsAsciiDigit(l.Text[0])); // the version, so every line was read
        Assert.DoesNotContain(lines, l => l.OnPool);
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

    [Fact]
    public void A_restart_line_before_the_close_says_the_app_starts_us_again()
    {
        using var server = new AnonymousPipeServerStream(PipeDirection.Out);
        var input = new AnonymousPipeClientStream(PipeDirection.In, server.ClientSafePipeHandle);
        var lifetime = new Lifetime();
        var restarts = 0;
        var watch = ChildProcesses.StopWhenClosed(input, lifetime, NullLogger.Instance, () => restarts++);

        server.Write("restart\n"u8);
        server.Dispose();
        Assert.True(watch.Join(5000));
        Assert.Equal(1, restarts);
        Assert.Equal(1, lifetime.StopCalls);
    }

    [Fact]
    public void A_plain_close_is_a_stop()
    {
        var lifetime = new Lifetime();
        var restarts = 0;
        var watch = ChildProcesses.StopWhenClosed(new MemoryStream("restarting soon?\n"u8.ToArray()), lifetime, NullLogger.Instance, () => restarts++);
        Assert.True(watch.Join(5000));
        Assert.Equal(0, restarts);
        Assert.Equal(1, lifetime.StopCalls);
    }
}

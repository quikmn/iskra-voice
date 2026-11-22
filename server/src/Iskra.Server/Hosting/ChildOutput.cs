using System.Diagnostics;

namespace Iskra.Server.Hosting;

/// <summary>
/// Reads a child process's redirected output line by line on two threads of its own, instead of
/// <see cref="Process.BeginOutputReadLine"/>. On Windows the pipes to a child are synchronous handles, so .NET's
/// "async" reads each hold a thread-pool thread in a blocking read for as long as the child lives. Two children take
/// four: every pool thread of a 4-core machine, and requests then wait for the pool to add more.
/// </summary>
public static class ChildOutput
{
    /// <summary>
    /// Starts reading; the process must have both streams redirected. The handlers run on the reading threads, one
    /// line at a time per stream. The task ends when both streams have closed (the child and anything that inherited
    /// its output have exited).
    /// </summary>
    public static Task Read(Process process, Action<string> onOutput, Action<string> onError) =>
        Task.WhenAll(Read(process.StandardOutput, onOutput, "child stdout"), Read(process.StandardError, onError, "child stderr"));

    private static Task Read(StreamReader reader, Action<string> onLine, string name)
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        new Thread(() =>
        {
            try
            {
                while (reader.ReadLine() is { } line) onLine(line);
            }
            // The process object was disposed (or the pipe broke) while a read was waiting.
            catch (Exception e) when (e is IOException or ObjectDisposedException) { }
            finally
            {
                done.TrySetResult();
            }
        }) { IsBackground = true, Name = name }.Start();
        return done.Task;
    }
}

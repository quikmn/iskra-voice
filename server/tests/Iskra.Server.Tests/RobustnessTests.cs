using System.Diagnostics;
using Iskra.Server.Storage;

namespace Iskra.Server.Tests;

/// <summary>Damaged world files: one clear line and a known exit code, never a stack trace or a half-started server.</summary>
public class RobustnessTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), "iskra-damaged-" + Guid.NewGuid().ToString("N"));

    private Exception OpenFails()
    {
        var ex = Record.Exception(() => World.OpenOrCreate(_path).Dispose());
        Assert.NotNull(ex);
        return ex;
    }

    private void MakeWorld()
    {
        World.OpenOrCreate(_path).Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
    }

    [Fact]
    public void Broken_server_json_says_which_file_and_what_to_do()
    {
        MakeWorld();
        File.WriteAllText(Path.Combine(_path, "server.json"), """{ "Name": "x", LocalOnly """);
        var problem = WorldProblem.Describe(_path, OpenFails());
        Assert.NotNull(problem);
        Assert.Contains("server.json isn't valid JSON", problem);
    }

    [Fact]
    public void A_database_that_isnt_one_points_to_restore()
    {
        MakeWorld();
        foreach (var f in Directory.EnumerateFiles(_path, "iskra.db*")) File.Delete(f);
        File.WriteAllBytes(Path.Combine(_path, "iskra.db"), [.. Enumerable.Range(0, 8192).Select(i => (byte)(i * 7))]);
        var problem = WorldProblem.Describe(_path, OpenFails());
        Assert.NotNull(problem);
        Assert.Contains("iskra-server restore", problem);
    }

    [Fact]
    public void A_bad_server_key_is_named()
    {
        MakeWorld();
        File.WriteAllText(Path.Combine(_path, "server.key"), "garbage");
        Assert.Contains("server.key is not a valid server key", WorldProblem.Describe(_path, OpenFails()));
    }

    [Fact]
    public void Other_errors_are_not_world_problems() => Assert.Null(WorldProblem.Describe(_path, new InvalidOperationException("bug")));

    [Fact]
    public async Task The_server_exits_with_code_3_and_one_line()
    {
        MakeWorld();
        File.WriteAllText(Path.Combine(_path, "server.json"), "{ not json");
        var dll = typeof(WorldProblem).Assembly.Location;
        var start = new ProcessStartInfo("dotnet") { RedirectStandardError = true, RedirectStandardOutput = true, RedirectStandardInput = true };
        start.ArgumentList.Add(dll);
        start.ArgumentList.Add(_path);
        using var process = Process.Start(start)!;
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        await process.WaitForExitAsync(timeout.Token);
        Assert.Equal(WorldProblem.ExitCode, process.ExitCode);
        var text = (await stderr).Trim();
        Assert.StartsWith("Can't start:", text);
        Assert.DoesNotContain("   at ", text);
    }

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(_path, recursive: true); } catch (IOException) { }
    }
}

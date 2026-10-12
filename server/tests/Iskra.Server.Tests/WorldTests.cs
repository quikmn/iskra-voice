using Iskra.Server.Crypto;
using Iskra.Server.Storage;

namespace Iskra.Server.Tests;

public class WorldTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), "iskra-world-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task Closing_the_world_waits_for_a_running_statement()
    {
        // Regression: ApplicationStopped disposed the store while sessions were still querying it, so Dispose threw.
        var world = World.OpenOrCreate(_path);
        for (var i = 0; i < 50; i++) world.Store.AddMember(Guid.NewGuid().ToString("N"), "M", "member", 0);
        using var stop = new CancellationTokenSource();
        var busy = Task.Run(() =>
        {
            while (!stop.IsCancellationRequested)
            {
                try { world.Store.AllMembers(); }
                catch (Exception) { return; } // closed under us is fine; closing is what must not throw
            }
        });
        await Task.Delay(50);
        world.Dispose();
        stop.Cancel();
        await busy;
    }

    [Fact]
    public void The_database_uses_wal_without_a_disk_flush_per_commit()
    {
        // Regression: synchronous=FULL flushed the disk on every commit under the write lock, which made the Windows CI
        // run several times slower than Linux and starved logins past their timeouts.
        using var world = World.OpenOrCreate(_path);
        var db = (Microsoft.Data.Sqlite.SqliteConnection)typeof(Store)
            .GetField("_db", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(world.Store)!;
        using var cmd = db.CreateCommand();
        cmd.CommandText = "PRAGMA journal_mode;";
        Assert.Equal("wal", cmd.ExecuteScalar());
        cmd.CommandText = "PRAGMA synchronous;";
        Assert.Equal(1L, cmd.ExecuteScalar()); // NORMAL
    }

    [Fact]
    public void A_missing_folder_is_created_with_defaults()
    {
        using var world = World.OpenOrCreate(_path);
        Assert.True(File.Exists(Path.Combine(_path, "server.json")));
        Assert.True(File.Exists(Path.Combine(_path, "server.key")));
        Assert.True(File.Exists(Path.Combine(_path, "iskra.db")));
        Assert.True(Directory.Exists(Path.Combine(_path, "uploads")));
        Assert.Equal(47070, world.Settings.Port);
    }

    [Fact]
    public void The_server_identity_survives_a_restart()
    {
        string first;
        using (var world = World.OpenOrCreate(_path)) first = Ed25519.ToB64u(world.ServerPublicKey);
        using (var world = World.OpenOrCreate(_path)) Assert.Equal(first, Ed25519.ToB64u(world.ServerPublicKey));
    }

    [Fact]
    public void Members_survive_a_restart()
    {
        using (var world = World.OpenOrCreate(_path)) world.Store.AddMember("key1", "Alice", "owner", 1);
        using (var world = World.OpenOrCreate(_path))
        {
            var member = world.Store.GetMember("key1");
            Assert.NotNull(member);
            Assert.Equal("owner", member.Role);
        }
    }

    [Fact]
    public void Edited_settings_are_respected()
    {
        Directory.CreateDirectory(_path);
        File.WriteAllText(Path.Combine(_path, "server.json"), """{ "Name": "Gaming", "Port": 9000 }""");
        using var world = World.OpenOrCreate(_path);
        Assert.Equal("Gaming", world.Settings.Name);
        Assert.Equal(9000, world.Settings.Port);
    }

    [Fact]
    public void A_corrupt_key_file_is_a_clear_error_not_a_new_identity()
    {
        Directory.CreateDirectory(_path);
        File.WriteAllText(Path.Combine(_path, "server.key"), "garbage");
        var ex = Assert.Throws<InvalidDataException>(() => World.OpenOrCreate(_path));
        Assert.Contains("server.key", ex.Message);
    }

    [Fact]
    public void Secrets_and_the_world_folder_are_private_on_unix()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Unix file modes only");
        using (World.OpenOrCreate(_path))
        {
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(_path));
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(_path, "server.key")));
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(_path, "server.json")));
        }
    }

    [Fact]
    public void Existing_world_readable_secrets_are_tightened_on_load()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Unix file modes only");
        using (World.OpenOrCreate(_path)) { }
        var key = Path.Combine(_path, "server.key");
        var livekit = Path.Combine(_path, "livekit.key");
        File.WriteAllText(livekit, "key\nsecret\n");
        var open = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;
        File.SetUnixFileMode(key, open);
        File.SetUnixFileMode(livekit, open);
        using (World.OpenOrCreate(_path))
        {
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(key));
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(livekit));
        }
    }

    [Fact]
    public void A_stale_temp_file_does_not_block_writes()
    {
        Directory.CreateDirectory(_path);
        File.WriteAllText(Path.Combine(_path, "server.key.tmp"), "half");
        using var world = World.OpenOrCreate(_path);
        Assert.True(File.Exists(Path.Combine(_path, "server.key")));
        Assert.False(File.Exists(Path.Combine(_path, "server.key.tmp")));
    }

    public void Dispose()
    {
        try { Directory.Delete(_path, recursive: true); } catch (IOException) { }
    }
}

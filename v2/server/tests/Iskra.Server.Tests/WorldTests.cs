using Iskra.Server.Crypto;
using Iskra.Server.Storage;

namespace Iskra.Server.Tests;

public class WorldTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), "iskra-world-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void A_missing_folder_is_created_with_defaults()
    {
        using var world = World.OpenOrCreate(_path);
        Assert.True(File.Exists(Path.Combine(_path, "server.json")));
        Assert.True(File.Exists(Path.Combine(_path, "server.key")));
        Assert.True(File.Exists(Path.Combine(_path, "iskra.db")));
        Assert.True(Directory.Exists(Path.Combine(_path, "uploads")));
        Assert.Equal(7070, world.Settings.Port);
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

    public void Dispose()
    {
        try { Directory.Delete(_path, recursive: true); } catch (IOException) { }
    }
}

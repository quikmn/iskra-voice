using System.Text.Json;
using Iskra.Server.Crypto;
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Storage;

public sealed record WorldSettings
{
    public string Name { get; init; } = "My Iskra server";
    public int Port { get; init; } = 7070;

    /// <summary>How clients reach this server. Defaults to http://localhost:{Port}.</summary>
    public string? PublicUrl { get; init; }

    /// <summary>The web app that invite links open.</summary>
    public string AppUrl { get; init; } = "http://localhost:5173";

    [System.Text.Json.Serialization.JsonIgnore]
    public string EffectivePublicUrl => (PublicUrl ?? $"http://localhost:{Port}").TrimEnd('/');
}

/// <summary>
/// A server is a folder: server.json (settings), server.key (identity), iskra.db (data), uploads/.
/// Copying the folder backs up or moves the whole server.
/// </summary>
public sealed class World : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public string Path { get; }
    public WorldSettings Settings { get; }
    public Key ServerKey { get; }
    public byte[] ServerPublicKey { get; }
    public Store Store { get; }

    private World(string path, WorldSettings settings, Key serverKey, Store store)
    {
        Path = path;
        Settings = settings;
        ServerKey = serverKey;
        ServerPublicKey = Ed25519.PublicKeyOf(serverKey);
        Store = store;
    }

    /// <summary>Opens the world at <paramref name="path"/>, creating it with defaults if it doesn't exist.</summary>
    public static World OpenOrCreate(string path)
    {
        path = System.IO.Path.GetFullPath(path);
        Directory.CreateDirectory(path);
        Directory.CreateDirectory(System.IO.Path.Combine(path, "uploads"));

        var settingsPath = System.IO.Path.Combine(path, "server.json");
        WorldSettings settings;
        if (File.Exists(settingsPath))
        {
            settings = JsonSerializer.Deserialize<WorldSettings>(File.ReadAllText(settingsPath))
                ?? throw new InvalidDataException($"{settingsPath} is empty.");
        }
        else
        {
            settings = new WorldSettings();
            AtomicFile.WriteAllText(settingsPath, JsonSerializer.Serialize(settings, JsonOptions));
        }

        var keyPath = System.IO.Path.Combine(path, "server.key");
        byte[] seed;
        if (File.Exists(keyPath))
        {
            if (!Ed25519.TryFromB64u(File.ReadAllText(keyPath).Trim(), out seed) || seed.Length != 32)
                throw new InvalidDataException($"{keyPath} is not a valid server key.");
        }
        else
        {
            seed = Ed25519.NewSeed();
            AtomicFile.WriteAllText(keyPath, Ed25519.ToB64u(seed) + "\n");
        }

        var store = Store.Open(System.IO.Path.Combine(path, "iskra.db"));
        return new World(path, settings, Ed25519.KeyFromSeed(seed), store);
    }

    public void Dispose()
    {
        ServerKey.Dispose();
        Store.Dispose();
    }
}

internal static class AtomicFile
{
    /// <summary>Write to a temp file, then rename over the target, so a crash never leaves a half-written file.</summary>
    public static void WriteAllText(string path, string contents)
    {
        var temp = path + ".tmp";
        File.WriteAllText(temp, contents);
        File.Move(temp, path, overwrite: true);
    }
}

using System.Text.Json;
using Iskra.Server.Crypto;
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Storage;

public sealed record WorldSettings
{
    public string Name { get; init; } = "My Iskra server";
    public int Port { get; init; } = 47070; // 7070 clashes with AnyDesk, common on gaming PCs

    /// <summary>How clients reach this server. Defaults to http://localhost:{Port}.</summary>
    public string? PublicUrl { get; init; }

    /// <summary>The web app that invite links open.</summary>
    public string AppUrl { get; init; } = "https://app.iskra.foo";

    [System.Text.Json.Serialization.JsonIgnore]
    public string EffectivePublicUrl => (PublicUrl ?? (Https.Enabled ? Https.DefaultUrl : $"http://localhost:{Port}")).TrimEnd('/');

    /// <summary>Largest file a member may upload. Generous by default: no Nitro here.</summary>
    public int MaxUploadMb { get; init; } = 100;

    public VoiceSettings Voice { get; init; } = new();

    public HttpsSettings Https { get; init; } = new();

    public InternetSettings Internet { get; init; } = new();
}

/// <summary>Opening the server to the internet: router port mapping, an automatic address and HTTPS.</summary>
public sealed record InternetSettings
{
    public bool Enabled { get; init; }

    /// <summary>Your own domain pointing at this network. Default: an address under <see cref="DnsSuffix"/>.</summary>
    public string? Domain { get; init; }

    /// <summary>Wildcard DNS that maps "1-2-3-4.sslip.io" to 1.2.3.4 (used when there's no <see cref="Domain"/>).</summary>
    public string DnsSuffix { get; init; } = "sslip.io";

    /// <summary>Ask the router to open the ports (UPnP / NAT-PMP). Off if you forward them by hand.</summary>
    public bool PortMapping { get; init; } = true;
}

/// <summary>HTTPS: off, automatic Let's Encrypt certificates ("acme"), or your own certificate files ("files").</summary>
public sealed record HttpsSettings
{
    public string Mode { get; init; } = "off";
    public string? Domain { get; init; }
    /// <summary>Let's Encrypt sends expiry warnings here (optional).</summary>
    public string? Email { get; init; }
    public string? CertFile { get; init; }
    public string? KeyFile { get; init; }
    public int Port { get; init; } = 443;
    /// <summary>Plain HTTP port: answers Let's Encrypt's challenge and redirects everything else to HTTPS.</summary>
    public int HttpPort { get; init; } = 80;
    public string AcmeDirectory { get; init; } = "https://acme-v02.api.letsencrypt.org/directory";

    [System.Text.Json.Serialization.JsonIgnore]
    public bool Enabled => Mode is "acme" or "files";

    [System.Text.Json.Serialization.JsonIgnore]
    public string DefaultUrl => $"https://{Domain}{(Port == 443 ? "" : $":{Port}")}";
}

/// <summary>Voice runs on a LiveKit server that iskra-server starts and supervises.</summary>
public sealed record VoiceSettings
{
    public bool Enabled { get; init; } = true;

    /// <summary>Path to livekit-server. Default: next to iskra-server, then $ISKRA_LIVEKIT, then PATH.</summary>
    public string? LiveKitPath { get; init; }

    public int Port { get; init; } = 7880;
    public int RtcTcpPort { get; init; } = 7881;
    public int RtcUdpPort { get; init; } = 7882;

    /// <summary>The ws(s):// URL clients use for voice. Default: the server's host on <see cref="Port"/>.</summary>
    public string? ClientUrl { get; init; }
}

/// <summary>
/// A server is a folder: server.json (settings), server.key (identity), iskra.db (data), uploads/.
/// Copying the folder backs up or moves the whole server.
/// </summary>
public sealed class World : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly Lock _settingsLock = new();

    public string Path { get; }
    public WorldSettings Settings { get; private set; }

    /// <summary>How friends on the internet reach this server right now (set by internet hosting), or null.</summary>
    public string? InternetUrl { get; set; }
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

    /// <summary>Changes settings at runtime: rewrites server.json (keeping keys we don't know) and the live copy.</summary>
    public void UpdateSettings(Func<WorldSettings, WorldSettings> change)
    {
        lock (_settingsLock)
        {
            var next = change(Settings);
            var file = System.IO.Path.Combine(Path, "server.json");
            var json = File.Exists(file) ? System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(file)) as System.Text.Json.Nodes.JsonObject : null;
            json ??= [];
            foreach (var (key, value) in JsonSerializer.SerializeToNode(next, JsonOptions)!.AsObject()) json[key] = value?.DeepClone();
            AtomicFile.WriteAllText(file, json.ToJsonString(JsonOptions));
            Settings = next;
        }
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

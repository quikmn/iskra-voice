using System.Text.Json;
using Iskra.Server.Crypto;
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Storage;

/// <summary>A world folder the server can't open: what's wrong and what to do, for the console and server.log.</summary>
public static class WorldProblem
{
    /// <summary>The exit code for damaged files (the desktop app shows its own message for it); other problems exit with 1.</summary>
    public const int ExitCode = 3;

    /// <summary>A one-line explanation, or null if <paramref name="ex"/> isn't a problem with the world's files.</summary>
    public static string? Describe(string worldPath, Exception ex) => ex switch
    {
        System.Text.Json.JsonException json =>
            $"Can't start: {Path.Combine(worldPath, "server.json")} isn't valid JSON ({json.Message}). Fix it, or move it away to start with the defaults.",
        Microsoft.Data.Sqlite.SqliteException sql =>
            $"Can't start: the database {Path.Combine(worldPath, "iskra.db")} is damaged or unreadable ({sql.Message}). " +
            "Restore a backup into a new folder with: iskra-server restore <backup> <new-folder>",
        InvalidDataException or UnauthorizedAccessException or IOException => $"Can't start: {ex.Message}",
        _ => null,
    };
}

public sealed record WorldSettings
{
    public string Name { get; init; } = "My Iskra server";
    public int Port { get; init; } = 47070; // 7070 clashes with AnyDesk, common on gaming PCs

    /// <summary>How clients reach this server. Defaults to http://localhost:{Port}.</summary>
    public string? PublicUrl { get; init; }

    /// <summary>Listen on localhost only (tests and local tools): nothing on the network can connect, and Windows never asks about the firewall.</summary>
    public bool LocalOnly { get; init; }

    /// <summary>A starter template applied once to a new server (built-in name or a .json path; see docs/hosting.md).</summary>
    public string? Template { get; init; }

    /// <summary>
    /// A one-time owner claim from the app that set up this server ("Rent a small server"), moved out of server.json on
    /// first start; or "generate": the server makes a claim code itself (server images), kept until the owner has joined.
    /// </summary>
    public string? OwnerClaim { get; init; }

    /// <summary>The web app that invite links open.</summary>
    public string AppUrl { get; init; } = "https://app.iskra.foo";

    [System.Text.Json.Serialization.JsonIgnore]
    public string EffectivePublicUrl => (PublicUrl ?? (Https.Enabled ? Https.DefaultUrl : $"http://localhost:{Port}")).TrimEnd('/');

    /// <summary>Largest file a member may upload. Generous by default: no Nitro here.</summary>
    public int MaxUploadMb { get; init; } = 512;

    /// <summary>How much each account may upload per day (admins and the owner aren't limited).</summary>
    public UploadQuotaSettings UploadQuota { get; init; } = new();

    public VoiceSettings Voice { get; init; } = new();

    public HttpsSettings Https { get; init; } = new();

    public InternetSettings Internet { get; init; } = new();

    public BackupSettings Backups { get; init; } = new();

    /// <summary>Backup buddies: how fast copies go to friends' servers (see Backups/BuddyBackupService).</summary>
    public Backups.BuddyBackupSettings BuddyBackups { get; init; } = new();

    public ImportSettings Import { get; init; } = new();

    /// <summary>Soundboard, emoji and sticker limits (Settings → Limits in the app, or here).</summary>
    public LimitsSettings Limits { get; init; } = new();

    /// <summary>Updating the standalone server from GitHub releases (Settings → Updates).</summary>
    public UpdateSettings Updates { get; init; } = new();

    /// <summary>How long data is kept (Settings → Security in the app, or here). 0 days means keep.</summary>
    public RetentionSettings Retention { get; init; } = new();

    /// <summary>Live captions: whether members' apps may get the speech model from this server.</summary>
    public CaptionsSettings Captions { get; init; } = new();

    /// <summary>Message translation: whether members' apps may get translation models from this server.</summary>
    public TranslateSettings Translate { get; init; } = new();

    /// <summary>Friends connecting without port forwarding, through a peer-to-peer tunnel (see PROTOCOL.md).</summary>
    public P2pSettings P2p { get; init; } = new();

    /// <summary>The bug inbox: only the server that receives Iskra's own bug reports turns this on (docs/hosting.md).</summary>
    public BugInboxConfig BugInbox { get; init; } = new();
}

/// <summary>server.json "BugInbox". Leave it off: apps send bug reports to the project's own server, not to yours.</summary>
public sealed record BugInboxConfig
{
    /// <summary>Take bug reports at POST /bug-reports and show the Bug inbox section. Off: 404, and no section.</summary>
    public bool Accept { get; init; }
}

/// <summary>
/// "Let friends connect without port forwarding": the owner's opt-in. The secret lives in p2p.key; the tunnel (in
/// the host's desktop app, or the iskra-p2p sidecar of a standalone server) reaches it on the localhost tunnel listener.
/// </summary>
public sealed record P2pSettings
{
    public bool Enabled { get; init; }
    /// <summary>The tunnel listener on 127.0.0.1. 0 = any free port (the bound one is written to p2p.port).</summary>
    public int TunnelPort { get; init; }
    /// <summary>The standalone server's tunnel program (iskra-p2p); null = next to iskra-server, or ISKRA_P2P_SIDECAR.</summary>
    public string? SidecarPath { get; init; }
    /// <summary>DHT bootstrap nodes ("host:port,host:port"); null = HyperDHT's public ones (a LocalOnly server needs a testnet here).</summary>
    public string? Bootstrap { get; init; }
    /// <summary>The DHT's UDP port; 0 = HyperDHT's usual 49737 (any port on a LocalOnly server).</summary>
    public int DhtPort { get; init; }
}

/// <summary>
/// Live captions run on members' devices; the speech model (Whisper base, about 78 MB) comes from this server, which
/// fetches it once from Hugging Face into models/ and serves it from there (docs/hosting.md).
/// </summary>
public sealed record CaptionsSettings
{
    /// <summary>Offer the model. Off: GET /models/... answers 404 and the apps say captions aren't offered here.</summary>
    public bool ModelDownload { get; init; } = true;
    /// <summary>Where to fetch it from instead of Hugging Face: a folder laid out like scripts/get-models.mjs writes it.</summary>
    public string? ModelSource { get; init; }
}

/// <summary>
/// Message translation runs on members' devices; the models (Mozilla's, about 15-26 MB per language and direction) come
/// from this server, which fetches each one from Mozilla the first time a member needs it (Server settings → Translation).
/// </summary>
public sealed record TranslateSettings
{
    /// <summary>Offer the models. Off (the default): GET /models/translate/... answers 404 and the apps say so.</summary>
    public bool Offer { get; init; }
    /// <summary>Where to fetch them from instead of Mozilla: a folder laid out like scripts/get-models.mjs --translate writes it.</summary>
    public string? ModelSource { get; init; }
}

/// <summary>"off": never look; "notify": tell the owner; "auto": also install in the daily window (Linux with systemd).</summary>
public sealed record UpdateSettings
{
    public string Mode { get; init; } = "notify";
    /// <summary>"stable" (releases not marked prerelease on GitHub) or "prerelease" (all of them).</summary>
    public string Channel { get; init; } = "stable";
    /// <summary>Local time (HH:mm) when automatic updates may start; they start within the hour after it.</summary>
    public string Window { get; init; } = "04:00";
    /// <summary>
    /// Only install a release whose build-provenance attestation verifies (Sigstore, signed by this repository's release
    /// workflows). On by default. It replaces RequireAttestation, which older versions wrote as false into every
    /// server.json and is no longer read, so those servers verify too; an owner turns it off here or in Settings → Updates.
    /// </summary>
    public bool VerifyAttestation { get; init; } = true;
}

/// <summary>Retention in days, enforced hourly by the RetentionSweeper. 0 keeps forever.</summary>
public sealed record RetentionSettings
{
    /// <summary>Channel messages, and end-to-end encrypted DM and group envelopes.</summary>
    public int MessagesDays { get; init; }
    /// <summary>Files in messages and DMs (avatars, emoji, stickers, sounds and event covers stay).</summary>
    public int UploadsDays { get; init; }
    public int AuditDays { get; init; } = 90;
    public int SecurityLogDays { get; init; } = 365;
    /// <summary>Also record IP addresses in the security log. Off by default: Iskra doesn't keep IP addresses otherwise.</summary>
    public bool SecurityLogIps { get; init; }
}

/// <summary>Size and length limits for expressions. 0 means no limit (uploads still can't exceed MaxUploadMb).</summary>
public sealed record LimitsSettings
{
    public int SoundMaxSeconds { get; init; }
    public int SoundMaxMb { get; init; }
    public int EmojiMaxKb { get; init; } = 1024;
    public int StickerMaxKb { get; init; } = 4096;
}

/// <summary>Automatic daily backups into the world's backups/ folder (unencrypted: the folder already holds the keys).</summary>
public sealed record BackupSettings
{
    public bool Enabled { get; init; } = true;
    /// <summary>How many daily backups to keep (1–30).</summary>
    public int Keep { get; init; } = 7;
    /// <summary>Also copy uploads into each daily backup. Off by default: they stay in uploads/ and only grow.</summary>
    public bool IncludeUploads { get; init; }
    /// <summary>
    /// Also copy each daily backup into this folder (absolute, outside the world folder, e.g. a USB stick or a network
    /// share), keeping the same number there. Null: no copies. The folder is never created: a stick that isn't
    /// mounted shows up as a failed copy instead of filling the system disk.
    /// </summary>
    public string? CopyTo { get; init; }
    /// <summary>
    /// The passphrase the copies in <see cref="CopyTo"/> are encrypted with (the .iskrabackup format). It protects the
    /// copy medium only: whoever can read this file can read the world and its key anyway. Never logged or sent.
    /// </summary>
    public string? CopyPassphrase { get; init; }

    /// <summary>The settings without the passphrase (only whether there is one), for logs and the security log.</summary>
    public object Redacted() => new { Enabled, Keep, IncludeUploads, CopyTo, CopyPassphraseSet = !string.IsNullOrEmpty(CopyPassphrase) };

    public override string ToString() => $"BackupSettings {{ Enabled = {Enabled}, Keep = {Keep}, IncludeUploads = {IncludeUploads}, CopyTo = {CopyTo}, CopyPassphrase = {(string.IsNullOrEmpty(CopyPassphrase) ? "none" : "set")} }}";
}

/// <summary>Imports (Discord exports).</summary>
public sealed record ImportSettings
{
    /// <summary>Largest export (zip or JSON) the owner may upload, in MB.</summary>
    public int MaxMb { get; init; } = 4096;
}

/// <summary>Daily upload allowance per account, in MB over any 24 hours. 0 means no limit.</summary>
public sealed record UploadQuotaSettings
{
    public int MemberMbPerDay { get; init; } = 10240;
    public int GuestMbPerDay { get; init; } = 1024;
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
    /// <summary>
    /// The address <see cref="Port"/> and <see cref="HttpPort"/> listen on, e.g. "127.0.0.1" behind a reverse proxy on
    /// this machine. Null: every interface (localhost with LocalOnly, which wins). PublicUrl is unaffected.
    /// </summary>
    public string? BindAddress { get; init; }
    /// <summary>
    /// <see cref="Port"/> takes only connections from <see cref="ProxyTrustedFrom"/> that start with a PROXY protocol
    /// header (v1 or v2), e.g. nginx stream with proxy_protocol on: the client's real address comes from the header.
    /// </summary>
    public bool ProxyProtocol { get; init; }
    /// <summary>The same for <see cref="HttpPort"/> (a stream proxy on port 80; nginx's http module can't send it).</summary>
    public bool HttpProxyProtocol { get; init; }
    /// <summary>Where a PROXY protocol header may come from (the proxy's own address). Default: this machine only.</summary>
    public string[] ProxyTrustedFrom { get; init; } = ["127.0.0.1", "::1"];

    [System.Text.Json.Serialization.JsonIgnore]
    public bool Enabled => Mode is "acme" or "files";

    [System.Text.Json.Serialization.JsonIgnore]
    public string DefaultUrl => $"https://{Domain}{(Port == 443 ? "" : $":{Port}")}";

    /// <summary>
    /// Bound to this machine only (as behind a proxy) but without the PROXY protocol header that says who connects:
    /// every client looks like 127.0.0.1, so they share one rate limit and the security log has no addresses.
    /// </summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool ClientsLookLocal => Enabled && !ProxyProtocol
        && BindAddress is { Length: > 0 } text && System.Net.IPAddress.TryParse(text, out var address) && System.Net.IPAddress.IsLoopback(address);
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

    /// <summary>LiveKit's embedded TURN server (only with P2p on), UDP. 0 = <see cref="RtcUdpPort"/> + 1.</summary>
    public int TurnUdpPort { get; init; }
    /// <summary>The ports TURN relays through (one per friend in voice).</summary>
    public int TurnRelayStart { get; init; } = 40000;
    public int TurnRelayEnd { get; init; } = 40200;

    [System.Text.Json.Serialization.JsonIgnore]
    public int EffectiveTurnUdpPort => TurnUdpPort > 0 ? TurnUdpPort : RtcUdpPort + 1;
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

    /// <summary>A signed "this server moved" notice, once the owner has published one (see MoveFeature).</summary>
    public Features.MoveNotice? Moved { get; set; }
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
        AtomicFile.CreatePrivateDirectory(path);
        AtomicFile.CreatePrivateDirectory(System.IO.Path.Combine(path, "uploads"));
        AtomicFile.TightenSecrets(path);

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
    private const UnixFileMode OwnerOnlyFile = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private const UnixFileMode OwnerOnlyDirectory = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    /// <summary>Files in a world folder that hold keys or a one-time owner link (relative to the world).</summary>
    public static readonly string[] SecretFiles =
        ["server.key", "vapid.json", "livekit.key", "owner-invite.txt", "owner-claim", "owner-claim-code.txt", "p2p.key", Path.Combine("certs", "acme-account.pem"), Path.Combine("certs", "key.pem")];

    /// <summary>Write to a temp file, then rename over the target, so a crash never leaves a half-written file.
    /// On Linux and macOS the file is readable by its owner only (0600), from the moment it exists.</summary>
    public static void WriteAllText(string path, string contents)
    {
        var temp = path + ".tmp";
        File.Delete(temp); // left over from a crash
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = OwnerOnlyFile;
        using (var stream = new FileStream(temp, options))
        using (var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false)))
            writer.Write(contents);
        File.Move(temp, path, overwrite: true);
    }

    /// <summary>Creates a directory only its owner can enter (0700 on Linux and macOS). Existing directories are left alone.</summary>
    public static void CreatePrivateDirectory(string path)
    {
        if (OperatingSystem.IsWindows()) Directory.CreateDirectory(path);
        else Directory.CreateDirectory(path, OwnerOnlyDirectory);
    }

    /// <summary>Older worlds may hold secrets written world-readable: make them owner-only (0600).</summary>
    public static void TightenSecrets(string worldPath)
    {
        if (OperatingSystem.IsWindows()) return;
        foreach (var name in SecretFiles)
        {
            var file = Path.Combine(worldPath, name);
            if (File.Exists(file) && (File.GetUnixFileMode(file) & ~OwnerOnlyFile) != 0) File.SetUnixFileMode(file, OwnerOnlyFile);
        }
    }
}

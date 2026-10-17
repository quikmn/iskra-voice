using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Updates;

/// <summary>Facts about how this server runs that decide what updating can do.</summary>
public sealed record UpdateEnvironment(string Current, string? Rid, bool ManagedByDesktop, bool AssumeGuard, string AppDir)
{
    public static UpdateEnvironment Detect(IConfiguration config) => Detect(config, Environment.GetEnvironmentVariable);

    public static UpdateEnvironment Detect(IConfiguration config, Func<string, string?> env) => new(
        Versions.IsValid(config["Updates:Version"]) ? config["Updates:Version"]! : Versions.Current,
        config["Updates:Rid"] is { Length: > 0 } rid ? rid : UpdatePicker.CurrentRid,
        // The desktop app says so (Updates__ManagedBy) and watches its servers (ISKRA_PARENT_PID); they update together
        // with the app. ISKRA_STOP_ON_STDIN_CLOSE alone doesn't count: any supervisor or test harness may use it.
        !string.IsNullOrEmpty(env("ISKRA_PARENT_PID")) || config["Updates:ManagedBy"] == "desktop",
        config.GetValue<bool>("Updates:AssumeGuard"),
        config["Updates:AppDir"] is { Length: > 0 } dir ? dir : AppContext.BaseDirectory);
}

public sealed record UpdateProgress(long Done, long Total);
public sealed record LatestRelease(string Version, string Url, long PublishedAt, bool Prerelease, bool Package);
public sealed record LastUpdate(string From, string To, bool Ok);
public sealed record AutoInstall(bool Possible, string? Reason);

/// <summary>Everything the owner sees in Settings → Updates (PROTOCOL.md, "Server updates").</summary>
public sealed record UpdateStatus(
    string Current, string Mode, string Channel, string Window, bool RequireAttestation,
    string? Managed, bool CanCheck, AutoInstall Auto, LatestRelease? Latest, string State, UpdateProgress? Progress,
    long? CheckedAt, string? Error, string? ErrorCode, LastUpdate? LastUpdate, bool? Attested);

/// <summary>
/// Looks for new releases on GitHub (every 6 hours, from 2 minutes after start), tells the owner, and in "auto" mode
/// installs them in the daily window when nobody is in voice. Installing: download the package and SHA256SUMS.txt,
/// check both checksums (and GitHub's attestation, if required), unpack, make sure the new binary runs here, swap it
/// in (<see cref="UpdateInstaller"/>), tell everyone, and exit with code 75 so systemd starts the new version.
/// Only on Linux under systemd with iskra-update-guard (which undoes an update that doesn't start); elsewhere it
/// only tells the owner. Servers run by the desktop app update with the app and never check.
/// </summary>
public sealed class UpdateService : BackgroundService
{
    public static readonly string[] Modes = ["off", "notify", "auto"];
    public static readonly string[] Channels = ["stable", "prerelease"];
    /// <summary>systemd's Restart=on-failure starts the server again; any non-zero code would, this one says why.</summary>
    public const int RestartExitCode = 75;
    private static readonly TimeSpan FirstCheck = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan CheckEvery = TimeSpan.FromHours(6);
    private static readonly TimeSpan ConfirmAfter = TimeSpan.FromSeconds(60);
    private const long MaxPackageBytes = 512L * 1024 * 1024;

    private readonly World _world;
    private readonly Hub _hub;
    private readonly IReleaseFeed _feed;
    private readonly VoiceRegistry _voice;
    private readonly TimeProvider _time;
    private readonly ILogger<UpdateService> _log;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly UpdateInstaller _installer;
    private readonly Lock _gate = new();
    private readonly SemaphoreSlim _checking = new(1, 1);
    private readonly DateTime _processStart;
    private readonly Lazy<bool> _writable;

    private IReadOnlyList<Release> _releases = [];
    private string _state = "idle";
    private UpdateProgress? _progress;
    private long? _checkedAt;
    private string? _error;
    /// <summary>Which error (apps translate it): see PROTOCOL.md.</summary>
    private string? _errorCode;
    private LastUpdate? _last;
    private bool? _attested;
    private DateTimeOffset _nextCheck;
    /// <summary>A version that failed to install automatically; auto mode leaves it alone (the owner can still try).</summary>
    private string? _failedVersion;
    private string? _published;
    private int _settled;

    public UpdateEnvironment Env { get; }

    /// <summary>What happens after a successful swap. Tests replace it; the real one stops the server with code 75.</summary>
    internal Action Restart { get; set; }

    /// <summary>Runs the unpacked binary to check it works here. Tests replace it.</summary>
    internal Func<string, string, CancellationToken, Task> CheckRuns { get; set; } = UpdateInstaller.CheckRunsAsync;

    /// <summary>Verifies the attestations GitHub gave for a package (bundles, name, SHA-256, version). Tests wrap it.</summary>
    internal Func<IReadOnlyList<string>?, string, string, string, CancellationToken, Task<AttestationResult>> VerifyAttestations { get; set; } =
        (bundles, name, sha, version, cancel) => Attestations.VerifyAsync(bundles, name, sha, version, Attestations.PinnedRoot, cancel);

    /// <summary>How long members are warned before the restart.</summary>
    internal TimeSpan RestartNotice { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>About how long the new version takes to start (systemd restarts it at once); a hint for apps.</summary>
    internal static readonly TimeSpan ExpectedDowntime = TimeSpan.FromSeconds(20);

    public UpdateService(World world, Hub hub, IReleaseFeed feed, VoiceRegistry voice, IConfiguration config, IHostApplicationLifetime lifetime,
        TimeProvider time, ILogger<UpdateService> log)
    {
        _world = world;
        _hub = hub;
        _feed = feed;
        _voice = voice;
        _time = time;
        _log = log;
        _lifetime = lifetime;
        Env = UpdateEnvironment.Detect(config);
        _installer = new UpdateInstaller(Env.AppDir);
        _writable = new Lazy<bool>(_installer.CanWrite);
        _processStart = Process.GetCurrentProcess().StartTime.ToUniversalTime();
        _nextCheck = time.GetUtcNow() + FirstCheck;
        Restart = () =>
        {
            Environment.ExitCode = RestartExitCode;
            lifetime.StopApplication();
        };
    }

    private UpdateSettings Settings => _world.Settings.Updates;

    /// <summary>Checking makes sense: a real release build that isn't run by the desktop app.</summary>
    public bool CanCheck => !Env.ManagedByDesktop && Versions.IsRelease(Env.Current);

    /// <summary>Whether this server can install updates itself, and if not, why ("desktop", "development", "platform", "guard", "readonly").</summary>
    public AutoInstall Auto()
    {
        if (Env.ManagedByDesktop) return new(false, "desktop");
        if (!Versions.IsRelease(Env.Current)) return new(false, "development");
        if (Env.Rid is not { } rid || !rid.StartsWith("linux-", StringComparison.Ordinal)) return new(false, "platform");
        if (!Env.AssumeGuard && !_installer.GuardRanBefore(_processStart)) return new(false, "guard");
        if (!_writable.Value) return new(false, "readonly");
        return new(true, null);
    }

    private Release? Newest() => Versions.IsValid(Env.Current) ? UpdatePicker.Newest(_releases, Env.Current, Settings.Channel) : null;

    public UpdateStatus Status()
    {
        var settings = Settings;
        lock (_gate)
        {
            var newest = CanCheck ? Newest() : null;
            return new UpdateStatus(
                Env.Current, Env.ManagedByDesktop ? "off" : settings.Mode, settings.Channel, settings.Window, settings.VerifyAttestation,
                Env.ManagedByDesktop ? "desktop" : null, CanCheck, Auto(),
                newest is null ? null : new LatestRelease(newest.Version, newest.PageUrl, newest.PublishedAt, newest.Prerelease,
                    UpdatePicker.Candidate(newest, Env.Rid) is not null),
                _state, _progress, _checkedAt, _error, _errorCode, _last, _attested);
        }
    }

    /// <summary>
    /// Asks GitHub now (the owner's "Check now" works in every mode; automatic checks stop when it's off).
    /// Returns false when it couldn't (rate limit, network); the error is in the status.
    /// </summary>
    public async Task<bool> CheckAsync(bool manual, CancellationToken cancel)
    {
        if (!CanCheck || !manual && Settings.Mode == "off") return false;
        // GitHub's limit is per IP: a quick second "Check now" reuses the answer we just got.
        if (manual && _checkedAt is { } at && _time.GetUtcNow().ToUnixTimeMilliseconds() - at < 30_000) return true;
        if (!await _checking.WaitAsync(0, cancel)) return true; // one is running already
        try
        {
            lock (_gate) if (_state == "idle" || _state == "failed") _state = "checking";
            Publish();
            var releases = await _feed.ListAsync(cancel);
            lock (_gate)
            {
                _releases = releases;
                _checkedAt = _time.GetUtcNow().ToUnixTimeMilliseconds();
                (_error, _errorCode) = (null, null);
            }
            _nextCheck = _time.GetUtcNow() + CheckEvery;
            if (Newest() is { } newest) _log.Info("update", "available", ("ver", newest.Version), ("from", Env.Current));
            return true;
        }
        catch (FeedRateLimitedException ex)
        {
            lock (_gate) (_error, _errorCode) = ("GitHub asked us to wait; checking again later.", "rate_limited");
            _nextCheck = ex.RetryAt > _time.GetUtcNow() ? ex.RetryAt : _time.GetUtcNow() + TimeSpan.FromMinutes(15);
            return false;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException or IOException && !cancel.IsCancellationRequested)
        {
            _log.Warn(ex, "UPS-110", "update", "failed", ("what", "check"));
            lock (_gate) (_error, _errorCode) = ("Couldn't reach GitHub to check for updates.", "unreachable");
            _nextCheck = _time.GetUtcNow() + TimeSpan.FromHours(1);
            return false;
        }
        finally
        {
            lock (_gate) if (_state == "checking") _state = "idle";
            _checking.Release();
            Publish();
        }
    }

    /// <summary>Starts installing the newest release (the owner's "Update now", or the window). Null when it started, else why not.</summary>
    public (string Code, string Message)? TryStartInstall(bool manual)
    {
        var auto = Auto();
        if (!auto.Possible) return ("bad_request", "This server can't update itself here.");
        var newest = Newest();
        if (newest is null) return ("bad_request", "This server is up to date.");
        if (UpdatePicker.Candidate(newest, Env.Rid) is not { } candidate) return ("bad_request", $"Iskra {newest.Version} has no server package for this system yet.");
        lock (_gate)
        {
            if (_state is not ("idle" or "failed")) return ("conflict", "An update is already being installed.");
            _state = "downloading";
            _progress = new UpdateProgress(0, candidate.Package.Size);
            (_error, _errorCode) = (null, null);
            _attested = null;
        }
        _log.Info("update", "start", ("ver", newest.Version), ("why", manual ? "owner" : "auto"));
        if (!manual) Log("update.install", new { from = Env.Current, to = newest.Version, auto = true }); // the owner's own is logged with their session
        Publish();
        _ = Task.Run(() => InstallAsync(candidate, _lifetime.ApplicationStopping));
        return null;
    }

    private async Task InstallAsync(UpdateCandidate candidate, CancellationToken cancel)
    {
        var version = candidate.Release.Version;
        var download = Path.Combine(_installer.UpdateDir, $"download-{version}.part");
        var staged = _installer.StagingDir(version);
        try
        {
            Directory.CreateDirectory(_installer.UpdateDir);
            var sumsPath = download + ".sums";
            await _feed.DownloadAsync(candidate.Sums, sumsPath, 256 * 1024, null, cancel);
            var sums = await File.ReadAllTextAsync(sumsPath, cancel);
            File.Delete(sumsPath);
            long lastShown = 0;
            await _feed.DownloadAsync(candidate.Package, download, MaxPackageBytes, done =>
            {
                if (done - lastShown < candidate.Package.Size / 50 && done != candidate.Package.Size) return;
                lastShown = done;
                lock (_gate) _progress = new UpdateProgress(done, candidate.Package.Size);
                Publish();
            }, cancel);

            Step("verifying");
            var sha = UpdateVerifier.Verify(download, candidate.Package, sums);
            // Signed build provenance: checked (and shown) always, required unless the owner turned it off.
            var attestation = await VerifyAttestations(await _feed.AttestationsAsync(sha, cancel), candidate.Package.Name, sha, version, cancel);
            lock (_gate) _attested = attestation switch { AttestationResult.Verified => true, AttestationResult.Unknown => null, _ => false };
            if (Settings.VerifyAttestation && attestation != AttestationResult.Verified)
                throw attestation switch
                {
                    AttestationResult.Missing => new UpdateVerificationException(
                        $"Iskra {version} has no build attestation on GitHub, so it isn't installed automatically. Install it by hand, or turn off the attestation check.",
                        "attestation_missing"),
                    AttestationResult.Invalid => new UpdateVerificationException(
                        "The package's build attestation doesn't verify (it isn't signed by Iskra's release workflow for this file), so it wasn't installed.",
                        "attestation_invalid"),
                    _ => new UpdateVerificationException("Couldn't get the package's build attestation from GitHub. It's tried again later.", "attestation_unknown"),
                };

            Step("installing");
            var exe = Env.Rid!.StartsWith("win-", StringComparison.Ordinal) ? "iskra-server.exe" : "iskra-server";
            var names = UpdateArchive.Extract(download, staged, exe);
            File.Delete(download);
            await CheckRuns(Path.Combine(staged, exe), version, cancel);
            _installer.Apply(staged, names, Env.Current, version);

            Step("restarting");
            _log.Info("update", "installed", ("ver", version));
            _hub.Broadcast(Frames.Event("server.restarting", new { reason = "update", version }));
            await Task.Delay(RestartNotice, _time, cancel);
            _hub.Restart.Expect("update", ExpectedDowntime);
            Restart();
        }
        catch (Exception ex) // runs on its own: anything that goes wrong ends as "failed", never as a stuck state
        {
            if (cancel.IsCancellationRequested) return;
            _log.Warn(ex, "UPS-120", "update", "failed", ("what", "install"), ("ver", version));
            lock (_gate)
            {
                _state = "failed";
                _progress = null;
                (_error, _errorCode) = ex switch
                {
                    UpdateVerificationException v => (ex.Message, v.Code),
                    HttpRequestException or TaskCanceledException => ("The download failed. Try again later.", "download"),
                    _ => ($"Couldn't install the update: {ex.Message}", "install"),
                };
                // GitHub not answering about attestations is passing: the next window tries again.
                if (_errorCode != "attestation_unknown") _failedVersion = version;
            }
            Log("update.failed", new { version, code = _errorCode });
            TryDelete(download);
            try { if (Directory.Exists(staged)) Directory.Delete(staged, recursive: true); } catch (IOException) { }
            Publish();
        }
    }

    private void Step(string state)
    {
        lock (_gate)
        {
            _state = state;
            if (state != "downloading") _progress = null;
        }
        Publish();
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { }
    }

    /// <summary>Whether <paramref name="localNow"/> falls in the hour starting at <paramref name="window"/> (HH:mm).</summary>
    public static bool InWindow(DateTimeOffset localNow, string window)
    {
        if (!TryParseWindow(window, out var start)) return false;
        var minutes = (localNow.Hour * 60 + localNow.Minute - (int)start.TotalMinutes + 24 * 60) % (24 * 60);
        return minutes < 60;
    }

    public static bool TryParseWindow(string? window, out TimeSpan start)
    {
        start = default;
        return window is { Length: 5 } && TimeSpan.TryParseExact(window, @"hh\:mm", CultureInfo.InvariantCulture, out start) && start < TimeSpan.FromDays(1);
    }

    /// <summary>Things to look at once on start: an update that was undone, or one that still has to confirm itself.</summary>
    internal async Task SettleAsync(CancellationToken cancel)
    {
        if (!CanCheck || Interlocked.Exchange(ref _settled, 1) == 1) return;
        if (_installer.TakeRolledBack() is { } undone)
        {
            _log.Warn("UPS-130", "update", "rolled-back", ("from", undone.From), ("to", undone.To));
            Log("update.rolledback", new { from = undone.From, to = undone.To });
            lock (_gate)
            {
                _last = new LastUpdate(undone.From, undone.To, false);
                _failedVersion = undone.To;
            }
        }
        else if (_installer.Last is { } last && last.To == Env.Current)
        {
            lock (_gate) _last ??= new LastUpdate(last.From, last.To, true);
        }
        if (_installer.Pending is { } pending && pending.To == Env.Current)
        {
            await Task.Delay(ConfirmAfter, _time, cancel);
            Confirm();
        }
    }

    /// <summary>This version has run long enough: keep it.</summary>
    internal void Confirm()
    {
        if (_installer.Confirm() is not { } done) return;
        _log.Info("update", "done", ("from", done.From), ("to", done.To));
        Log("update.installed", new { from = done.From, to = done.To });
        lock (_gate) _last = new LastUpdate(done.From, done.To, true);
        Publish();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            _ = SettleAsync(stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromMinutes(1), _time, stoppingToken);
                if (!CanCheck || Settings.Mode == "off") continue;
                try
                {
                    if (_time.GetUtcNow() >= _nextCheck) await CheckAsync(manual: false, stoppingToken);
                    if (Settings.Mode == "auto" && Newest() is { } newest && newest.Version != _failedVersion
                        && InWindow(TimeZoneInfo.ConvertTime(_time.GetUtcNow(), _time.LocalTimeZone), Settings.Window)
                        && _voice.InVoice == 0)
                        TryStartInstall(manual: false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // Never take the server down over an update check.
                    _log.Warn(ex, "UPS-110", "update", "failed", ("what", "check"));
                    _nextCheck = _time.GetUtcNow() + TimeSpan.FromHours(1);
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>Changes the owner's settings; null when saved, else what's wrong.</summary>
    public string? ChangeSettings(string? mode, string? channel, string? window, bool? requireAttestation)
    {
        if (Env.ManagedByDesktop) return "This server updates together with the desktop app.";
        if (mode is not null && !Modes.Contains(mode)) return "'mode' must be off, notify or auto.";
        if (channel is not null && !Channels.Contains(channel)) return "'channel' must be stable or prerelease.";
        if (window is not null && !TryParseWindow(window, out _)) return "'window' must be a time like 04:00.";
        if (mode == "auto" && Auto() is { Possible: false }) return "This server can't update itself here; choose notify instead.";
        var checkNow = mode is "notify" or "auto" && Settings.Mode == "off" || channel is not null && channel != Settings.Channel;
        _world.UpdateSettings(w => w with
        {
            Updates = w.Updates with
            {
                Mode = mode ?? w.Updates.Mode,
                Channel = channel ?? w.Updates.Channel,
                Window = window ?? w.Updates.Window,
                VerifyAttestation = requireAttestation ?? w.Updates.VerifyAttestation,
            },
        });
        if (checkNow && _checkedAt is null) _nextCheck = _time.GetUtcNow();
        Publish();
        return null;
    }

    /// <summary>Things the server did by itself go into the security log without an account.</summary>
    private void Log(string evt, object details) =>
        Features.SecurityLog.Record(_world.Store, _time.GetUtcNow().ToUnixTimeMilliseconds(), evt, details: details);

    /// <summary>Sends the status to the owner's sessions when it changed.</summary>
    private void Publish()
    {
        var status = Status();
        var json = JsonSerializer.Serialize(status, Json.Options);
        lock (_gate)
        {
            if (json == _published) return;
            _published = json;
        }
        var frame = Frames.Event("update.status", new { status });
        foreach (var session in _hub.Sessions)
        {
            if (session.CurrentMember() is { Role: Roles.Owner }) session.Send(frame);
        }
    }

    public override void Dispose()
    {
        _checking.Dispose();
        base.Dispose();
    }
}

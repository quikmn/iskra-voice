using System.Diagnostics;
using System.Formats.Tar;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Tests.Support;
using Iskra.Server.Updates;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class UpdateTests
{
    // ── versions, platforms, picking ──

    [Theory]
    [InlineData("2.0.0", "1.9.9", 1)]
    [InlineData("2.0.0-alpha.10", "2.0.0-alpha.9", 1)] // numeric, not text
    [InlineData("2.0.0", "2.0.0-alpha.10", 1)]          // a release beats its prereleases
    [InlineData("2.0.0-alpha.1", "2.0.0-beta.1", -1)]
    [InlineData("2.0.0-alpha", "2.0.0-alpha.1", -1)]
    [InlineData("2.0.0-alpha.1", "2.0.0-alpha.beta", -1)] // numbers before words
    [InlineData("1.10.0", "1.9.0", 1)]
    [InlineData("2.0.0-alpha.10", "2.0.0-alpha.10", 0)]
    public void Versions_compare_like_semver(string a, string b, int expected)
    {
        Assert.Equal(expected, Math.Sign(Versions.Compare(a, b)));
        Assert.Equal(-expected, Math.Sign(Versions.Compare(b, a)));
    }

    [Fact]
    public void Only_real_versions_count()
    {
        Assert.True(Versions.IsRelease("2.0.0-alpha.10"));
        Assert.False(Versions.IsRelease(Versions.Development));
        Assert.False(Versions.IsValid("2.0"));
        Assert.False(Versions.IsValid("02.0.0"));
        Assert.False(Versions.IsValid("2.0.0-"));
        Assert.False(Versions.IsValid("2.0.0 rm -rf"));
        Assert.Equal("2.0.0-alpha.10", Versions.FromTag("v2.0.0-alpha.10"));
        Assert.Null(Versions.FromTag("2.0.0"));
        Assert.Null(Versions.FromTag("v-final"));
        Assert.Equal(Versions.Development, Versions.Current); // test builds aren't releases
    }

    [Fact]
    public void Each_platform_gets_its_own_package()
    {
        Assert.Equal("linux-x64", UpdatePicker.Rid(OSPlatform.Linux, Architecture.X64));
        Assert.Equal("osx-arm64", UpdatePicker.Rid(OSPlatform.OSX, Architecture.Arm64));
        Assert.Equal("osx-x64", UpdatePicker.Rid(OSPlatform.OSX, Architecture.X64));
        Assert.Equal("win-x64", UpdatePicker.Rid(OSPlatform.Windows, Architecture.X64));
        Assert.Null(UpdatePicker.Rid(OSPlatform.Linux, Architecture.Arm64)); // not published
        Assert.Equal("iskra-server-2.0.0-linux-x64.tar.gz", UpdatePicker.PackageName("2.0.0", "linux-x64"));
        Assert.Equal("iskra-server-2.0.0-osx-arm64.tar.gz", UpdatePicker.PackageName("2.0.0", "osx-arm64"));
        Assert.Equal("iskra-server-2.0.0-win-x64.zip", UpdatePicker.PackageName("2.0.0", "win-x64"));

        var feed = new FakeReleaseFeed();
        var release = feed.Publish("2.1.0", [1, 2, 3], "linux-x64");
        Assert.NotNull(UpdatePicker.Candidate(release, "linux-x64"));
        Assert.Null(UpdatePicker.Candidate(release, "osx-arm64"));
        Assert.Null(UpdatePicker.Candidate(release, null));
        var noSums = release with { Assets = release.Assets.Where(a => a.Name != UpdatePicker.SumsFile).ToList() };
        Assert.Null(UpdatePicker.Candidate(noSums, "linux-x64"));
    }

    [Fact]
    public void The_newest_newer_release_on_the_channel_wins()
    {
        var feed = new FakeReleaseFeed();
        feed.Publish("2.0.0-alpha.9", [1]);
        feed.Publish("2.0.0-alpha.10", [1]);
        feed.Publish("2.0.0-alpha.11", [1], prerelease: true);
        Assert.Equal("2.0.0-alpha.10", UpdatePicker.Newest(feed.Releases, "2.0.0-alpha.9", "stable")!.Version);
        Assert.Equal("2.0.0-alpha.11", UpdatePicker.Newest(feed.Releases, "2.0.0-alpha.9", "prerelease")!.Version);
        Assert.Null(UpdatePicker.Newest(feed.Releases, "2.0.0-alpha.10", "stable"));
        Assert.Null(UpdatePicker.Newest(feed.Releases, "2.0.0", "prerelease")); // never older
    }

    [Fact]
    public void GitHub_release_lists_are_read_carefully()
    {
        var json = """
            [
              { "tag_name": "v2.0.0-alpha.11", "draft": true, "prerelease": false, "assets": [] },
              { "tag_name": "v2.0.0-alpha.10", "draft": false, "prerelease": false, "html_url": "https://evil.example/",
                "published_at": "2026-10-11T13:05:16Z",
                "assets": [ { "name": "SHA256SUMS.txt", "size": 10, "browser_download_url": "https://github.com/quikmn/iskra-voice/releases/download/v2.0.0-alpha.10/SHA256SUMS.txt",
                              "digest": "sha256:ABCDEF" } ] },
              { "tag_name": "nightly", "draft": false, "assets": [] },
              42
            ]
            """;
        using var doc = JsonDocument.Parse(json);
        var releases = GitHubReleaseFeed.Parse(doc);
        var release = Assert.Single(releases); // drafts and odd tags are skipped
        Assert.Equal("2.0.0-alpha.10", release.Version);
        Assert.Equal("https://github.com/quikmn/iskra-voice/releases/tag/v2.0.0-alpha.10", release.PageUrl); // never a link from the feed
        Assert.Equal("abcdef", release.Assets[0].Sha256);
        Assert.True(release.PublishedAt > 0);
    }

    [Fact]
    public async Task Downloads_only_come_from_the_repo_releases()
    {
        using var feed = new GitHubReleaseFeed(TimeProvider.System);
        var asset = new ReleaseAsset("x.tar.gz", "https://example.com/x.tar.gz", 1, null);
        await Assert.ThrowsAsync<InvalidDataException>(() => feed.DownloadAsync(asset, Path.GetTempFileName(), 10, null, CancellationToken.None));
    }

    // ── verification ──

    private static (string Path, ReleaseAsset Asset, string Sums) Package(byte[] bytes, string? digest = null, long? size = null)
    {
        var path = Path.GetTempFileName();
        File.WriteAllBytes(path, bytes);
        var sha = UpdateVerifier.Sha256File(path);
        var asset = new ReleaseAsset("iskra-server-2.1.0-linux-x64.tar.gz", "https://github.com/x", size ?? bytes.Length, digest ?? sha);
        return (path, asset, $"{new string('0', 64)}  other.zip\n{sha}  iskra-server-2.1.0-linux-x64.tar.gz\n");
    }

    [Fact]
    public void A_package_that_matches_its_checksums_passes()
    {
        var (path, asset, sums) = Package([1, 2, 3]);
        Assert.Equal(UpdateVerifier.Sha256File(path), UpdateVerifier.Verify(path, asset, sums));
        Assert.Equal(UpdateVerifier.Sha256File(path), UpdateVerifier.Verify(path, asset with { Sha256 = null }, sums)); // older releases have no digest
        Assert.Equal(UpdateVerifier.Sha256File(path), UpdateVerifier.Verify(path, asset, sums.Replace("  iskra", " *iskra").Replace("\n", "\r\n")));
    }

    [Fact]
    public void Verification_failures_are_refused()
    {
        var (path, asset, sums) = Package([1, 2, 3]);
        var other = new string('a', 64);
        Assert.Contains("doesn't match its checksum", Assert.Throws<UpdateVerificationException>(() =>
            UpdateVerifier.Verify(path, asset with { Sha256 = null }, $"{other}  {asset.Name}\n")).Message);
        Assert.Contains("GitHub's checksum", Assert.Throws<UpdateVerificationException>(() =>
            UpdateVerifier.Verify(path, asset with { Sha256 = other }, sums)).Message);
        Assert.Contains("doesn't list", Assert.Throws<UpdateVerificationException>(() =>
            UpdateVerifier.Verify(path, asset, $"{other}  something-else.tar.gz\n")).Message);
        Assert.Contains("wrong size", Assert.Throws<UpdateVerificationException>(() =>
            UpdateVerifier.Verify(path, asset with { Size = 4 }, sums)).Message);
        Assert.Contains("twice", Assert.Throws<UpdateVerificationException>(() =>
            UpdateVerifier.Verify(path, asset, sums + sums)).Message);
        Assert.Throws<UpdateVerificationException>(() => UpdateVerifier.Verify(path, asset, ""));
    }

    // ── unpacking ──

    internal static byte[] TarGz(params (string Name, string Text, TarEntryType Type)[] entries)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Fastest, leaveOpen: true))
        using (var tar = new TarWriter(gzip, TarEntryFormat.Pax))
        {
            tar.WriteEntry(new PaxTarEntry(TarEntryType.Directory, "./"));
            foreach (var (name, text, type) in entries)
            {
                var entry = new PaxTarEntry(type, name) { Mode = (UnixFileMode)0b111_101_101 };
                if (type == TarEntryType.SymbolicLink) entry.LinkName = "/etc/passwd";
                else if (type == TarEntryType.RegularFile) entry.DataStream = new MemoryStream(Encoding.UTF8.GetBytes(text));
                tar.WriteEntry(entry);
            }
        }
        return output.ToArray();
    }

    internal static byte[] ServerPackage(string marker = "new") =>
        TarGz(("./iskra-server", $"server {marker}", TarEntryType.RegularFile), ("./livekit-server", $"livekit {marker}", TarEntryType.RegularFile),
            ("./iskra-update-guard", "#!/bin/sh", TarEntryType.RegularFile));

    private static string TempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "iskra-update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string WriteTemp(byte[] bytes, string extension = ".tar.gz")
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + extension);
        File.WriteAllBytes(path, bytes);
        return path;
    }

    [Fact]
    public void Packages_unpack_plain_top_level_files_only()
    {
        var dest = Path.Combine(TempDir(), "staged");
        var names = UpdateArchive.Extract(WriteTemp(ServerPackage()), dest, "iskra-server");
        Assert.Equal(["iskra-server", "livekit-server", "iskra-update-guard"], names);
        Assert.Equal("server new", File.ReadAllText(Path.Combine(dest, "iskra-server")));
        if (!OperatingSystem.IsWindows()) Assert.True(File.GetUnixFileMode(Path.Combine(dest, "iskra-server")).HasFlag(UnixFileMode.UserExecute));

        foreach (var bad in new[]
                 {
                     TarGz(("./iskra-server", "x", TarEntryType.RegularFile), ("../escape", "x", TarEntryType.RegularFile)),
                     TarGz(("./iskra-server", "x", TarEntryType.RegularFile), ("sub/file", "x", TarEntryType.RegularFile)),
                     TarGz(("./iskra-server", "x", TarEntryType.RegularFile), ("/etc/cron.d/x", "x", TarEntryType.RegularFile)),
                     TarGz(("./iskra-server", "x", TarEntryType.RegularFile), ("./link", "", TarEntryType.SymbolicLink)),
                     TarGz(("./iskra-server", "x", TarEntryType.RegularFile), (".hidden", "x", TarEntryType.RegularFile)),
                     TarGz(("./livekit-server", "x", TarEntryType.RegularFile)), // no iskra-server
                 })
        {
            var outside = Path.Combine(Path.GetDirectoryName(dest)!, "escape");
            Assert.Throws<UpdateVerificationException>(() => UpdateArchive.Extract(WriteTemp(bad), dest, "iskra-server"));
            Assert.False(File.Exists(outside));
        }
        Assert.ThrowsAny<Exception>(() => UpdateArchive.Extract(WriteTemp([1, 2, 3]), dest, "iskra-server")); // not a package at all
    }

    [Fact]
    public void Windows_packages_unpack_too()
    {
        using var zipBytes = new MemoryStream();
        using (var zip = new ZipArchive(zipBytes, ZipArchiveMode.Create, leaveOpen: true))
        {
            using (var w = new StreamWriter(zip.CreateEntry("iskra-server.exe").Open())) w.Write("exe");
            using (var w = new StreamWriter(zip.CreateEntry("livekit-server.exe").Open())) w.Write("lk");
        }
        var dest = Path.Combine(TempDir(), "staged");
        Assert.Equal(["iskra-server.exe", "livekit-server.exe"], UpdateArchive.Extract(WriteTemp(zipBytes.ToArray(), ".zip"), dest, "iskra-server.exe"));
    }

    // ── swapping in and undoing ──

    private static string AppDir(string marker = "old")
    {
        var dir = TempDir();
        File.WriteAllText(Path.Combine(dir, "iskra-server"), $"server {marker}");
        File.WriteAllText(Path.Combine(dir, "livekit-server"), $"livekit {marker}");
        Directory.CreateDirectory(Path.Combine(dir, "world"));
        File.WriteAllText(Path.Combine(dir, "world", "server.key"), "secret");
        return dir;
    }

    [Fact]
    public void Swapping_in_keeps_the_previous_files_and_rollback_puts_them_back()
    {
        var app = AppDir();
        var installer = new UpdateInstaller(app);
        Assert.True(installer.CanWrite());
        var staged = installer.StagingDir("2.1.0");
        var names = UpdateArchive.Extract(WriteTemp(ServerPackage()), staged, "iskra-server");
        installer.Apply(staged, names, "2.0.0", "2.1.0");

        Assert.Equal("server new", File.ReadAllText(Path.Combine(app, "iskra-server")));
        Assert.Equal("server old", File.ReadAllText(Path.Combine(installer.PreviousDir, "iskra-server")));
        Assert.True(File.Exists(Path.Combine(app, "iskra-update-guard")));
        Assert.Equal(new UpdateMarker("2.0.0", "2.1.0"), installer.Pending);
        Assert.False(Directory.Exists(staged));

        installer.Rollback();
        Assert.Equal("server old", File.ReadAllText(Path.Combine(app, "iskra-server")));
        Assert.Equal("livekit old", File.ReadAllText(Path.Combine(app, "livekit-server")));
        Assert.False(File.Exists(Path.Combine(app, "iskra-update-guard"))); // new in that version: removed again
        Assert.Equal("secret", File.ReadAllText(Path.Combine(app, "world", "server.key"))); // the world is never touched
        Assert.Null(installer.Pending);
        Assert.Equal(new UpdateMarker("2.0.0", "2.1.0"), installer.TakeRolledBack());
        Assert.Null(installer.TakeRolledBack());
    }

    [Fact]
    public void A_confirmed_update_is_remembered()
    {
        var app = AppDir();
        var installer = new UpdateInstaller(app);
        var staged = installer.StagingDir("2.1.0");
        installer.Apply(staged, UpdateArchive.Extract(WriteTemp(ServerPackage()), staged, "iskra-server"), "2.0.0", "2.1.0");
        Assert.Equal(new UpdateMarker("2.0.0", "2.1.0"), installer.Confirm());
        Assert.Null(installer.Pending);
        Assert.Equal(new UpdateMarker("2.0.0", "2.1.0"), installer.Last);
        Assert.Null(installer.Confirm());
    }

    [Fact]
    public void The_guard_script_undoes_an_update_that_keeps_failing_to_start()
    {
        if (OperatingSystem.IsWindows() || !File.Exists("/bin/sh")) return; // a POSIX shell script (Linux CI runs it)
        var app = AppDir();
        var guard = Path.Combine(app, "iskra-update-guard");
        File.Copy(Path.Combine(RepoRoot(), "server", "deploy", "iskra-update-guard"), guard);
        File.SetUnixFileMode(guard, (UnixFileMode)0b111_101_101);
        var installer = new UpdateInstaller(app);
        var staged = installer.StagingDir("2.1.0");
        installer.Apply(staged, UpdateArchive.Extract(WriteTemp(TarGz(("./iskra-server", "server new", TarEntryType.RegularFile), ("./extra", "x", TarEntryType.RegularFile))), staged, "iskra-server"),
            "2.0.0", "2.1.0");

        void RunGuard()
        {
            using var p = Process.Start(new ProcessStartInfo("/bin/sh", [guard]) { RedirectStandardError = true })!;
            p.WaitForExit();
            Assert.Equal(0, p.ExitCode);
        }
        for (var i = 0; i < 3; i++)
        {
            RunGuard(); // three starts that never confirm
            Assert.Equal("server new", File.ReadAllText(Path.Combine(app, "iskra-server")));
        }
        Assert.True(installer.GuardRanBefore(DateTime.UtcNow));
        RunGuard();
        Assert.Equal("server old", File.ReadAllText(Path.Combine(app, "iskra-server")));
        Assert.False(File.Exists(Path.Combine(app, "extra")));
        Assert.Null(installer.Pending);
        Assert.Equal(new UpdateMarker("2.0.0", "2.1.0"), installer.TakeRolledBack());
        RunGuard(); // nothing pending: nothing happens
        Assert.Equal("server old", File.ReadAllText(Path.Combine(app, "iskra-server")));
    }

    private static string RepoRoot() => Path.GetDirectoryName(Path.GetDirectoryName(Repo.ProtocolFile("PROTOCOL.md")))!;

    [Theory]
    [InlineData("04:00", 4, 0, true)]
    [InlineData("04:00", 4, 59, true)]
    [InlineData("04:00", 5, 0, false)]
    [InlineData("04:00", 3, 59, false)]
    [InlineData("23:30", 0, 15, true)] // over midnight
    [InlineData("bad", 4, 0, false)]
    public void The_window_is_the_hour_after_its_start(string window, int hour, int minute, bool inside)
    {
        Assert.Equal(inside, UpdateService.InWindow(new DateTimeOffset(2026, 10, 11, hour, minute, 0, TimeSpan.Zero), window));
    }

    // ── over the protocol ──

    private static IskraServer Server(string version = "2.0.0", string rid = "linux-x64", string? appDir = null, bool guard = true, string? managedBy = null)
    {
        var settings = new Dictionary<string, string> { ["Updates:Version"] = version, ["Updates:Rid"] = rid, ["Updates:AssumeGuard"] = guard.ToString() };
        settings["Updates:AppDir"] = appDir ?? AppDir(); // never the test binaries' folder
        if (managedBy is not null) settings["Updates:ManagedBy"] = managedBy;
        var server = new IskraServer { Settings = settings };
        server.Services.GetRequiredService<UpdateService>().VerifyAttestations = FakeReleaseFeed.Verify;
        return server;
    }

    [Fact]
    public async Task Only_the_owner_sees_and_manages_updates()
    {
        using var server = Server();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        foreach (var type in new[] { "update.status", "update.check", "update.install", "update.settings" })
            Assert.Equal("forbidden", (await admin.RequestAsync(type, new { mode = "off" })).ErrorCode());

        var status = (await owner.RequestAsync("update.status")).Body().GetProperty("status");
        Assert.Equal("2.0.0", status.GetProperty("current").GetString());
        Assert.Equal("notify", status.GetProperty("mode").GetString()); // the default: tell, don't install
        Assert.Equal(JsonValueKind.Null, status.GetProperty("latest").ValueKind);
        Assert.Equal(0, server.Releases.Lists); // nothing asked GitHub yet
    }

    [Fact]
    public async Task Check_now_finds_a_new_release_and_tells_the_owner()
    {
        using var server = Server();
        server.Releases.Publish("2.1.0", ServerPackage());
        server.Releases.Publish("2.2.0-alpha.1", ServerPackage(), prerelease: true);
        using var owner = await server.JoinAsync("Owner", "owner");

        var status = (await owner.RequestAsync("update.check")).Body().GetProperty("status");
        var latest = status.GetProperty("latest");
        Assert.Equal("2.1.0", latest.GetProperty("version").GetString());
        Assert.True(latest.GetProperty("package").GetBoolean());
        Assert.Equal("https://github.com/quikmn/iskra-voice/releases/tag/v2.1.0", latest.GetProperty("url").GetString());
        Assert.True(status.GetProperty("checkedAt").GetInt64() > 0);
        Assert.Equal(1, server.Releases.Lists);

        // A second "Check now" right away reuses the answer (GitHub's limit is per IP).
        await owner.RequestAsync("update.check");
        Assert.Equal(1, server.Releases.Lists);

        // The prerelease channel sees prereleases; the owner's other sessions hear about it.
        var changed = (await owner.RequestAsync("update.settings", new { channel = "prerelease" })).Body().GetProperty("status");
        Assert.Equal("2.2.0-alpha.1", changed.GetProperty("latest").GetProperty("version").GetString());
        var json = JsonNode.Parse(File.ReadAllText(Path.Combine(server.WorldPath, "server.json")))!;
        Assert.Equal("prerelease", json["Updates"]!["Channel"]!.GetValue<string>());

        // Checks and setting changes are in the security log, with who did them.
        var check = server.World.Store.SecurityEvents("update.check", null, null, 10).Last(); // newest first
        Assert.Equal(owner.Key, check.Account);
        Assert.Contains("2.1.0", check.Details);
        var changed2 = Assert.Single(server.World.Store.SecurityEvents("update.settings", null, null, 10));
        Assert.Contains("prerelease", changed2.Details);
        while ((await owner.EventAsync("update.status")).Body().GetProperty("status").GetProperty("channel").GetString() != "prerelease") { }
    }

    [Fact]
    public async Task A_rate_limited_check_says_so()
    {
        using var server = Server();
        server.Releases.RateLimitedUntil = DateTimeOffset.UtcNow.AddMinutes(30);
        using var owner = await server.JoinAsync("Owner", "owner");
        var status = (await owner.RequestAsync("update.check")).Body().GetProperty("status");
        Assert.Contains("wait", status.GetProperty("error").GetString());
        Assert.Equal("idle", status.GetProperty("state").GetString());
    }

    [Fact]
    public async Task Settings_are_checked()
    {
        using var server = Server();
        using var owner = await server.JoinAsync("Owner", "owner");
        Assert.Equal("bad_request", (await owner.RequestAsync("update.settings", new { mode = "sometimes" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("update.settings", new { channel = "nightly" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("update.settings", new { window = "25:00" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("update.settings", new { window = "4:00" })).ErrorCode());
        // Attestations are checked by default; the owner can turn that off (and it's logged).
        Assert.True((await owner.RequestAsync("update.status")).Body().GetProperty("status").GetProperty("requireAttestation").GetBoolean());
        var status = (await owner.RequestAsync("update.settings", new { mode = "auto", window = "03:30", requireAttestation = false })).Body().GetProperty("status");
        Assert.Equal("auto", status.GetProperty("mode").GetString());
        Assert.Equal("03:30", status.GetProperty("window").GetString());
        Assert.False(status.GetProperty("requireAttestation").GetBoolean());
        Assert.Equal("03:30", server.World.Settings.Updates.Window);
        Assert.False(server.World.Settings.Updates.VerifyAttestation);
        Assert.Contains("\"verifyAttestation\":false", server.World.Store.SecurityEvents("update.settings", null, null, 10).First().Details);
    }

    [Theory]
    [InlineData("win-x64", true, "platform")]
    [InlineData("osx-arm64", true, "platform")]
    [InlineData("linux-x64", false, "guard")]
    public async Task Automatic_updates_need_linux_with_the_guard(string rid, bool guard, string reason)
    {
        using var server = Server(rid: rid, guard: guard, appDir: AppDir());
        server.Releases.Publish("2.1.0", ServerPackage(), rid);
        using var owner = await server.JoinAsync("Owner", "owner");
        var status = (await owner.RequestAsync("update.check")).Body().GetProperty("status");
        Assert.False(status.GetProperty("auto").GetProperty("possible").GetBoolean());
        Assert.Equal(reason, status.GetProperty("auto").GetProperty("reason").GetString());
        Assert.Equal("2.1.0", status.GetProperty("latest").GetProperty("version").GetString()); // still told about it
        Assert.Equal("bad_request", (await owner.RequestAsync("update.settings", new { mode = "auto" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("update.install")).ErrorCode());
    }

    [Fact]
    public async Task Servers_run_by_the_desktop_app_never_update_themselves()
    {
        using var server = Server(managedBy: "desktop");
        server.Releases.Publish("2.1.0", ServerPackage());
        using var owner = await server.JoinAsync("Owner", "owner");
        var status = (await owner.RequestAsync("update.check")).Body().GetProperty("status");
        Assert.Equal("desktop", status.GetProperty("managed").GetString());
        Assert.Equal("off", status.GetProperty("mode").GetString());
        Assert.False(status.GetProperty("canCheck").GetBoolean());
        Assert.Equal(JsonValueKind.Null, status.GetProperty("latest").ValueKind);
        Assert.Equal(0, server.Releases.Lists);
        Assert.Equal("bad_request", (await owner.RequestAsync("update.settings", new { mode = "notify" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("update.install")).ErrorCode());
    }

    [Fact]
    public void Only_the_desktop_app_counts_as_managing_updates()
    {
        static bool Managed(Dictionary<string, string?> config, Dictionary<string, string> env) =>
            UpdateEnvironment.Detect(Microsoft.Extensions.Configuration.MemoryConfigurationBuilderExtensions.AddInMemoryCollection(new Microsoft.Extensions.Configuration.ConfigurationBuilder(), config).Build(),
                name => env.GetValueOrDefault(name)).ManagedByDesktop;

        // A standalone server under a supervisor (or a test harness) that stops it by closing stdin updates on its own.
        Assert.False(Managed([], new() { ["ISKRA_STOP_ON_STDIN_CLOSE"] = "1" }));
        Assert.False(Managed([], []));
        Assert.True(Managed([], new() { ["ISKRA_PARENT_PID"] = "1234", ["ISKRA_STOP_ON_STDIN_CLOSE"] = "1" }));
        Assert.True(Managed(new() { ["Updates:ManagedBy"] = "desktop" }, []));
    }

    [Fact]
    public async Task Development_builds_never_check()
    {
        using var server = new IskraServer();
        server.Releases.Publish("2.1.0", ServerPackage());
        using var owner = await server.JoinAsync("Owner", "owner");
        var status = (await owner.RequestAsync("update.check")).Body().GetProperty("status");
        Assert.Equal(Versions.Development, status.GetProperty("current").GetString());
        Assert.False(status.GetProperty("canCheck").GetBoolean());
        Assert.Equal("development", status.GetProperty("auto").GetProperty("reason").GetString());
        Assert.Equal(0, server.Releases.Lists);
    }

    private static async Task<JsonElement> WaitForState(User owner, params string[] states)
    {
        for (var i = 0; i < 50; i++)
        {
            var status = (await owner.EventAsync("update.status")).Body().GetProperty("status");
            if (states.Contains(status.GetProperty("state").GetString())) return status;
        }
        throw new Xunit.Sdk.XunitException($"never reached {string.Join("/", states)}");
    }

    [Fact]
    public async Task Update_now_downloads_verifies_swaps_and_restarts()
    {
        var app = AppDir();
        using var server = Server(appDir: app);
        server.Releases.Publish("2.1.0", ServerPackage());
        var updates = server.Services.GetRequiredService<UpdateService>();
        var restarted = new TaskCompletionSource();
        var ran = new List<string>();
        updates.Restart = () => restarted.TrySetResult();
        updates.RestartNotice = TimeSpan.FromMilliseconds(50);
        updates.CheckRuns = (exe, version, _) => { ran.Add($"{Path.GetFileName(exe)} {version}"); return Task.CompletedTask; };
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");

        await owner.RequestAsync("update.check");
        Assert.Equal("downloading", (await owner.RequestAsync("update.install")).Body().GetProperty("status").GetProperty("state").GetString());
        var restarting = (await member.EventAsync("server.restarting")).Body();
        Assert.Equal("update", restarting.GetProperty("reason").GetString());
        Assert.Equal("2.1.0", restarting.GetProperty("version").GetString());
        await restarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // Sessions are closed with 1012 and this reason: apps know it's an update and about how long it takes.
        Assert.Equal("""{"v":1,"reason":"update","etaMs":20000}""", server.Services.GetRequiredService<Iskra.Server.Sessions.Hub>().Restart.Reason);

        Assert.Equal(["iskra-server 2.1.0"], ran); // the new binary was asked for its version before the swap
        Assert.Equal("server new", File.ReadAllText(Path.Combine(app, "iskra-server")));
        Assert.Equal("server old", File.ReadAllText(Path.Combine(app, ".update", "previous", "iskra-server")));
        Assert.Equal(new UpdateMarker("2.0.0", "2.1.0"), new UpdateInstaller(app).Pending);
        await member.NoEventAsync("update.status"); // only the owner gets the details
        var install = Assert.Single(server.World.Store.SecurityEvents("update.install", null, null, 10));
        Assert.Equal(owner.Key, install.Account);
        Assert.Contains("2.1.0", install.Details);
    }

    [Theory]
    [InlineData("checksum")]
    [InlineData("digest")]
    [InlineData("attestation")]
    [InlineData("binary")]
    public async Task A_package_that_fails_a_check_is_never_swapped_in(string failure)
    {
        var app = AppDir();
        using var server = Server(appDir: app);
        var package = ServerPackage();
        server.Releases.Publish("2.1.0", package,
            sums: failure == "checksum" ? $"{new string('b', 64)}  {UpdatePicker.PackageName("2.1.0", "linux-x64")}\n" : null,
            digest: failure == "digest" ? new string('c', 64) : null, attested: failure != "attestation");
        var updates = server.Services.GetRequiredService<UpdateService>();
        var restarted = false;
        updates.Restart = () => restarted = true;
        updates.CheckRuns = (_, _, _) => failure == "binary" ? throw new UpdateVerificationException("The new version doesn't run on this machine.", "wont_run") : Task.CompletedTask;
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");

        await owner.RequestAsync("update.check");
        await owner.RequestAsync("update.install");
        var status = await WaitForState(owner, "failed");
        var error = status.GetProperty("error").GetString()!;
        Assert.Equal(failure switch
        {
            "checksum" => "checksum",
            "digest" => "github_checksum",
            "attestation" => "attestation_missing",
            _ => "wont_run",
        }, status.GetProperty("errorCode").GetString());
        Assert.Contains(failure == "binary" ? "wont_run" : failure == "attestation" ? "attestation_missing" : "checksum",
            server.World.Store.SecurityEvents("update.failed", null, null, 10).Single().Details);
        Assert.Contains(failure switch
        {
            "checksum" => "checksum in SHA256SUMS.txt",
            "digest" => "GitHub's checksum",
            "attestation" => "attestation",
            _ => "doesn't run",
        }, error);
        Assert.Equal("server old", File.ReadAllText(Path.Combine(app, "iskra-server")));
        Assert.Null(new UpdateInstaller(app).Pending);
        Assert.False(restarted);
        await member.NoEventAsync("server.restarting");
        Assert.Empty(Directory.GetFiles(Path.Combine(app, ".update"), "download-*"));

        // The owner can try again (here it fails the same way).
        Assert.Equal("result", (await owner.RequestAsync("update.install")).Type());
    }

    [Fact]
    public async Task An_attested_package_passes_by_default()
    {
        var app = AppDir();
        using var server = Server(appDir: app);
        server.Releases.Publish("2.1.0", ServerPackage());
        var updates = server.Services.GetRequiredService<UpdateService>();
        var restarted = new TaskCompletionSource();
        updates.Restart = () => restarted.TrySetResult();
        updates.RestartNotice = TimeSpan.Zero;
        updates.CheckRuns = (_, _, _) => Task.CompletedTask;
        using var owner = await server.JoinAsync("Owner", "owner");
        await owner.RequestAsync("update.check");
        await owner.RequestAsync("update.install");
        await restarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(updates.Status().Attested);
        Assert.True(updates.Status().RequireAttestation);
    }

    [Theory]
    [InlineData("foreign", "attestation_invalid")] // real Sigstore bundles, but for another file
    [InlineData("junk", "attestation_invalid")]
    [InlineData("unreachable", "attestation_unknown")]
    public async Task Attestations_that_dont_verify_stop_the_update_and_turning_the_check_off_lets_it_through(string kind, string code)
    {
        var app = AppDir();
        using var server = Server(appDir: app);
        var package = ServerPackage();
        server.Releases.Publish("2.1.0", package, attested: false);
        var sha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(package));
        if (kind == "foreign") server.Releases.Bundles[sha] = AttestationTests.RealBundles();
        if (kind == "junk") server.Releases.Bundles[sha] = ["{}", "not json", """{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}"""];
        server.Releases.AttestationsUnreachable = kind == "unreachable";
        var updates = server.Services.GetRequiredService<UpdateService>();
        var restarted = new TaskCompletionSource();
        updates.Restart = () => restarted.TrySetResult();
        updates.RestartNotice = TimeSpan.Zero;
        updates.CheckRuns = (_, _, _) => Task.CompletedTask;
        using var owner = await server.JoinAsync("Owner", "owner");
        await owner.RequestAsync("update.check");
        await owner.RequestAsync("update.install");
        var status = await WaitForState(owner, "failed");
        Assert.Equal(code, status.GetProperty("errorCode").GetString());
        Assert.Equal("server old", File.ReadAllText(Path.Combine(app, "iskra-server")));
        Assert.Contains(code, server.World.Store.SecurityEvents("update.failed", null, null, 10).Single().Details);

        // The owner's explicit choice: install without it (the status still says it isn't attested).
        await owner.RequestAsync("update.settings", new { requireAttestation = false });
        await owner.RequestAsync("update.install");
        await restarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("server new", File.ReadAllText(Path.Combine(app, "iskra-server")));
        Assert.Equal(kind == "unreachable" ? null : false, updates.Status().Attested);
    }

    [Fact]
    public void Older_server_json_files_verify_attestations_and_an_explicit_off_stays_off()
    {
        // Older versions wrote "RequireAttestation": false into every server.json: that's no longer read.
        foreach (var (json, expected) in new[]
        {
            ("""{ "Updates": { "Mode": "auto", "RequireAttestation": false } }""", true),
            ("""{ "Updates": { "Mode": "auto", "RequireAttestation": true } }""", true),
            ("""{ "Name": "x" }""", true),
            ("""{ "Updates": { "Mode": "auto", "VerifyAttestation": false } }""", false),
        })
        {
            var dir = Path.Combine(Path.GetTempPath(), "iskra-world-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            try
            {
                File.WriteAllText(Path.Combine(dir, "server.json"), json);
                using (var world = Iskra.Server.Storage.World.OpenOrCreate(dir))
                {
                    Assert.Equal(expected, world.Settings.Updates.VerifyAttestation);
                    // The next save writes the new name and drops the old one.
                    world.UpdateSettings(s => s with { Updates = s.Updates with { Window = "05:00" } });
                }
                var saved = JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "server.json")))!["Updates"]!.AsObject();
                Assert.Equal(expected, saved["VerifyAttestation"]!.GetValue<bool>());
                Assert.False(saved.ContainsKey("RequireAttestation"));
            }
            finally
            {
                Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
                try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
            }
        }
    }

    [Fact]
    public async Task After_a_restart_the_new_version_confirms_itself_and_an_undone_update_is_reported()
    {
        var app = AppDir();
        var installer = new UpdateInstaller(app);
        var staged = installer.StagingDir("2.1.0");
        installer.Apply(staged, UpdateArchive.Extract(WriteTemp(ServerPackage()), staged, "iskra-server"), "2.0.0", "2.1.0");

        using (var server = Server(version: "2.1.0", appDir: app))
        {
            using var owner = await server.JoinAsync("Owner", "owner");
            server.Services.GetRequiredService<UpdateService>().Confirm();
            var last = (await owner.RequestAsync("update.status")).Body().GetProperty("status").GetProperty("lastUpdate");
            Assert.Equal("2.0.0", last.GetProperty("from").GetString());
            Assert.True(last.GetProperty("ok").GetBoolean());
            Assert.Null(installer.Pending);
            Assert.Single(server.World.Store.SecurityEvents("update.installed", null, null, 10));
        }

        // Another update that the guard undid: the owner hears about it, and auto mode leaves that version alone.
        staged = installer.StagingDir("2.2.0");
        installer.Apply(staged, UpdateArchive.Extract(WriteTemp(ServerPackage("newer")), staged, "iskra-server"), "2.1.0", "2.2.0");
        installer.Rollback();
        using (var server = Server(version: "2.1.0", appDir: app))
        {
            using var owner = await server.JoinAsync("Owner", "owner");
            await server.Services.GetRequiredService<UpdateService>().SettleAsync(CancellationToken.None);
            var last = (await owner.RequestAsync("update.status")).Body().GetProperty("status").GetProperty("lastUpdate");
            Assert.Equal("2.2.0", last.GetProperty("to").GetString());
            Assert.False(last.GetProperty("ok").GetBoolean());
            var undone = Assert.Single(server.World.Store.SecurityEvents("update.rolledback", null, null, 10));
            Assert.Null(undone.Account); // the server did it, not a person
        }
    }

    // ── health ──

    [Fact]
    public async Task Health_says_whether_it_works_and_nothing_more()
    {
        using var server = Server(version: "2.1.0");
        using var http = server.CreateClient();
        using var response = await http.GetAsync("/health");
        Assert.True(response.IsSuccessStatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal(1, body.GetProperty("iskra").GetInt32());
        Assert.Equal("ok", body.GetProperty("status").GetString());
        Assert.Equal("2.1.0", body.GetProperty("version").GetString());
        Assert.True(body.GetProperty("uptimeSeconds").GetInt64() >= 0);
        Assert.Equal("up", body.GetProperty("voice").GetString());
        Assert.Equal(["iskra", "status", "version", "uptimeSeconds", "voice"], body.EnumerateObject().Select(p => p.Name).ToArray());

        server.Voice.Available = false;
        body = JsonDocument.Parse(await http.GetStringAsync("/health")).RootElement;
        Assert.Equal("down", body.GetProperty("voice").GetString());
    }
}

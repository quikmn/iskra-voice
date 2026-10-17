using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Iskra.Server.Hosting;
using Iskra.Server.Storage;
using Iskra.Server.Logging;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Iskra.Server.Tests;

/// <summary>
/// The standalone server's tunnel program (iskra-p2p) is started, watched and stopped like LiveKit. A small fake
/// stands in for it here (run with node; skipped without node): it reports a status line, notes "sync" and the
/// environment it got, and writes a file when its stdin ends. The real program is tested in desktop/ and through the
/// server in client/interop/p2p-sidecar.test.ts.
/// </summary>
public class P2pSidecarTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "iskra-p2p-sidecar-" + Guid.NewGuid().ToString("N"));
    private readonly List<Process> _processes = [];

    private const string FakeSidecar = """
        const fs = require('fs'), path = require('path')
        const world = process.argv[2]
        const note = (name, text) => fs.appendFileSync(path.join(world, name), text)
        note('fake-runs', 'x')
        const runs = fs.readFileSync(path.join(world, 'fake-runs'), 'utf8').length
        fs.writeFileSync(path.join(world, 'fake-env'), JSON.stringify({ local: process.env.ISKRA_LOCAL_ONLY ?? null,
          bootstrap: process.env.ISKRA_P2P_BOOTSTRAP ?? null, port: process.env.ISKRA_P2P_PORT ?? null, pid: process.pid }))
        if (fs.existsSync(path.join(world, 'fake-crash')) && runs === 1) {
          console.log(JSON.stringify({ status: { state: 'starting', hostKey: null, nat: null, connections: 0 } }))
          process.exit(3)
        }
        console.log('not json, ignored')
        console.log(JSON.stringify({ status: { state: 'ready', nat: { firewalled: true, randomized: false, publicAddress: '203.0.113.5:49737' }, connections: 2 } }))
        let buffered = ''
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', (d) => {
          buffered += d
          if (buffered.includes('sync\n')) {
            buffered = ''
            note('fake-syncs', 's')
            console.log(JSON.stringify({ status: { state: 'ready', nat: null, connections: 0 } }))
          }
        })
        process.stdin.on('end', () => { note('fake-stopped', 'clean'); process.exit(0) })
        """;

    public P2pSidecarTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        foreach (var p in _processes)
        {
            try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            p.Dispose();
        }
        for (var i = 0; i < 20; i++)
        {
            try
            {
                Directory.Delete(_dir, recursive: true);
                return;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { Thread.Sleep(100); }
        }
    }

    private static bool HasNode()
    {
        try
        {
            using var node = Process.Start(new ProcessStartInfo("node", "--version") { RedirectStandardOutput = true, UseShellExecute = false });
            node!.WaitForExit(10_000);
            return node.ExitCode == 0;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    private string Fake()
    {
        var file = Path.Combine(_dir, "fake-sidecar.js");
        File.WriteAllText(file, FakeSidecar);
        return file;
    }

    private World NewWorld(string name, Func<P2pSettings, P2pSettings> p2p)
    {
        var world = World.OpenOrCreate(Path.Combine(_dir, name));
        world.UpdateSettings(s => s with { LocalOnly = true, P2p = p2p(s.P2p) });
        return world;
    }

    private static async Task Until(Func<bool> check, string what, int ms = 15_000)
    {
        for (var waited = 0; !check(); waited += 50)
        {
            if (waited > ms) throw new Xunit.Sdk.XunitException($"Timed out waiting for {what}");
            await Task.Delay(50);
        }
    }

    private static string? Read(World world, string name)
    {
        var file = Path.Combine(world.Path, name);
        try { return File.Exists(file) ? File.ReadAllText(file) : null; } catch (IOException) { return null; }
    }

    private static bool Gone(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return p.HasExited;
        }
        catch (ArgumentException)
        {
            return true;
        }
    }

    [Fact]
    public async Task Off_until_turned_on_and_says_so_when_the_program_is_missing()
    {
        using var world = NewWorld("missing", p => p with { SidecarPath = Path.Combine(_dir, "no-such-iskra-p2p") });
        using var sidecar = new P2pSidecar(world, NullLogger<P2pSidecar>.Instance, null, hostedByApp: false);
        await sidecar.StartAsync(CancellationToken.None);
        await Until(() => sidecar.Current.State == "off", "off");

        world.UpdateSettings(s => s with { P2p = s.P2p with { Enabled = true } });
        sidecar.Changed();
        await Until(() => sidecar.Current.State == "missing", "missing");
        Assert.Equal(0, sidecar.Starts);
        await sidecar.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Runs_while_on_reports_its_status_follows_a_new_secret_and_stops_cleanly_when_turned_off()
    {
        Assert.SkipUnless(HasNode(), "node isn't installed");
        using var world = NewWorld("on", p => p with { Enabled = true, SidecarPath = Fake(), Bootstrap = "127.0.0.1:49999", DhtPort = 50001 });
        using var sidecar = new P2pSidecar(world, NullLogger<P2pSidecar>.Instance, null, hostedByApp: false);
        await sidecar.StartAsync(CancellationToken.None);

        await Until(() => sidecar.Current.State == "ready", "ready");
        var view = JsonSerializer.SerializeToElement(sidecar.View(), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal("ready", view.GetProperty("state").GetString());
        Assert.Equal(2, view.GetProperty("connections").GetInt32());
        Assert.True(view.GetProperty("nat").GetProperty("firewalled").GetBoolean());
        Assert.Equal("203.0.113.5:49737", view.GetProperty("nat").GetProperty("publicAddress").GetString());

        // A LocalOnly world's tunnel binds loopback and gets the testnet and port from server.json.
        await Until(() => Read(world, "fake-env") is not null, "fake-env");
        var env = JsonDocument.Parse(Read(world, "fake-env")!).RootElement;
        Assert.Equal("1", env.GetProperty("local").GetString());
        Assert.Equal("127.0.0.1:49999", env.GetProperty("bootstrap").GetString());
        Assert.Equal("50001", env.GetProperty("port").GetString());

        sidecar.Rotated();
        await Until(() => Read(world, "fake-syncs") == "s", "sync");
        await Until(() => sidecar.Current.Connections == 0, "the status after sync");

        world.UpdateSettings(s => s with { P2p = s.P2p with { Enabled = false } });
        sidecar.Changed();
        await Until(() => Read(world, "fake-stopped") == "clean", "a clean stop");
        await Until(() => sidecar.Current.State == "off", "off");
        Assert.Equal(1, sidecar.Starts);

        // On again: a new run.
        world.UpdateSettings(s => s with { P2p = s.P2p with { Enabled = true } });
        sidecar.Changed();
        await Until(() => sidecar.Starts == 2 && sidecar.Current.State == "ready", "ready again");
        await sidecar.StopAsync(CancellationToken.None);
        Assert.Equal("cleanclean", Read(world, "fake-stopped"));
    }

    [Fact]
    public async Task Is_started_again_after_it_dies()
    {
        Assert.SkipUnless(HasNode(), "node isn't installed");
        using var world = NewWorld("crash", p => p with { Enabled = true, SidecarPath = Fake() });
        File.WriteAllText(Path.Combine(world.Path, "fake-crash"), "");
        using var sidecar = new P2pSidecar(world, NullLogger<P2pSidecar>.Instance, null, hostedByApp: false);
        await sidecar.StartAsync(CancellationToken.None);
        await Until(() => sidecar.Current.State == "failed", "failed");
        Assert.Equal("stopped", sidecar.Current.Error);
        await Until(() => sidecar.Current.State == "ready", "ready after the restart (2 s)", 20_000);
        Assert.Equal(2, sidecar.Starts);
        await sidecar.StopAsync(CancellationToken.None);
        Assert.Equal("clean", Read(world, "fake-stopped"));
    }

    [Fact]
    public async Task Leaves_the_tunnel_to_the_desktop_app_that_hosts_the_server()
    {
        using var world = NewWorld("app", p => p with { Enabled = true, SidecarPath = Fake() });
        using var sidecar = new P2pSidecar(world, NullLogger<P2pSidecar>.Instance, null, hostedByApp: true);
        await sidecar.StartAsync(CancellationToken.None);
        sidecar.Changed();
        sidecar.Rotated();
        await Task.Delay(300);
        Assert.Equal(0, sidecar.Starts);
        Assert.Null(sidecar.View());
        await sidecar.StopAsync(CancellationToken.None);
    }

    [Fact]
    public void Status_lines_are_read_strictly()
    {
        using var world = NewWorld("lines", p => p);
        using var sidecar = new P2pSidecar(world, NullLogger<P2pSidecar>.Instance, null, hostedByApp: false);
        sidecar.OnLine("""{"status":{"state":"ready","nat":{"firewalled":true,"randomized":true,"publicAddress":"198.51.100.7:1234"},"connections":3,"error":null}}""");
        Assert.Equal(new P2pSidecar.Status("ready", null, new P2pSidecar.Nat(true, true, "198.51.100.7:1234"), 3), sidecar.Current);
        foreach (var junk in new[] { "", "nope", "[]", """{"status":"ready"}""", """{"status":{"state":"pwned"}}""", "{\"status\":{\"state\":\"ready\",\"error\":\"" + new string('x', 5000) + "\"}}" })
            sidecar.OnLine(junk);
        Assert.Equal("ready", sidecar.Current.State);
        Assert.Equal(3, sidecar.Current.Connections);
        sidecar.OnLine("""{"status":{"state":"failed","nat":{"publicAddress":42},"connections":-5,"error":"boom"}}""");
        Assert.Equal(new P2pSidecar.Status("failed", "boom", new P2pSidecar.Nat(false, false, null), 0), sidecar.Current);
    }

    [Fact]
    public void Tunnel_log_lines_pass_as_p2p_lines_with_types_and_numbers_only()
    {
        using var world = NewWorld("loglines", p => p);
        var lines = new List<string>();
        var sink = new LogSink(null, console: false);
        sink.Tap += lines.Add;
        using var provider = new IskraLoggerProvider(sink);
        using var factory = new LoggerFactory([provider]);
        using var sidecar = new P2pSidecar(world, factory.CreateLogger<P2pSidecar>(), null, hostedByApp: false);

        sidecar.OnLine("""{"log":{"level":"INFO","event":"announced","fields":[["took","840ms"],["nat","consistent"]]}}""");
        sidecar.OnLine("""{"log":{"level":"INFO","event":"turn","fields":[["count",2],["in",1520],["out",1498]]}}""");
        sidecar.OnLine("""{"log":{"level":"INFO","event":"peers","fields":[["count",3],["n",7]]}}""");
        // Hostile or unknown parts: an address, an ICE candidate, a key, an unknown event, key or code, text.
        sidecar.OnLine("""{"log":{"level":"WARN","code":"TUN-160","event":"failed","fields":[["why","198.51.100.7:4567"],["nat","candidate:1 1 udp 2122260223 192.168.1.20 61000 typ srflx raddr 10.0.0.2 rport 5000"],["path","fe80::1%eth0"],["host","198.51.100.7"],["took","9.0s"]]}}""");
        sidecar.OnLine("""{"log":{"level":"ERROR","code":"SRV-999","event":"announced","fields":[["msg","Alice joined from 203.0.113.9"],["count",-4],["n",1e30]]}}""");
        sidecar.OnLine("""{"log":{"level":"INFO","event":"exploded","fields":[]}}""");
        sidecar.OnLine("""{"status":{"state":"ready","nat":{"firewalled":true,"randomized":false,"publicAddress":"198.51.100.7:1234"},"connections":1}}""");
        sidecar.OnLine("""{"status":{"state":"failed","connections":0,"error":"boom"}}""");

        var p2p = lines.Where(l => l.Contains(" p2p ")).Select(l => l[25..]).ToList();
        Assert.Equal(
        [
            "INFO  p2p   tunnel announced   -       took=840ms nat=consistent",
            "INFO  p2p   tunnel turn        -       count=2 in=1520 out=1498",
            "INFO  p2p   tunnel peers       -       count=3 n=7",
            "WARN  p2p   tunnel failed      TUN-160 took=9.0s",
            "INFO  p2p   tunnel announced   -",
            "INFO  p2p   tunnel changed     -       state=ready nat=consistent",
            "WARN  p2p   tunnel changed     TUN-150 state=failed nat=consistent",
        ], p2p);
        var all = string.Join('\n', lines);
        foreach (var bad in new[] { "198.51", "192.168", "10.0.0", "203.0.113", "candidate", "typ", "fe80", "Alice", "SRV-999", "exploded" })
            Assert.DoesNotContain(bad, all);
    }

    [Fact]
    public async Task Goes_away_with_the_server_even_when_the_server_is_killed()
    {
        Assert.SkipUnless(HasNode(), "node isn't installed");
        var world = Path.Combine(_dir, "killed");
        Directory.CreateDirectory(world);
        int port;
        using (var probe = new TcpListener(IPAddress.Loopback, 0))
        {
            probe.Start();
            port = ((IPEndPoint)probe.LocalEndpoint).Port;
        }
        File.WriteAllText(Path.Combine(world, "server.json"), JsonSerializer.Serialize(new
        {
            Name = "Sidecar",
            Port = port,
            LocalOnly = true,
            Voice = new { Enabled = false },
            P2p = new { Enabled = true, SidecarPath = Fake() },
        }));
        var dll = Path.Combine(AppContext.BaseDirectory, "iskra-server.dll");
        var info = new ProcessStartInfo("dotnet") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        info.ArgumentList.Add(dll);
        info.ArgumentList.Add(world);
        info.Environment.Remove("ISKRA_P2P_TUNNEL");
        var server = Process.Start(info)!;
        _processes.Add(server);
        server.OutputDataReceived += (_, _) => { };
        server.ErrorDataReceived += (_, _) => { };
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();

        var envFile = Path.Combine(world, "fake-env");
        await Until(() => File.Exists(envFile) && File.ReadAllText(envFile).Length > 0, "the sidecar to start", 60_000);
        var pid = JsonDocument.Parse(File.ReadAllText(envFile)).RootElement.GetProperty("pid").GetInt32();
        Assert.False(Gone(pid));
        // p2p.port is written before the tunnel starts: it has a listener to reach.
        Assert.True(int.Parse(File.ReadAllText(Path.Combine(world, "p2p.port")).Trim()) > 0);

        server.Kill(); // abruptly: no clean shutdown
        await Until(() => Gone(pid), "the sidecar to go with the server", 15_000);
    }
}

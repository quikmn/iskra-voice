using System.Xml.Linq;
using Iskra.Server.Hosting;

namespace Iskra.Server.Tests;

/// <summary>A pretend computer: records the commands it's asked to run and registers nothing.</summary>
public sealed class FakeAutostartSystem(string os, string home, bool elevated = false) : IAutostartSystem
{
    public string Os => os;
    public string Home => home;
    public bool Elevated => elevated;
    public string User => os == "windows" ? @"PC\Ada" : os == "macos" ? "501" : "ada";
    public List<string[]> Runs { get; } = [];
    /// <summary>Copies of files passed to schtasks /XML, read before they're deleted.</summary>
    public List<string> TaskXml { get; } = [];
    public int QueryCode { get; set; }

    public (int Code, string Output) Run(string file, params string[] args)
    {
        Runs.Add([file, .. args]);
        if (args.Contains("/XML")) TaskXml.Add(File.ReadAllText(args[Array.IndexOf(args, "/XML") + 1]));
        return (args.Contains("/Query") ? QueryCode : 0, "");
    }
}

/// <summary>"Keep my server running" for the standalone server: the generated task, unit and plist. Nothing is registered.</summary>
public class AutostartTests : IDisposable
{
    private readonly string _home = Path.Combine(Path.GetTempPath(), "iskra-autostart-" + Guid.NewGuid().ToString("N"));
    private string World => Path.Combine(_home, "My Server & Co");

    public AutostartTests() => Directory.CreateDirectory(World);

    public void Dispose()
    {
        try { Directory.Delete(_home, recursive: true); } catch (IOException) { }
    }

    private static readonly XNamespace Task = "http://schemas.microsoft.com/windows/2004/02/mit/task";

    [Fact]
    public void Names_are_readable_and_never_clash_between_folders()
    {
        var a = Autostart.Slug(Path.Combine(_home, "a", "world"));
        var b = Autostart.Slug(Path.Combine(_home, "b", "world"));
        Assert.StartsWith("world-", a);
        Assert.NotEqual(a, b);
        Assert.Equal(a, Autostart.Slug(Path.Combine(_home, "a", "world") + Path.DirectorySeparatorChar));
        Assert.Matches("^my-server---co-[0-9a-f]{6}$", Autostart.Slug(World));
    }

    [Fact]
    public void Windows_task_starts_at_logon_without_a_window_and_never_times_out()
    {
        var xml = XDocument.Parse(Autostart.WindowsTaskXml(@"C:\Iskra\iskra-server.exe", [], @"C:\Servers\Game & Night", @"PC\Ada", elevated: false));
        var logon = xml.Descendants(Task + "LogonTrigger").Single();
        Assert.Equal(@"PC\Ada", logon.Element(Task + "UserId")!.Value);
        Assert.Empty(xml.Descendants(Task + "BootTrigger"));
        Assert.Equal("InteractiveToken", xml.Descendants(Task + "LogonType").Single().Value);
        Assert.Equal("LeastPrivilege", xml.Descendants(Task + "RunLevel").Single().Value);
        Assert.Equal("PT0S", xml.Descendants(Task + "ExecutionTimeLimit").Single().Value); // the default (3 days) would stop the server
        Assert.Equal("false", xml.Descendants(Task + "DisallowStartIfOnBatteries").Single().Value);
        Assert.NotNull(xml.Descendants(Task + "RestartOnFailure").SingleOrDefault());
        var exec = xml.Descendants(Task + "Exec").Single();
        Assert.Equal("conhost.exe", exec.Element(Task + "Command")!.Value);
        Assert.Equal("--headless cmd.exe /d /s /c \"\"C:\\Iskra\\iskra-server.exe\" \"C:\\Servers\\Game & Night\" > nul 2>> \"C:\\Servers\\Game & Night\\server.log\"\"",
            exec.Element(Task + "Arguments")!.Value);
        Assert.Equal(@"C:\Servers\Game & Night", exec.Element(Task + "WorkingDirectory")!.Value);
    }

    [Fact]
    public void Windows_task_run_as_administrator_starts_with_the_computer_without_storing_a_password()
    {
        var xml = XDocument.Parse(Autostart.WindowsTaskXml(@"C:\dotnet\dotnet.exe", [@"C:\Iskra\iskra-server.dll"], @"C:\w", @"PC\Ada", elevated: true));
        Assert.NotNull(xml.Descendants(Task + "BootTrigger").SingleOrDefault());
        Assert.Empty(xml.Descendants(Task + "LogonTrigger"));
        Assert.Equal("S4U", xml.Descendants(Task + "LogonType").Single().Value);
        Assert.Equal("LeastPrivilege", xml.Descendants(Task + "RunLevel").Single().Value); // never as administrator
        Assert.Contains("\"C:\\dotnet\\dotnet.exe\" \"C:\\Iskra\\iskra-server.dll\" \"C:\\w\"", xml.Descendants(Task + "Arguments").Single().Value);
    }

    [Fact]
    public void Windows_install_and_remove_go_through_schtasks()
    {
        var system = new FakeAutostartSystem("windows", _home);
        var result = Autostart.Install(system, World, @"C:\Iskra\iskra-server.exe", []);
        var name = Autostart.TaskName(Autostart.Slug(World));
        Assert.Equal("logon", result.When);
        var create = system.Runs.Single();
        Assert.Equal(["schtasks.exe", "/Create", "/TN", name, "/XML"], create[..5]);
        Assert.Equal("/F", create[^1]);
        Assert.False(File.Exists(create[5])); // the XML was only temporary
        Assert.Contains("<LogonTrigger>", system.TaskXml.Single());
        Assert.Equal("startup", Autostart.Install(new FakeAutostartSystem("windows", _home, elevated: true), World, "x.exe", []).When);

        var removing = new FakeAutostartSystem("windows", _home);
        Assert.True(Autostart.Remove(removing, World));
        Assert.Equal([["schtasks.exe", "/Query", "/TN", name], ["schtasks.exe", "/End", "/TN", name], ["schtasks.exe", "/Delete", "/TN", name, "/F"]], removing.Runs);
        Assert.False(Autostart.Remove(new FakeAutostartSystem("windows", _home) { QueryCode = 1 }, World));
    }

    [Fact]
    public void A_folder_name_cant_add_lines_to_the_systemd_unit()
    {
        // Security review: a world folder named with a line break must not smuggle in its own directives.
        var unit = Autostart.SystemdUnit("/opt/iskra/iskra-server", [], "/home/ada/x\nExecStartPre=evil %h");
        Assert.DoesNotContain("\nExecStartPre", unit);
        Assert.Contains("ExecStart=\"/opt/iskra/iskra-server\" \"/home/ada/x\\nExecStartPre=evil %%h\"\n", unit);
        Assert.Contains("Description=Iskra server (x?ExecStartPre=evil %%h)\n", unit);
    }

    [Fact]
    public void Linux_gets_a_systemd_user_service()
    {
        var unit = Autostart.SystemdUnit("/opt/iskra/iskra-server", [], "/home/ada/My Server 100%");
        Assert.Contains("ExecStart=\"/opt/iskra/iskra-server\" \"/home/ada/My Server 100%%\"\n", unit);
        Assert.Contains("Restart=on-failure\n", unit);
        Assert.Contains("WantedBy=default.target\n", unit);
        Assert.Contains("After=network-online.target\n", unit);

        var system = new FakeAutostartSystem("linux", _home);
        var result = Autostart.Install(system, World, "/opt/iskra/iskra-server", []);
        var unitName = Autostart.UnitName(Autostart.Slug(World));
        var file = Path.Combine(_home, ".config", "systemd", "user", unitName);
        Assert.Equal(file, result.File);
        Assert.Contains("\"/opt/iskra/iskra-server\"", File.ReadAllText(file));
        Assert.Equal([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", unitName]], system.Runs);
        Assert.Contains(result.Notes, n => n.Contains("loginctl enable-linger ada"));

        Assert.True(Autostart.Remove(system, World));
        Assert.False(File.Exists(file));
        Assert.False(Autostart.Remove(system, World));
        Assert.Throws<IOException>(() => Autostart.Install(new FakeAutostartSystem("linux", _home, elevated: true), World, "x", []));
    }

    [Fact]
    public void macOS_gets_a_launchd_agent()
    {
        var plist = XDocument.Parse(Autostart.LaunchdPlist("foo.iskra.server.w-123456", "/Applications/Iskra/iskra-server", [], "/Users/ada/Game & Night"));
        var dict = plist.Root!.Element("dict")!.Elements().ToList();
        string? After(string key) => dict.SkipWhile(e => e.Value != key).Skip(1).FirstOrDefault()?.Value;
        Assert.Equal("foo.iskra.server.w-123456", After("Label"));
        Assert.Equal(["/Applications/Iskra/iskra-server", "/Users/ada/Game & Night"],
            dict.SkipWhile(e => e.Value != "ProgramArguments").Skip(1).First().Elements("string").Select(e => e.Value));
        Assert.Equal("true", dict.SkipWhile(e => e.Value != "RunAtLoad").Skip(1).First().Name.LocalName);
        Assert.Equal("/dev/null", After("StandardOutPath")); // the server keeps its own log in logs/
        Assert.Equal("/Users/ada/Game & Night/server.log", After("StandardErrorPath")!.Replace('\\', '/'));

        var system = new FakeAutostartSystem("macos", _home);
        var result = Autostart.Install(system, World, "/Applications/Iskra/iskra-server", []);
        Assert.Empty(system.Runs); // nothing is loaded now; it starts at the next login
        Assert.True(File.Exists(result.File));
        Assert.StartsWith(Path.Combine(_home, "Library", "LaunchAgents"), result.File);
        Assert.True(Autostart.Remove(system, World));
        Assert.Equal(["launchctl", "bootout", $"gui/501/{Autostart.AgentLabel(Autostart.Slug(World))}"], system.Runs.Single());
        Assert.False(File.Exists(result.File));
    }
}

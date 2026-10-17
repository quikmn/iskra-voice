using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using System.Text;

namespace Iskra.Server.Hosting;

/// <summary>What the computer looks like to <see cref="Autostart"/>. Tests use a fake that never registers anything.</summary>
public interface IAutostartSystem
{
    /// <summary>"windows", "linux" or "macos".</summary>
    string Os { get; }
    string Home { get; }
    /// <summary>Windows: run as administrator. Linux and macOS: root.</summary>
    bool Elevated { get; }
    /// <summary>Windows: DOMAIN\user. macOS: the numeric user id (for launchctl). Linux: the user name.</summary>
    string User { get; }
    /// <summary>Runs a program and returns its exit code and output.</summary>
    (int Code, string Output) Run(string file, params string[] args);
}

public sealed class RealAutostartSystem : IAutostartSystem
{
    public string Os => OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "linux";
    public string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    public bool Elevated
    {
        get
        {
            if (!OperatingSystem.IsWindows()) return Environment.UserName == "root" || GetUid() == "0";
            using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
            return new System.Security.Principal.WindowsPrincipal(identity).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
        }
    }

    public string User
    {
        get
        {
            if (OperatingSystem.IsWindows())
            {
                using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
                return identity.Name;
            }
            return OperatingSystem.IsMacOS() ? GetUid() : Environment.UserName;
        }
    }

    private string GetUid() => Run("id", "-u").Output.Trim();

    public (int Code, string Output) Run(string file, params string[] args)
    {
        var start = new ProcessStartInfo(file) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        try
        {
            using var process = Process.Start(start)!;
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            process.WaitForExit();
            return (process.ExitCode, (output.Result + error.Result).Trim());
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            return (-1, ex.Message);
        }
    }
}

/// <summary>What install/remove did, for the command line to print.</summary>
public sealed record AutostartResult(string Name, string? File, string When, IReadOnlyList<string> Notes);

/// <summary>
/// "Keep my server running" for the standalone server (iskra-server install-autostart): a Windows scheduled task,
/// a systemd user service on Linux, or a launchd agent on macOS. Nothing is started right away, so a server
/// running in a terminal doesn't clash with a second copy; it starts at the next logon (or boot).
/// </summary>
public static class Autostart
{
    /// <summary>A name for the entry: the folder's name plus a short hash of its full path, so two "world" folders never clash.</summary>
    public static string Slug(string worldPath)
    {
        var full = Path.GetFullPath(worldPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var name = new string(Path.GetFileName(full).ToLowerInvariant().Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-').ToArray()).Trim('-');
        if (name.Length == 0) name = "server";
        if (name.Length > 40) name = name[..40].TrimEnd('-');
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(OperatingSystem.IsWindows() ? full.ToLowerInvariant() : full)))[..6];
        return $"{name}-{hash}";
    }

    public static string TaskName(string slug) => $"Iskra server {slug}";
    public static string UnitName(string slug) => $"iskra-{slug}.service";
    public static string AgentLabel(string slug) => $"foo.iskra.server.{slug}";

    /// <summary>
    /// The Windows scheduled task. Elevated: at startup, as this user without a stored password (S4U), so it runs
    /// before anyone logs in. Otherwise: when this user logs on. Either way without a window (a headless console),
    /// output appended to server.log, restarted if it crashes, and no time limit.
    /// </summary>
    public static string WindowsTaskXml(string exe, string[] prefixArgs, string world, string user, bool elevated)
    {
        static string Q(string s) => $"\"{s}\"";
        var server = string.Join(' ', new[] { exe }.Concat(prefixArgs).Concat([world]).Select(Q));
        // A Windows path whatever OS builds it (Path.Combine would use '/' on Linux).
        var log = Q(world.TrimEnd('\\', '/') + @"\server.log");
        // conhost --headless hosts the console without a window; cmd appends the output to server.log.
        var arguments = $"--headless cmd.exe /d /s /c \"{server} >> {log} 2>&1\"";
        var x = SecurityElement.Escape;
        var trigger = elevated
            ? "<BootTrigger><Enabled>true</Enabled><Delay>PT30S</Delay></BootTrigger>"
            : $"<LogonTrigger><Enabled>true</Enabled><UserId>{x(user)}</UserId></LogonTrigger>";
        var logon = elevated ? "S4U" : "InteractiveToken";
        return $"""
            <?xml version="1.0" encoding="UTF-16"?>
            <Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
              <RegistrationInfo>
                <Description>Keeps the Iskra server in {x(world)} running.</Description>
                <URI>\{x(TaskName(Slug(world)))}</URI>
              </RegistrationInfo>
              <Triggers>
                {trigger}
              </Triggers>
              <Principals>
                <Principal id="Author">
                  <UserId>{x(user)}</UserId>
                  <LogonType>{logon}</LogonType>
                  <RunLevel>LeastPrivilege</RunLevel>
                </Principal>
              </Principals>
              <Settings>
                <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
                <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
                <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
                <AllowHardTerminate>true</AllowHardTerminate>
                <StartWhenAvailable>true</StartWhenAvailable>
                <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
                <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
                <AllowStartOnDemand>true</AllowStartOnDemand>
                <Enabled>true</Enabled>
                <Hidden>false</Hidden>
                <RunOnlyIfIdle>false</RunOnlyIfIdle>
                <WakeToRun>false</WakeToRun>
                <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
                <Priority>4</Priority>
                <RestartOnFailure><Interval>PT1M</Interval><Count>5</Count></RestartOnFailure>
              </Settings>
              <Actions Context="Author">
                <Exec>
                  <Command>conhost.exe</Command>
                  <Arguments>{x(arguments)}</Arguments>
                  <WorkingDirectory>{x(world)}</WorkingDirectory>
                </Exec>
              </Actions>
            </Task>
            """;
    }

    /// <summary>systemd's quoting: each argument in double quotes, with \, ", % and line breaks escaped (a folder name can't add lines).</summary>
    private static string SystemdQuote(string s) =>
        "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("%", "%%").Replace("\n", "\\n").Replace("\r", "\\r") + "\"";

    /// <summary>Free text in a unit file (the description): one line, no specifiers.</summary>
    private static string SystemdText(string s) => new string(s.Select(c => char.IsControl(c) ? '?' : c).ToArray()).Replace("%", "%%");

    /// <summary>The systemd user service: starts with the user's session (and at boot with lingering on), restarts on failure.</summary>
    public static string SystemdUnit(string exe, string[] prefixArgs, string world)
    {
        var command = string.Join(' ', new[] { exe }.Concat(prefixArgs).Concat([world]).Select(SystemdQuote));
        return $"""
            [Unit]
            Description=Iskra server ({SystemdText(Path.GetFileName(world.TrimEnd('/')))})
            After=network-online.target

            [Service]
            ExecStart={command}
            WorkingDirectory={SystemdQuote(world)}
            Restart=on-failure
            RestartSec=5

            [Install]
            WantedBy=default.target

            """;
    }

    /// <summary>The launchd agent: starts when the user logs in, restarts if it crashes, output to server.log.</summary>
    public static string LaunchdPlist(string label, string exe, string[] prefixArgs, string world)
    {
        var x = SecurityElement.Escape;
        var args = string.Concat(new[] { exe }.Concat(prefixArgs).Concat([world]).Select(a => $"\n        <string>{x(a)}</string>"));
        var log = x(Path.Combine(world, "server.log"));
        return $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
                <key>Label</key>
                <string>{x(label)}</string>
                <key>ProgramArguments</key>
                <array>{args}
                </array>
                <key>WorkingDirectory</key>
                <string>{x(world)}</string>
                <key>RunAtLoad</key>
                <true/>
                <key>KeepAlive</key>
                <dict>
                    <key>SuccessfulExit</key>
                    <false/>
                </dict>
                <key>StandardOutPath</key>
                <string>{log}</string>
                <key>StandardErrorPath</key>
                <string>{log}</string>
            </dict>
            </plist>

            """;
    }

    /// <summary>How to start this server again: iskra-server itself, or "dotnet iskra-server.dll" in development.</summary>
    public static (string Exe, string[] Prefix) ServerCommand()
    {
        var process = Environment.ProcessPath ?? throw new IOException("Can't tell where iskra-server is.");
        var name = Path.GetFileNameWithoutExtension(process);
        if (name.Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            // Assembly.Location is empty in a single-file publish (and an error there), so build the path instead.
            return (process, [Path.Combine(AppContext.BaseDirectory, typeof(Autostart).Assembly.GetName().Name + ".dll")]);
        return (process, []);
    }

    private static string SystemdDir(IAutostartSystem system) =>
        Path.Combine(Environment.GetEnvironmentVariable("XDG_CONFIG_HOME") is { Length: > 0 } config && system is RealAutostartSystem
            ? config : Path.Combine(system.Home, ".config"), "systemd", "user");

    public static AutostartResult Install(IAutostartSystem system, string world, string exe, string[] prefix)
    {
        world = Path.GetFullPath(world);
        var slug = Slug(world);
        switch (system.Os)
        {
            case "windows":
            {
                var name = TaskName(slug);
                var xml = WindowsTaskXml(exe, prefix, world, system.User, system.Elevated);
                var file = Path.Combine(Path.GetTempPath(), $"iskra-task-{slug}.xml");
                File.WriteAllText(file, xml, Encoding.Unicode);
                try
                {
                    var (code, output) = system.Run("schtasks.exe", "/Create", "/TN", name, "/XML", file, "/F");
                    if (code != 0) throw new IOException($"Windows didn't accept the scheduled task: {output}");
                }
                finally
                {
                    File.Delete(file);
                }
                return new(name, null, system.Elevated ? "startup" : "logon",
                [
                    system.Elevated
                        ? "It starts when the computer starts, before anyone logs in (as you, without storing your password)."
                        : "It starts when you log in. Run this from an administrator terminal to start it with the computer instead.",
                    $"Start it now: schtasks /Run /TN \"{name}\"   (stop the copy running here first)",
                ]);
            }
            case "linux":
            {
                if (system.Elevated) throw new IOException("Run this as the user who should run the server, not as root. For a system-wide service, see https://iskra.foo/docs/hosting#on-a-linux-vps-with-systemd");
                var dir = SystemdDir(system);
                Directory.CreateDirectory(dir);
                var unit = UnitName(slug);
                var file = Path.Combine(dir, unit);
                File.WriteAllText(file, SystemdUnit(exe, prefix, world));
                Check(system.Run("systemctl", "--user", "daemon-reload"), "systemctl --user daemon-reload");
                Check(system.Run("systemctl", "--user", "enable", unit), $"systemctl --user enable {unit}");
                return new(unit, file, "login",
                [
                    "It starts when you log in. To start it when the computer starts, even before you log in, run:",
                    $"  loginctl enable-linger {system.User}",
                    $"Start it now: systemctl --user start {unit}   (stop the copy running here first)",
                    $"Its output: journalctl --user -u {unit} -f",
                ]);
            }
            case "macos":
            {
                if (system.Elevated) throw new IOException("Run this as the user who should run the server, not with sudo.");
                var label = AgentLabel(slug);
                var dir = Path.Combine(system.Home, "Library", "LaunchAgents");
                Directory.CreateDirectory(dir);
                var file = Path.Combine(dir, label + ".plist");
                File.WriteAllText(file, LaunchdPlist(label, exe, prefix, world));
                return new(label, file, "login",
                [
                    "It starts when you log in, and again if it stops unexpectedly.",
                    $"Start it now: launchctl bootstrap gui/{system.User} \"{file}\"   (stop the copy running here first)",
                ]);
            }
            default:
                throw new IOException($"Autostart isn't supported on {system.Os}.");
        }
    }

    /// <summary>Removes what <see cref="Install"/> made (and stops it if it's running). Returns false if there was nothing.</summary>
    public static bool Remove(IAutostartSystem system, string world)
    {
        world = Path.GetFullPath(world);
        var slug = Slug(world);
        switch (system.Os)
        {
            case "windows":
            {
                var name = TaskName(slug);
                if (system.Run("schtasks.exe", "/Query", "/TN", name).Code != 0) return false;
                system.Run("schtasks.exe", "/End", "/TN", name);
                Check(system.Run("schtasks.exe", "/Delete", "/TN", name, "/F"), "schtasks /Delete");
                return true;
            }
            case "linux":
            {
                var unit = UnitName(slug);
                var file = Path.Combine(SystemdDir(system), unit);
                if (!File.Exists(file)) return false;
                system.Run("systemctl", "--user", "disable", "--now", unit);
                File.Delete(file);
                system.Run("systemctl", "--user", "daemon-reload");
                return true;
            }
            case "macos":
            {
                var label = AgentLabel(slug);
                var file = Path.Combine(system.Home, "Library", "LaunchAgents", label + ".plist");
                if (!File.Exists(file)) return false;
                system.Run("launchctl", "bootout", $"gui/{system.User}/{label}"); // fails harmlessly when it isn't loaded
                File.Delete(file);
                return true;
            }
            default:
                return false;
        }
    }

    private static void Check((int Code, string Output) result, string what)
    {
        if (result.Code != 0) throw new IOException($"{what} failed: {result.Output}");
    }
}

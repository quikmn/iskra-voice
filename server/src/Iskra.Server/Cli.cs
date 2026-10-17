using System.Text.Json;
using Iskra.Server.Backups;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Files;
using Iskra.Server.Hosting;
using Iskra.Server.Templates;
using Iskra.Server.Import;
using Iskra.Server.Storage;
using Microsoft.Extensions.Logging.Abstractions;

namespace Iskra.Server;

/// <summary>
/// Commands besides running a server:
///   iskra-server restore &lt;backup&gt; &lt;world-folder&gt;      restore a backup into a new folder
///   iskra-server restore-buddy &lt;address&gt; &lt;world-folder&gt;  restore from a backup buddy (a friend's server)
///   iskra-server backup &lt;world-folder&gt; &lt;file&gt;         make an encrypted backup
///   iskra-server move &lt;world-folder&gt; &lt;new-address&gt;   publish "this server moved" (or --cancel)
///   iskra-server import-discord &lt;world-folder&gt; &lt;export&gt; [--read-only]
///   iskra-server templates [name-or-file] [--json]         list starter templates, or check one
///   iskra-server install-autostart &lt;world-folder&gt;       start the server with the computer (remove-autostart undoes it)
///   iskra-server expect-restart &lt;world-folder&gt; [--eta &lt;s&gt;] [--reason update|restart]   the next stop is a restart
///   iskra-server version                                   print the version
/// The passphrase comes from --passphrase-stdin (one line), $ISKRA_BACKUP_PASSPHRASE, or a prompt.
/// </summary>
public static class Cli
{
    private static readonly string[] Commands = ["restore", "restore-buddy", "backup", "move", "import-discord", "templates", "install-autostart", "remove-autostart", "expect-restart", "version", "--version", "help", "--help"];

    public static bool IsCommand(string? first) => first is not null && Commands.Contains(first);

    public static int Run(string[] args)
    {
        var flags = args.Where(a => a.StartsWith("--", StringComparison.Ordinal)).ToHashSet(StringComparer.Ordinal);
        var rest = args.Where(a => !a.StartsWith("--", StringComparison.Ordinal)).ToArray();
        try
        {
            return rest.FirstOrDefault() switch
            {
                "restore" when rest.Length == 3 => Restore(rest[1], rest[2], flags),
                "restore-buddy" => RestoreBuddy(args),
                "backup" when rest.Length == 3 => Backup(rest[1], rest[2], flags),
                "move" when rest.Length == 3 || (rest.Length == 2 && flags.Contains("--cancel")) => Move(rest[1], rest.ElementAtOrDefault(2), flags),
                "import-discord" when rest.Length == 3 => ImportDiscord(rest[1], rest[2], flags),
                "templates" when rest.Length == 4 && rest[1] == "apply" => MergeTemplate(rest[2], rest[3], flags.Contains("--apply")),
                "templates" when rest.Length <= 2 => ListTemplates(rest.ElementAtOrDefault(1), flags.Contains("--json")),
                "install-autostart" when rest.Length == 2 => InstallAutostart(rest[1], new RealAutostartSystem()),
                "remove-autostart" when rest.Length == 2 => RemoveAutostart(rest[1], new RealAutostartSystem()),
                "expect-restart" => ExpectRestart(args),
                "version" when rest.Length == 1 => PrintVersion(),
                null when flags.Contains("--version") && args.Length == 1 => PrintVersion(),
                _ => Usage(),
            };
        }
        catch (Templates.TemplateException ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException or System.Security.Cryptography.CryptographicException)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    /// <summary>
    /// Writes the restart marker (Sessions/RestartMarker.cs) so the next stop, within two minutes, tells members the
    /// server is restarting rather than going offline. For update scripts that restart the service.
    /// </summary>
    internal static int ExpectRestart(string[] args)
    {
        string? world = null;
        var reason = "restart";
        int? eta = null;
        for (var i = 1; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--reason" when i + 1 < args.Length && Sessions.RestartMarker.IsReason(args[i + 1]):
                    reason = args[++i];
                    break;
                case "--eta" when i + 1 < args.Length && int.TryParse(args[i + 1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var seconds)
                    && seconds <= Sessions.RestartMarker.MaxEtaSeconds:
                    eta = seconds;
                    i++;
                    break;
                case var arg when world is null && !arg.StartsWith("--", StringComparison.Ordinal):
                    world = arg;
                    break;
                default:
                    Console.Error.WriteLine($"expect-restart <world-folder> [--reason update|restart] [--eta <0-{Sessions.RestartMarker.MaxEtaSeconds} seconds>]");
                    return 2;
            }
        }
        if (world is null) return Usage();
        if (!File.Exists(Path.Combine(world, "server.key"))) throw new IOException($"{world} isn't an Iskra server folder.");
        Sessions.RestartMarker.Write(world, reason, eta, DateTimeOffset.UtcNow);
        Console.WriteLine($"The next stop of {Path.GetFullPath(world)} in the next {Sessions.RestartMarker.FreshFor.TotalMinutes:0} minutes is a restart ({reason}).");
        return 0;
    }

    /// <summary>Just the version (the updater runs a new package with this to check it works here).</summary>
    private static int PrintVersion()
    {
        Console.WriteLine(Updates.Versions.Current);
        return 0;
    }

    private static int Usage()
    {
        Console.WriteLine("""
            Usage:
              iskra-server <world-folder>                              run a server (the folder is created if needed)
              iskra-server restore <backup> <world-folder>             restore a backup into a new, empty folder
              iskra-server restore-buddy <address> <world-folder>      restore from a friend's server that keeps your backups
                [--version <id>] [--list]                             (asks for the recovery code; --list shows the copies)
              iskra-server backup <world-folder> <file.iskrabackup>    make an encrypted backup (works while it runs)
              iskra-server move <world-folder> <new-address>           tell members the server moved there
              iskra-server move <world-folder> --cancel                take that notice down again
              iskra-server import-discord <world-folder> <export>      import DiscordChatExporter JSON (a .json or a .zip)
                                                                       add --read-only to make the channels an archive
              iskra-server templates                                   list the starter templates (--json for the details)
              iskra-server templates <name-or-file.json>               check a template and show what it sets up
              iskra-server templates apply <world-folder> <template>   add what a template has and the server doesn't (never
                [--apply]                                              changes or removes anything); shows it, --apply does it.
                                                                       Stop the server first.
              iskra-server install-autostart <world-folder>            start this server with the computer (no window)
              iskra-server remove-autostart <world-folder>             undo that
              iskra-server expect-restart <world-folder>               say the next stop is a restart (run it just before
                [--reason update|restart] [--eta <seconds>]           systemctl restart): members see "restarting"
              iskra-server version                                     print the version
            A new server can start from a template: iskra-server <world-folder> --template gaming
            Passphrases: --passphrase-stdin (one line), or $ISKRA_BACKUP_PASSPHRASE, or you're asked.
            Recovery codes: --code-stdin (one line), or $ISKRA_BUDDY_RECOVERY_CODE, or you're asked.
            Add --json to restore and restore-buddy for a machine-readable result.
            """);
        return 2;
    }

    private static string Passphrase(HashSet<string> flags, bool confirm)
    {
        if (flags.Contains("--passphrase-stdin")) return Console.In.ReadLine() ?? "";
        if (Environment.GetEnvironmentVariable("ISKRA_BACKUP_PASSPHRASE") is { Length: > 0 } fromEnv) return fromEnv;
        var first = Prompt("Backup passphrase: ");
        if (confirm && Prompt("Again, to be sure: ") != first) throw new InvalidDataException("The passphrases don't match.");
        return first;
    }

    private static string Prompt(string label)
    {
        Console.Error.Write(label);
        if (Console.IsInputRedirected) return Console.In.ReadLine() ?? "";
        var text = new System.Text.StringBuilder();
        while (true)
        {
            var key = Console.ReadKey(intercept: true);
            if (key.Key == ConsoleKey.Enter) break;
            if (key.Key == ConsoleKey.Backspace) { if (text.Length > 0) text.Length--; continue; }
            if (!char.IsControl(key.KeyChar)) text.Append(key.KeyChar);
        }
        Console.Error.WriteLine();
        return text.ToString();
    }

    private static int Restore(string backup, string target, HashSet<string> flags)
    {
        var result = BackupArchive.Restore(backup, target, () => Passphrase(flags, confirm: false), message => Console.Error.WriteLine(message));
        PrintRestored(result, flags.Contains("--json"));
        return 0;
    }

    /// <summary>
    /// restore-buddy &lt;address&gt; [&lt;world-folder&gt;] [--version &lt;id&gt;] [--list] [--json] [--code-stdin]: lists or restores
    /// the copies a backup buddy keeps for whoever has the recovery code.
    /// </summary>
    internal static int RestoreBuddy(string[] args)
    {
        var positional = new List<string>();
        string? version = null;
        var flags = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 1; i < args.Length; i++)
        {
            if (args[i] == "--version" && i + 1 < args.Length) version = args[++i];
            else if (args[i].StartsWith("--", StringComparison.Ordinal)) flags.Add(args[i]);
            else positional.Add(args[i]);
        }
        var list = flags.Contains("--list");
        if (positional.Count != (list ? 1 : 2)) return Usage();
        var code = flags.Contains("--code-stdin") ? Console.In.ReadLine() ?? ""
            : Environment.GetEnvironmentVariable("ISKRA_BUDDY_RECOVERY_CODE") is { Length: > 0 } fromEnv ? fromEnv
            : Prompt("Recovery code: ");
        using var http = new BuddyHttp(null, localOnly: false);
        var json = flags.Contains("--json");
        if (list)
        {
            var versions = BuddyRestore.ListAsync(http, positional[0], code, CancellationToken.None).GetAwaiter().GetResult();
            if (json) Console.WriteLine(JsonSerializer.Serialize(new { ok = true, versions = versions.Select(v => new { id = v.Id, size = v.Size, at = v.At }) }));
            else if (versions.Count == 0) Console.WriteLine("No copies there yet.");
            else foreach (var v in versions) Console.WriteLine($"{v.Id}  {DateTimeOffset.FromUnixTimeMilliseconds(v.At).ToLocalTime():yyyy-MM-dd HH:mm}  {v.Size:N0} bytes");
            return 0;
        }
        var result = BuddyRestore.RestoreAsync(http, positional[0], code, positional[1], version, message => Console.Error.WriteLine(message), CancellationToken.None)
            .GetAwaiter().GetResult();
        PrintRestored(result, json);
        return 0;
    }

    private static void PrintRestored(RestoreResult result, bool json)
    {
        if (json)
        {
            Console.WriteLine(JsonSerializer.Serialize(new { ok = true, name = result.Name, serverKey = result.ServerKey, folder = result.Folder, uploads = result.Uploads, messages = result.Messages }));
            return;
        }
        Console.WriteLine($"Restored '{result.Name}' into {result.Folder} ({result.Messages:N0} messages, {result.Uploads:N0} files).");
        Console.WriteLine($"Start it with: iskra-server \"{result.Folder}\"");
        Console.WriteLine("Check the ports and PublicUrl in server.json if this computer's address is different.");
    }

    private static int Backup(string worldPath, string output, HashSet<string> flags)
    {
        if (!File.Exists(Path.Combine(worldPath, "server.key"))) throw new IOException($"{worldPath} isn't an Iskra server folder.");
        var passphrase = Passphrase(flags, confirm: !flags.Contains("--passphrase-stdin"));
        if (passphrase.Trim().Length < BackupFile.MinPassphrase) throw new InvalidDataException($"Use a passphrase of at least {BackupFile.MinPassphrase} characters.");
        using var world = World.OpenOrCreate(worldPath);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var temp = output + ".tmp";
        File.Delete(temp);
        try
        {
            using (var file = BackupArchive.PrivateCreate(temp))
            using (var encrypted = BackupFile.Encrypt(file, passphrase, Ed25519.ToB64u(world.ServerPublicKey), world.Settings.Name, now))
                BackupArchive.Write(world, encrypted, includeUploads: true, now);
            File.Move(temp, output, overwrite: true);
            SecurityLog.Record(world.Store, now, "backup.cli");
        }
        finally
        {
            File.Delete(temp);
        }
        Console.WriteLine($"Backup written to {output}. Keep the passphrase somewhere safe: without it the backup can't be opened.");
        return 0;
    }

    private static int Move(string worldPath, string? url, HashSet<string> flags)
    {
        if (!File.Exists(Path.Combine(worldPath, "server.key"))) throw new IOException($"{worldPath} isn't an Iskra server folder.");
        using var world = World.OpenOrCreate(worldPath);
        if (flags.Contains("--cancel"))
        {
            File.Delete(Path.Combine(world.Path, MoveFeature.FileName));
            SecurityLog.Record(world.Store, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), "server.move.cancel", details: new { cli = true });
            Console.WriteLine("The move notice is gone. Start the server as usual.");
            return 0;
        }
        var clean = MoveFeature.CleanUrl(url) ?? throw new InvalidDataException("That isn't an http(s) address.");
        MoveFeature.Publish(world, clean, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        SecurityLog.Record(world.Store, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), "server.move", details: new { url = clean, cli = true });
        Console.WriteLine($"Members who connect here will be sent to {clean}. Keep this server running for a while so everyone gets the notice.");
        return 0;
    }

    private static int ImportDiscord(string worldPath, string export, HashSet<string> flags)
    {
        if (!File.Exists(Path.Combine(worldPath, "server.key"))) throw new IOException($"{worldPath} isn't an Iskra server folder.");
        using var world = World.OpenOrCreate(worldPath);
        var uploads = new Uploads(world, TimeProvider.System, NullLogger<Uploads>.Instance);
        using var source = ExportSource.Open(export);
        var lastLine = 0L;
        var importer = new DiscordImporter(world, uploads, new ImportOptions
        {
            ReadOnly = flags.Contains("--read-only"),
            MaxFileBytes = (long)world.Settings.MaxUploadMb * 1024 * 1024,
        }, p =>
        {
            var now = Environment.TickCount64;
            if (now - lastLine < 1000 && p.Phase is "reading" or "importing") return;
            lastLine = now;
            Console.Error.WriteLine(p.Phase == "reading"
                ? $"Reading {p.Current}…"
                : $"{p.Phase}: {p.ChannelsDone}/{p.Channels} channels, {p.MessagesDone:N0}/{p.Messages:N0} messages, {p.Files:N0} files");
        });
        var result = importer.Run(source);
        foreach (var warning in result.Warnings) Console.Error.WriteLine($"Note: {warning}");
        foreach (var channel in importer.Channels)
            Console.WriteLine($"  #{channel.Name}{(channel.Category is null ? "" : $" ({channel.Category})")}: {channel.Messages:N0} messages{(channel.Thread ? " (thread)" : "")}");
        Console.WriteLine($"Imported {result.MessagesDone:N0} messages in {importer.Channels.Count} channels, {result.Files:N0} files" +
            (result.MissingFiles > 0 ? $" ({result.MissingFiles:N0} files weren't in the export)" : "") + ".");
        Console.WriteLine("Roles aren't part of DiscordChatExporter exports, so set them up here. Restart the server if it's running, so everyone sees the new channels.");
        return 0;
    }

    /// <summary>The built-in templates (or one template, checked), for people and for the desktop app's setup wizard.</summary>
    private static int ListTemplates(string? which, bool json)
    {
        var ids = which is null ? ServerTemplates.BuiltIn : [which];
        var templates = ids.Select(id => (Id: ServerTemplates.IdOf(id), Template: ServerTemplates.Load(id))).ToList();
        if (json)
        {
            Console.WriteLine(JsonSerializer.Serialize(templates.Select(t => ServerTemplates.Preview(t.Id, t.Template)), new JsonSerializerOptions(JsonSerializerDefaults.Web)));
            return 0;
        }
        foreach (var (id, template) in templates)
        {
            Console.WriteLine($"{id}: {template.Name}. {template.Description}");
            foreach (var c in template.Channels) Console.WriteLine($"    {Describe(c)}");
            foreach (var category in template.Categories)
            {
                Console.WriteLine($"    {category.Name}");
                foreach (var c in category.Channels) Console.WriteLine($"      {Describe(c)}");
            }
            if (template.Roles.Length > 0) Console.WriteLine($"    Roles: {string.Join(", ", template.Roles.Select(r => r.Name))}");
            if (template.BuiltinRoles.Count > 0)
                Console.WriteLine($"    Built-in roles: {string.Join(", ", template.BuiltinRoles.Select(b => $"{b.Key} {b.Value.Color ?? "no colour"}"))}");
            if (template.Rules is not null) Console.WriteLine("    Rules: yes");
            if (template.Settings is { } settings)
            {
                if (settings.NotifyDefault is { } notify) Console.WriteLine($"    Default notifications: {notify}");
                if (settings.BuiltinBots.Length > 0) Console.WriteLine($"    Built-in bots: {string.Join(", ", settings.BuiltinBots)}");
                if (settings.Limits is not null) Console.WriteLine("    Limits: yes");
                if (settings.BugInbox is { } inbox) Console.WriteLine($"    Bug inbox: {inbox}");
                if (settings.Translation) Console.WriteLine("    Translation: offered");
            }
            if (template.Afk is { } afk)
                Console.WriteLine($"    AFK channel: {afk.Channel} ({(afk.Minutes > 0 ? $"idle people moved after {afk.Minutes} min" : "nobody moved")}; can talk: {(afk.CanTalk.Length > 0 ? string.Join(", ", afk.CanTalk) : "nobody")})");
        }
        if (which is null) Console.WriteLine("Use one for a new server: iskra-server <world-folder> --template <name>, or \"Template\": \"<name>\" in server.json.");
        return 0;

        static string Describe(TemplateChannel c) =>
            (c.Kind switch { "text" => $"# {c.Name}", "voice" => $"(voice) {c.Name}{(c.UserLimit > 0 ? $" (up to {c.UserLimit})" : "")}", _ => $"({c.Kind}) {c.Name}" })
            + (c.ReadRole != "member" || c.WriteRole != c.ReadRole ? $" [read: {c.ReadRole}, write: {c.WriteRole}]" : "")
            + (c.Overrides.Length > 0 ? $" [{string.Join("; ", c.Overrides.Select(o => $"{o.Role}: {(o.Allow.Length > 0 ? "+" + string.Join(" +", o.Allow) : "")}{(o.Deny.Length > 0 ? " -" + string.Join(" -", o.Deny) : "")}"))}]" : "")
            + (c.Topic is not null ? " [topic]" : "")
            + (c.Disappear > 0 ? $" [messages disappear after {c.Disappear}s]" : "")
            + (c.Messages.Length > 0 ? $" [{c.Messages.Length} message{(c.Messages.Length == 1 ? "" : "s")}]" : "")
            + (c.Pages.Length > 0 ? $" [pages: {string.Join(", ", c.Pages.Select(p => p.Title))}]" : "");
    }

    /// <summary>`templates apply`: adds a template to a server in use, additive only. Dry run unless --apply.</summary>
    private static int MergeTemplate(string worldPath, string nameOrPath, bool apply)
    {
        if (!File.Exists(Path.Combine(worldPath, "server.key"))) throw new IOException($"{worldPath} isn't an Iskra server folder.");
        var template = ServerTemplates.Load(nameOrPath);
        var settingsFile = Path.Combine(worldPath, "server.json");
        var settings = File.Exists(settingsFile) ? JsonSerializer.Deserialize<WorldSettings>(File.ReadAllText(settingsFile)) ?? new WorldSettings() : new WorldSettings();
        if (Running(settings.Port))
            throw new IOException($"The server in {worldPath} is running (port {settings.Port} answers). Stop it first, then run this again.");
        using var world = World.OpenOrCreate(worldPath);
        var plan = ServerTemplates.Merge(world, template, apply, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        if (plan.Count == 0)
        {
            Console.WriteLine($"Nothing to add: '{world.Settings.Name}' already has everything in '{template.Name}'.");
            return 0;
        }
        Console.WriteLine(apply ? $"Added to '{world.Settings.Name}':" : $"Would add to '{world.Settings.Name}' (nothing changes until you add --apply):");
        foreach (var line in plan) Console.WriteLine($"  + {line}");
        if (apply) Console.WriteLine("Done. Start the server again.");
        return 0;
    }

    /// <summary>Something listens on the server's port on this computer (localhost only; never opens a port).</summary>
    private static bool Running(int port)
    {
        try
        {
            using var client = new System.Net.Sockets.TcpClient();
            return client.ConnectAsync(System.Net.IPAddress.Loopback, port).Wait(TimeSpan.FromSeconds(1)) && client.Connected;
        }
        catch (AggregateException)
        {
            return false;
        }
        catch (System.Net.Sockets.SocketException)
        {
            return false;
        }
    }

    private static int InstallAutostart(string worldPath, IAutostartSystem system)
    {
        if (!File.Exists(Path.Combine(worldPath, "server.key"))) throw new IOException($"{worldPath} isn't an Iskra server folder. Start it once first: iskra-server {worldPath}");
        var (exe, prefix) = Autostart.ServerCommand();
        var result = Autostart.Install(system, worldPath, exe, prefix);
        using (var world = World.OpenOrCreate(worldPath))
            SecurityLog.Record(world.Store, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), "server.autostart.install", details: new { os = system.Os, when = result.When });
        Console.WriteLine($"Done: {result.Name}{(result.File is null ? "" : $" ({result.File})")}.");
        foreach (var note in result.Notes) Console.WriteLine(note);
        Console.WriteLine($"To undo: iskra-server remove-autostart {worldPath}");
        return 0;
    }

    private static int RemoveAutostart(string worldPath, IAutostartSystem system)
    {
        if (!Autostart.Remove(system, worldPath))
        {
            Console.WriteLine("This server doesn't start by itself; nothing to remove.");
            return 0;
        }
        if (File.Exists(Path.Combine(worldPath, "server.key")))
        {
            using var world = World.OpenOrCreate(worldPath);
            SecurityLog.Record(world.Store, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), "server.autostart.remove", details: new { os = system.Os });
        }
        Console.WriteLine("Removed. The server no longer starts with the computer.");
        return 0;
    }
}

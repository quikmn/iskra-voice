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
///   iskra-server backup &lt;world-folder&gt; &lt;file&gt;         make an encrypted backup
///   iskra-server move &lt;world-folder&gt; &lt;new-address&gt;   publish "this server moved" (or --cancel)
///   iskra-server import-discord &lt;world-folder&gt; &lt;export&gt; [--read-only]
///   iskra-server templates [name-or-file] [--json]         list starter templates, or check one
///   iskra-server install-autostart &lt;world-folder&gt;       start the server with the computer (remove-autostart undoes it)
///   iskra-server version                                   print the version
/// The passphrase comes from --passphrase-stdin (one line), $ISKRA_BACKUP_PASSPHRASE, or a prompt.
/// </summary>
public static class Cli
{
    private static readonly string[] Commands = ["restore", "backup", "move", "import-discord", "templates", "install-autostart", "remove-autostart", "version", "--version", "help", "--help"];

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
                "backup" when rest.Length == 3 => Backup(rest[1], rest[2], flags),
                "move" when rest.Length == 3 || (rest.Length == 2 && flags.Contains("--cancel")) => Move(rest[1], rest.ElementAtOrDefault(2), flags),
                "import-discord" when rest.Length == 3 => ImportDiscord(rest[1], rest[2], flags),
                "templates" when rest.Length <= 2 => ListTemplates(rest.ElementAtOrDefault(1), flags.Contains("--json")),
                "install-autostart" when rest.Length == 2 => InstallAutostart(rest[1], new RealAutostartSystem()),
                "remove-autostart" when rest.Length == 2 => RemoveAutostart(rest[1], new RealAutostartSystem()),
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
              iskra-server backup <world-folder> <file.iskrabackup>    make an encrypted backup (works while it runs)
              iskra-server move <world-folder> <new-address>           tell members the server moved there
              iskra-server move <world-folder> --cancel                take that notice down again
              iskra-server import-discord <world-folder> <export>      import DiscordChatExporter JSON (a .json or a .zip)
                                                                       add --read-only to make the channels an archive
              iskra-server templates                                   list the starter templates (--json for the details)
              iskra-server templates <name-or-file.json>               check a template and show what it sets up
              iskra-server install-autostart <world-folder>            start this server with the computer (no window)
              iskra-server remove-autostart <world-folder>             undo that
              iskra-server version                                     print the version
            A new server can start from a template: iskra-server <world-folder> --template gaming
            Passphrases: --passphrase-stdin (one line), or $ISKRA_BACKUP_PASSPHRASE, or you're asked.
            Add --json to restore for a machine-readable result.
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
        if (flags.Contains("--json"))
        {
            Console.WriteLine(JsonSerializer.Serialize(new { ok = true, name = result.Name, serverKey = result.ServerKey, folder = result.Folder, uploads = result.Uploads, messages = result.Messages }));
        }
        else
        {
            Console.WriteLine($"Restored '{result.Name}' into {result.Folder} ({result.Messages:N0} messages, {result.Uploads:N0} files).");
            Console.WriteLine($"Start it with: iskra-server \"{result.Folder}\"");
            Console.WriteLine("Check the ports and PublicUrl in server.json if this computer's address is different.");
        }
        return 0;
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
            Console.WriteLine(JsonSerializer.Serialize(templates.Select(t => new
            {
                id = t.Id,
                name = t.Template.Name,
                description = t.Template.Description,
                categories = t.Template.Categories.Select(c => new { name = c.Name, channels = c.Channels.Select(ChannelView) }),
                channels = t.Template.Channels.Select(ChannelView),
                roles = t.Template.Roles.Select(r => r.Name),
                rules = t.Template.Rules is not null,
            }), new JsonSerializerOptions(JsonSerializerDefaults.Web)));
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
            if (template.Rules is not null) Console.WriteLine("    Rules: yes");
        }
        if (which is null) Console.WriteLine("Use one for a new server: iskra-server <world-folder> --template <name>, or \"Template\": \"<name>\" in server.json.");
        return 0;

        static object ChannelView(TemplateChannel c) => new { name = c.Name, kind = c.Kind, userLimit = c.UserLimit };
        static string Describe(TemplateChannel c) =>
            c.Kind == "voice" ? $"(voice) {c.Name}{(c.UserLimit > 0 ? $" (up to {c.UserLimit})" : "")}" : $"# {c.Name}";
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

using System.Text.Json;
using Iskra.Server.Backups;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Files;
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
/// The passphrase comes from --passphrase-stdin (one line), $ISKRA_BACKUP_PASSPHRASE, or a prompt.
/// </summary>
public static class Cli
{
    private static readonly string[] Commands = ["restore", "backup", "move", "import-discord", "help", "--help"];

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
                _ => Usage(),
            };
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException or System.Security.Cryptography.CryptographicException)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
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
            Console.WriteLine("The move notice is gone. Start the server as usual.");
            return 0;
        }
        var clean = MoveFeature.CleanUrl(url) ?? throw new InvalidDataException("That isn't an http(s) address.");
        MoveFeature.Publish(world, clean, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
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
}

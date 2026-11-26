using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Protocol;
using Iskra.Server.Storage;

namespace Iskra.Server;

/// <summary>
/// <c>iskra-server webhooks</c>: list, create and delete incoming webhooks from the server's own computer, for
/// scripts and setup without the app. Works while the server runs (the database is shared, like <c>backup</c>).
/// </summary>
public static partial class Cli
{
    private const string WebhooksUsage = """
        iskra-server webhooks <world-folder> [--json]                               list the webhooks
        iskra-server webhooks create <world-folder> <channel> <name> [--mentions]   make one; prints its secret URL once
          [--signing-secret-stdin] [--json]                                         (channel: name or id; a GitHub/Gitea/GitLab
                                                                                    signing secret is read as one line)
        iskra-server webhooks delete <world-folder> <id>                            delete one (its URL stops working)
        """;

    private static int Webhooks(string[] rest, HashSet<string> flags) => Webhooks(rest, flags, Console.In, Console.Out, Console.Error);

    /// <summary><paramref name="rest"/> is the arguments without flags, starting with "webhooks".</summary>
    internal static int Webhooks(string[] rest, HashSet<string> flags, TextReader input, TextWriter output, TextWriter error)
    {
        try
        {
            return rest switch
            {
                [_, var world] when world is not ("create" or "delete") => ListWebhooks(world, flags.Contains("--json"), output),
                [_, "create", var world, var channel, var name] => CreateWebhook(world, channel, name, flags, input, output),
                [_, "delete", var world, var id] => DeleteWebhook(world, id, output),
                _ => WebhooksHelp(error),
            };
        }
        catch (Exception ex) when (ex is RequestException or IOException or InvalidDataException or UnauthorizedAccessException)
        {
            error.WriteLine(ex.Message);
            return 1;
        }
    }

    private static int WebhooksHelp(TextWriter error)
    {
        error.WriteLine("Usage:");
        error.WriteLine(WebhooksUsage);
        return 2;
    }

    private static World OpenServerFolder(string worldPath)
    {
        if (!File.Exists(Path.Combine(worldPath, "server.key"))) throw new IOException($"{worldPath} isn't an Iskra server folder.");
        return World.OpenOrCreate(worldPath);
    }

    private static int ListWebhooks(string worldPath, bool json, TextWriter output)
    {
        using var world = OpenServerFolder(worldPath);
        var store = world.Store;
        var channels = store.AllChannels().ToDictionary(c => c.Id, c => c.Name);
        var hooks = store.Webhooks(null);
        if (json)
        {
            output.WriteLine(JsonSerializer.Serialize(new { webhooks = hooks.Select(w => WebhookFeature.View(store, w)) }, Json.Options));
            return 0;
        }
        if (hooks.Count == 0)
        {
            output.WriteLine($"'{world.Settings.Name}' has no webhooks.");
            return 0;
        }
        foreach (var w in hooks)
        {
            var used = w.LastUsedAt is { } at ? DateTimeOffset.FromUnixTimeMilliseconds(at).ToString("yyyy-MM-dd HH:mm") + " UTC" : "never";
            var signed = store.WebhookSigningSecret(w.Id) is null ? "" : ", signed";
            output.WriteLine($"  {w.Id}  #{channels.GetValueOrDefault(w.ChannelId, "?")}  {w.Name}  (last used {used}{signed})");
        }
        output.WriteLine("The secret URLs aren't stored, so they can't be shown again. Delete and create one for a new URL.");
        return 0;
    }

    /// <summary>A text channel by id, by exact name (with or without '#'), or by name ignoring case if that's unique.</summary>
    private static Channel FindTextChannel(Store store, string nameOrId)
    {
        var all = store.AllChannels();
        var name = nameOrId.TrimStart('#');
        var match = long.TryParse(nameOrId, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var id)
            ? all.FirstOrDefault(c => c.Id == id)
            : null;
        match ??= all.Where(c => c.Name == name).ToList() is [var exact] ? exact : null;
        match ??= all.Where(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase)).ToList() is [var loose] ? loose : null;
        if (match is null)
        {
            var texts = string.Join(", ", all.Where(c => c.Kind == "text").Select(c => $"#{c.Name} ({c.Id})"));
            throw new InvalidDataException($"No single channel called '{nameOrId}'. Text channels: {texts}");
        }
        if (match.Kind != "text") throw new InvalidDataException($"#{match.Name} is a {match.Kind} channel; webhooks can only post in text channels.");
        E2eeChannelFeature.RefusePlaintext(store, match, "Webhooks");
        return match;
    }

    private static int CreateWebhook(string worldPath, string channelName, string rawName, HashSet<string> flags, TextReader input, TextWriter output)
    {
        // Read the signing secret before opening anything, so a bad one changes nothing.
        var signing = flags.Contains("--signing-secret-stdin") ? WebhookSigningFeature.Check((input.ReadLine() ?? "").TrimEnd('\r')) : null;
        using var world = OpenServerFolder(worldPath);
        var store = world.Store;
        var channel = FindTextChannel(store, channelName);
        var name = WebhookFeature.Name(rawName);
        if (store.CountWebhooks(channel.Id) >= WebhookFeature.MaxPerChannel)
            throw new InvalidDataException($"#{channel.Name} already has {WebhookFeature.MaxPerChannel} webhooks, the most a channel can have.");

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var (secret, hash) = WebhookFeature.NewSecret();
        // Made by the owner as far as the app shows; "server" if nobody has claimed the server yet.
        var hook = new Webhook(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)), channel.Id, name, null, hash,
            flags.Contains("--mentions"), store.OwnerKey() ?? "server", now, null);
        store.AddWebhook(hook);
        if (signing is not null) store.SetWebhookSigningSecret(hook.Id, signing);
        store.AddAudit(now, "webhook.create", hook.CreatedBy, store.GetMember(hook.CreatedBy)?.Name ?? "", null, null, null,
            JsonSerializer.Serialize(new { id = hook.Id, name = hook.Name, channelId = hook.ChannelId, cli = true }, Json.Options));

        var url = world.Settings.EffectivePublicUrl + WebhookFeature.PathFor(hook, secret);
        if (flags.Contains("--json"))
        {
            output.WriteLine(JsonSerializer.Serialize(new { webhook = WebhookFeature.View(store, hook), secret, url, github = url + "/github" }, Json.Options));
            return 0;
        }
        output.WriteLine($"Made webhook '{hook.Name}' ({hook.Id}) in #{channel.Name}.");
        output.WriteLine($"URL (Discord-style JSON): {url}");
        output.WriteLine($"GitHub: {url}/github   Gitea: {url}/gitea   GitLab: {url}/gitlab   Slack: {url}/slack");
        output.WriteLine(signing is null
            ? "Keep the URL secret: anyone with it can post. It isn't shown again."
            : "Signed: GitHub, Gitea and GitLab posts must carry the signing secret; the plain and Slack formats are refused. The URL isn't shown again.");
        return 0;
    }

    private static int DeleteWebhook(string worldPath, string id, TextWriter output)
    {
        using var world = OpenServerFolder(worldPath);
        var store = world.Store;
        var hook = store.GetWebhook(id) ?? throw new InvalidDataException($"No webhook with the id '{id}'. 'iskra-server webhooks {worldPath}' lists them.");
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var actor = store.OwnerKey() ?? "server";
        store.AddAudit(now, "webhook.delete", actor, store.GetMember(actor)?.Name ?? "", null, null, null,
            JsonSerializer.Serialize(new { id = hook.Id, name = hook.Name, channelId = hook.ChannelId, cli = true }, Json.Options));
        store.DeleteWebhook(hook.Id);
        output.WriteLine($"Deleted webhook '{hook.Name}'. Its URL no longer works.");
        return 0;
    }
}

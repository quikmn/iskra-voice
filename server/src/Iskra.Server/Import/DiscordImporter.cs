using System.Globalization;
using System.Text;
using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Files;
using Iskra.Server.Storage;

namespace Iskra.Server.Import;

public sealed record ImportOptions
{
    /// <summary>Imported channels are read-only for everyone below admin (an archive) instead of open for chat.</summary>
    public bool ReadOnly { get; init; }
    /// <summary>The owner who ran the import: pins and threads are theirs. Null from the command line (the first owner, if any).</summary>
    public string? ImportedBy { get; init; }
    public long MaxFileBytes { get; init; } = 100L * 1024 * 1024;
    /// <summary>Everything read from the upload (JSON and media, unpacked) together.</summary>
    public long MaxTotalBytes { get; init; } = 16L * 1024 * 1024 * 1024;
}

/// <summary>How far an import is. Sent to the owner as it goes.</summary>
public sealed record ImportProgress
{
    public string Phase { get; init; } = "reading"; // reading | importing | done | failed | cancelled
    public int Channels { get; init; }
    public int ChannelsDone { get; init; }
    public long Messages { get; init; }
    public long MessagesDone { get; init; }
    public int Files { get; init; }
    public int MissingFiles { get; init; }
    public long Skipped { get; init; }
    public string? Current { get; init; }
    public string? Error { get; init; }
    public List<string> Warnings { get; init; } = [];
}

/// <summary>An imported channel, with the Discord category it came from (kept for channel categories).</summary>
public sealed record ImportedChannel(long Id, string Name, string? Category, long Messages, bool Thread);

/// <summary>
/// Imports DiscordChatExporter JSON exports: each Discord channel becomes a text channel here (threads become threads
/// when their starting message was imported too), with the original authors' names and avatars shown as imported
/// (they aren't accounts here), timestamps, replies, attachments (when the export includes media), reaction counts and pins.
/// Roles aren't in these exports, so they can't be imported.
/// </summary>
public sealed class DiscordImporter(World world, Uploads uploads, ImportOptions options, Action<ImportProgress>? report = null)
{
    public const string Source = "discord";
    public const string AuthorPrefix = "discord:";
    public const int MaxChannels = 500;
    private const int BatchSize = 500;

    // ── HOOK(categories) ────────────────────────────────────────────────────
    // Channel categories are being added on another branch. Once they're merged, set this (e.g. in Program.cs or the
    // categories feature) to put each imported channel into the category with this name, creating it if needed.
    // It's called once per imported top-level channel, right after the channel is created; the Discord category name
    // is also stored in imported_channels.category (Store.ImportedCategory) so channels imported before can be sorted later.
    public static Action<World, long, string?>? AssignCategory { get; set; }

    private readonly Dictionary<string, (long Id, long Channel)> _ids = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _channels = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string?> _channelCategory = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string?> _mediaFiles = new(StringComparer.Ordinal);
    private readonly HashSet<string> _authors = new(StringComparer.Ordinal);
    private readonly List<long> _created = [];
    private readonly List<ImportedChannel> _result = [];
    private ImportProgress _progress = new();
    private long _bytes;

    private string Uploader => options.ImportedBy ?? "import:discord";

    public IReadOnlyList<ImportedChannel> Channels => _result;
    public ImportProgress Progress => _progress;

    private sealed record Plan(ExportDocument Document, DceChannel Channel, DceGuild? Guild, long Count, long FirstAt);

    /// <summary>Runs the import. On failure or cancellation every channel it made is removed again.</summary>
    public ImportProgress Run(ExportSource source, CancellationToken cancel = default)
    {
        try
        {
            if (source.UnsafeEntries > 0) Warn($"{source.UnsafeEntries} files in the zip had unsafe names and were skipped.");
            var plans = Scan(source, cancel);
            var groups = plans.GroupBy(p => p.Channel.Id!).Select(g => g.OrderBy(p => p.FirstAt).ThenBy(p => p.Document.Name, StringComparer.Ordinal).ToList()).ToList();
            if (groups.Count == 0) throw new InvalidDataException("No channels found. Export with DiscordChatExporter in JSON format.");
            if (groups.Count > MaxChannels) throw new InvalidDataException($"That's more than {MaxChannels} channels. Import them in smaller batches.");
            Update(p => p with { Phase = "importing", Channels = groups.Count, Messages = plans.Sum(x => x.Count) });

            // Channels first (by category, then name), then threads, so a thread can find its starting message.
            var ordered = groups
                .OrderBy(g => g[0].Channel.IsThread)
                .ThenBy(g => g[0].Channel.IsThread ? "" : g[0].Channel.Category ?? "", StringComparer.OrdinalIgnoreCase)
                .ThenBy(g => g[0].Channel.Name ?? "", StringComparer.OrdinalIgnoreCase);
            foreach (var group in ordered)
            {
                cancel.ThrowIfCancellationRequested();
                ImportChannel(source, group, cancel);
                Update(p => p with { ChannelsDone = p.ChannelsDone + 1 });
            }
            Update(p => p with { Phase = "done", Current = null });
            return _progress;
        }
        catch (Exception ex)
        {
            Undo();
            var cancelled = ex is OperationCanceledException;
            Update(p => p with
            {
                Phase = cancelled ? "cancelled" : "failed",
                Error = cancelled ? null : ex is InvalidDataException or IOException ? ex.Message : "Something went wrong while importing.",
            });
            throw;
        }
    }

    private void Undo()
    {
        foreach (var id in _created) world.Store.DeleteChannel(id);
        _created.Clear();
        _result.Clear();
    }

    private void Update(Func<ImportProgress, ImportProgress> change)
    {
        _progress = change(_progress);
        report?.Invoke(_progress);
    }

    private void Warn(string warning)
    {
        if (_progress.Warnings.Count < 20) _progress.Warnings.Add(warning);
    }

    private bool Take(long bytes)
    {
        _bytes += bytes;
        return _bytes <= options.MaxTotalBytes;
    }

    /// <summary>A first pass over every export: which channel it is, how many messages, and when it starts.</summary>
    private List<Plan> Scan(ExportSource source, CancellationToken cancel)
    {
        var plans = new List<Plan>();
        foreach (var document in source.Documents)
        {
            cancel.ThrowIfCancellationRequested();
            Update(p => p with { Current = document.Name });
            using var stream = new LimitedStream(source.OpenDocument(document), _ => true);
            var reader = new DceReader(stream);
            long count = 0;
            long first = long.MaxValue;
            try
            {
                reader.Read(message =>
                {
                    cancel.ThrowIfCancellationRequested();
                    count++;
                    return true;
                }, parseMessages: false);
                // The first message again, parsed this time, for its timestamp (cheap: stops right after it).
                if (count > 0)
                {
                    using var again = source.OpenDocument(document);
                    new DceReader(again).Read(message =>
                    {
                        first = ParseTime(message?.Timestamp) ?? long.MaxValue;
                        return false;
                    });
                }
            }
            catch (InvalidDataException ex)
            {
                Warn($"{document.Name}: {ex.Message}");
                continue;
            }
            if (reader.Channel?.Id is not { Length: > 0 and <= 32 })
            {
                Warn($"{document.Name} isn't a channel export; skipped.");
                continue;
            }
            if (reader.Channel.Type is "DirectTextChat" or "DirectGroupTextChat")
            {
                Warn($"{document.Name} is a direct message export; only server channels are imported.");
                continue;
            }
            plans.Add(new Plan(document, reader.Channel, reader.Guild, count, first));
        }
        return plans;
    }

    private void ImportChannel(ExportSource source, List<Plan> parts, CancellationToken cancel)
    {
        var info = parts[0].Channel;
        var guild = parts[0].Guild?.Name;
        long channelId;
        var thread = false;
        string? category;
        if (info.IsThread)
        {
            // The exporter calls a thread's parent channel its "category".
            _channelCategory.TryGetValue(info.CategoryId ?? "", out category);
            channelId = ThreadOrChannel(info, parts, out thread, category);
        }
        else
        {
            category = Clean(info.Category, 100, newlines: false);
            channelId = NewChannel(info.Name, category, info.Id!, guild);
        }
        _channels[info.Id!] = channelId;
        _channelCategory[info.Id!] = category;

        long imported = 0;
        var rows = new List<ImportRow>(BatchSize);
        void Flush()
        {
            if (rows.Count == 0) return;
            world.Store.ImportMessages(channelId, Source, rows, _ids, options.ImportedBy ?? world.Store.OwnerKey() ?? Uploader, PinFeature.MaxPins);
            imported += rows.Count;
            var n = rows.Count;
            rows.Clear();
            Update(p => p with { MessagesDone = p.MessagesDone + n });
        }

        foreach (var part in parts)
        {
            Update(p => p with { Current = info.Name });
            using var stream = new LimitedStream(source.OpenDocument(part.Document), Take);
            new DceReader(stream).Read(message =>
            {
                cancel.ThrowIfCancellationRequested();
                if (message is not null && Convert(source, part.Document, message) is { } row) rows.Add(row);
                else Update(p => p with { Skipped = p.Skipped + 1 });
                if (rows.Count >= BatchSize) Flush();
                return true;
            });
            Flush();
        }
        _result.Add(new ImportedChannel(channelId, world.Store.GetChannel(channelId)?.Name ?? "", category, imported, thread));
    }

    private long NewChannel(string? rawName, string? category, string originalId, string? guild)
    {
        var name = ChannelName(rawName);
        var unique = name;
        for (var n = 2; world.Store.ChannelNameTaken(unique); n++)
        {
            var suffix = $"-{n}";
            unique = (name.Length + suffix.Length > ChannelFeature.MaxNameLength ? name[..(ChannelFeature.MaxNameLength - suffix.Length)] : name) + suffix;
        }
        var channel = world.Store.CreateChannel(unique, "text", Sessions.Roles.Member, options.ReadOnly ? Sessions.Roles.Admin : Sessions.Roles.Member,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        _created.Add(channel.Id);
        world.Store.MarkImportedChannel(channel.Id, Source, originalId, category, guild, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        AssignCategory?.Invoke(world, channel.Id, category); // HOOK(categories), see above
        return channel.Id;
    }

    /// <summary>A Discord thread becomes a thread here when its starting message was imported into its parent; else a channel of its own.</summary>
    private long ThreadOrChannel(DceChannel info, List<Plan> parts, out bool thread, string? category)
    {
        thread = false;
        if (info.CategoryId is { } parentId && _channels.TryGetValue(parentId, out var parentChannel)
            && _ids.TryGetValue(info.Id!, out var root) && root.Channel == parentChannel
            && world.Store.ThreadForRoot(root.Id) is null && world.Store.ThreadCount(parentChannel) < ThreadFeature.MaxThreadsPerChannel
            && world.Store.GetChannel(parentChannel) is { } parent)
        {
            var name = Clean(info.Name, 100, newlines: false) ?? "Thread";
            var created = parts[0].FirstAt == long.MaxValue ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : parts[0].FirstAt;
            thread = true;
            return world.Store.CreateThread(parent, root.Id, name, options.ImportedBy ?? world.Store.OwnerKey() ?? Uploader, created).Id;
        }
        return NewChannel(info.Name, category, info.Id!, parts[0].Guild?.Name);
    }

    /// <summary>Channel names here are lowercase with dashes, ≤ 32 characters.</summary>
    public static string ChannelName(string? raw)
    {
        var clean = Clean(raw, 200, newlines: false) ?? "";
        var name = string.Join('-', clean.ToLowerInvariant().Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries));
        name = TrimTo(name, ChannelFeature.MaxNameLength).Trim('-');
        return name.Length == 0 ? "imported" : name;
    }

    // ── One message ──────────────────────────────────────────────────────────

    private const char LineSeparator = (char)0x2028;
    private const char ParagraphSeparator = (char)0x2029;
    private const char ZeroWidthJoiner = (char)0x200D;

    private static readonly HashSet<string> ImportedTypes = ["Default", "Reply", "ChatInputCommand", "ContextMenuCommand"];

    /// <summary>The row to store, or null for messages that don't carry anything to keep (system notices, empty ones).</summary>
    private ImportRow? Convert(ExportSource source, ExportDocument document, DceMessage m)
    {
        if (m.Id is not { Length: > 0 and <= 32 } id) return null;
        if (m.Type is { } type && !ImportedTypes.Contains(type)) return null;
        if (ParseTime(m.Timestamp) is not { } createdAt) return null;

        var author = Author(source, document, m.Author);
        var text = new StringBuilder(Clean(m.Content, ChatFeature.MaxMessageLength, newlines: true) ?? "");
        if (m.ForwardedMessage?.Content is { } forwarded && Clean(forwarded, ChatFeature.MaxMessageLength, newlines: true) is { } quoted)
            Append(text, "Forwarded:\n" + quoted);
        foreach (var sticker in (m.Stickers ?? []).Take(3))
            if (Clean(sticker.Name, 60, newlines: false) is { } stickerName) Append(text, $"[Sticker: {stickerName}]");
        if (text.Length == 0)
        {
            // Bot posts are often only an embed: keep its words.
            foreach (var embed in (m.Embeds ?? []).Take(3))
            {
                var parts = new[] { Clean(embed.Title, 256, false), Clean(embed.Description, 2000, true), Clean(embed.Url, 500, false) }
                    .Where(p => p is { Length: > 0 });
                Append(text, string.Join('\n', parts));
            }
        }

        var attachments = new List<string>();
        var missing = new List<object>();
        foreach (var attachment in (m.Attachments ?? []).Concat(m.ForwardedMessage?.Attachments ?? []).Take(ChatFeature.MaxAttachments))
        {
            var name = FileSniffer.CleanName(attachment.FileName ?? "file");
            if (attachment.Url is { Length: > 0 } url && Media(source, document, url, name, options.MaxFileBytes) is { } fileId)
            {
                attachments.Add(fileId);
                Update(p => p with { Files = p.Files + 1 });
            }
            else
            {
                missing.Add(new { name, size = Math.Max(0, attachment.FileSizeBytes) });
                Update(p => p with { MissingFiles = p.MissingFiles + 1 });
            }
        }

        var reactions = (m.Reactions ?? [])
            .Select(r => (Emoji: ReactionLabel(r.Emoji), Count: Math.Clamp(r.Count, 1, 1_000_000)))
            .Where(r => r.Emoji is not null)
            .DistinctBy(r => r.Emoji)
            .Take(ChatFeature.MaxReactionsPerMessage)
            .Select(r => new { emoji = r.Emoji, count = r.Count })
            .ToList();

        var body = TrimTo(text.ToString().Trim(), ChatFeature.MaxMessageLength);
        if (body.Length == 0 && attachments.Count == 0 && missing.Count == 0) return null;
        return new ImportRow(id, author, body, createdAt, ParseTime(m.TimestampEdited), [.. attachments],
            m.Reference?.MessageId is { Length: > 0 and <= 32 } reply ? reply : null,
            reactions.Count == 0 ? null : JsonSerializer.Serialize(reactions),
            missing.Count == 0 ? null : JsonSerializer.Serialize(missing),
            m.IsPinned);
    }

    private static void Append(StringBuilder text, string part)
    {
        if (part.Length == 0) return;
        if (text.Length > 0) text.Append('\n');
        text.Append(part);
    }

    /// <summary>"discord:&lt;user id&gt;", stored once with the name and avatar from the newest message seen.</summary>
    private string Author(ExportSource source, ExportDocument document, DceUser? user)
    {
        var id = user?.Id is { Length: > 0 and <= 24 } raw && raw.All(char.IsAsciiDigit) ? raw : "unknown";
        var key = AuthorPrefix + id;
        if (_authors.Add(key))
        {
            var name = Clean(user?.Nickname, 32, false) ?? Clean(user?.Name, 32, false) ?? "Discord user";
            string? avatar = null;
            if (user?.AvatarUrl is { Length: > 0 } url && Media(source, document, url, "avatar", 1024 * 1024) is { } fileId
                && world.Store.GetFile(fileId) is { Type: "image/png" or "image/jpeg" or "image/webp" or "image/gif" })
                avatar = fileId;
            world.Store.UpsertImportedAuthor(new ImportedAuthor(key, Source, name, avatar, user?.IsBot ?? false));
        }
        return key;
    }

    /// <summary>A media file from the export, stored as an upload (typed by its content), or null if it isn't there.</summary>
    private string? Media(ExportSource source, ExportDocument document, string reference, string name, long maxBytes)
    {
        var cacheKey = $"{document.Directory}\n{reference}\n{maxBytes}";
        if (_mediaFiles.TryGetValue(cacheKey, out var cached)) return cached;
        string? id = null;
        if (source.OpenMedia(document, reference) is { } media)
        {
            using var stream = new LimitedStream(media.Stream, Take);
            if (media.Length <= maxBytes) id = uploads.StoreLocal(stream, name, Uploader, maxBytes)?.Id;
        }
        _mediaFiles[cacheKey] = id;
        return id;
    }

    private static string? ReactionLabel(DceEmoji? emoji)
    {
        if (emoji?.Name is not { Length: > 0 } name) return null;
        // Custom Discord emoji aren't on this server: shown by name.
        var label = emoji.Id is { Length: > 0 } ? $":{name}:" : name;
        return Clean(label, 34, false) is { } clean && !clean.Contains(' ') ? clean : null;
    }

    public static long? ParseTime(string? text) =>
        DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) && at.Year >= 2015 && at.Year < 2200
            ? at.ToUnixTimeMilliseconds()
            : null;

    /// <summary>
    /// Text as Iskra stores it: NFC, newlines as \n, no control or invisible formatting characters (dropped, not refused:
    /// one odd character shouldn't lose a message), at most <paramref name="max"/> characters. Null if nothing is left.
    /// </summary>
    public static string? Clean(string? text, int max, bool newlines)
    {
        if (string.IsNullOrEmpty(text)) return null;
        var normalized = text.Replace("\r\n", "\n").Normalize(NormalizationForm.FormC);
        var builder = new StringBuilder(Math.Min(normalized.Length, max + 16));
        foreach (var c in normalized)
        {
            if (c is '\n' or '\t' or LineSeparator or ParagraphSeparator)
            {
                builder.Append(newlines ? (c == '\t' ? '\t' : '\n') : ' ');
                continue;
            }
            if (c == ZeroWidthJoiner) { builder.Append(c); continue; } // for emoji sequences
            var category = char.GetUnicodeCategory(c);
            if (category is UnicodeCategory.Control or UnicodeCategory.Format) continue;
            builder.Append(c);
            if (builder.Length > max * 2) break;
        }
        var result = TrimTo(builder.ToString().Trim(), max).Trim();
        return result.Length == 0 ? null : result;
    }

    /// <summary>Cuts to <paramref name="max"/> UTF-16 units without splitting a surrogate pair.</summary>
    private static string TrimTo(string text, int max)
    {
        if (text.Length <= max) return text;
        var cut = char.IsHighSurrogate(text[max - 1]) ? max - 1 : max;
        return text[..cut];
    }
}

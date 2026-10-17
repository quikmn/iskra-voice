using System.Collections.Concurrent;
using System.IO.Compression;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>What to export (checked by ChannelExportFeature before a job starts).</summary>
public sealed record ExportRequest(string Requester, string RequesterName, string ServerName, IReadOnlyList<Channel> Channels, long? From, long? To,
    bool Attachments, bool Threads, TimeZoneInfo Zone, string Lang);

/// <summary>
/// Channel exports (admins): a zip per job with, for each channel, channel.html (readable offline), channel.json (a
/// versioned schema) and the attachments, built in the background behind a short-lived link. One job at a time per
/// server. Files go to the world's exports/ folder, which backups leave out; leftovers go when the server starts
/// (DataExports.CleanUp), and each file is deleted when its link expires.
/// </summary>
public sealed class ChannelExports
{
    public const int MaxChannels = 25;

    /// <summary>Attachment extensions kept as they are in a zip; everything else gets ".bin" added.</summary>
    public static readonly HashSet<string> PassiveExtensions =
        ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "mp4", "webm", "mov", "mp3", "ogg", "opus", "wav", "flac", "m4a", "txt", "md", "csv", "zip", "7z"];

    /// <summary>Free disk space we keep on top of an export's estimated size.</summary>
    public const long DiskMargin = 1L << 30;
    public const int Version = 1;
    public const string Format = "iskra-channel-export";
    private const int Page = 200;

    private static readonly ConditionalWeakTable<World, ChannelExports> PerWorld = new();

    /// <summary>The exports of this world (one service per world, so the endpoint and the requests share it).</summary>
    public static ChannelExports For(World world) => PerWorld.GetValue(world, w => new ChannelExports(w));

    private readonly World _world;
    private readonly ConcurrentDictionary<string, Job> _jobs = new();
    private readonly ConcurrentDictionary<string, Job> _byToken = new();
    private int _running;

    private ChannelExports(World world) => _world = world;

    /// <summary>How long a finished export can be downloaded (then the file is deleted).</summary>
    public TimeSpan Lifetime { get; set; } = TimeSpan.FromHours(1);
    /// <summary>The biggest zip a job may write.</summary>
    public long MaxBytes { get; set; } = 1L << 30;
    public TimeProvider Time { get; set; } = TimeProvider.System;
    public ILogger? Log { get; set; }
    /// <summary>Free bytes on the disk that holds a folder (tests replace it).</summary>
    public Func<string, long> FreeSpace { get; set; } = folder =>
    {
        try { return new DriveInfo(System.IO.Path.GetFullPath(folder)).AvailableFreeSpace; }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException) { return long.MaxValue; } // unknown: don't block
    };
    /// <summary>Called before each channel is written (tests use it to hold a job still).</summary>
    public Action<Job>? BeforeChannel { get; set; }

    /// <summary>
    /// The requester may still export these channels: still a member, still with the permission, and still able to read
    /// each one (rights can change while a job runs or before the link is used).
    /// </summary>
    public static bool StillAllowed(Store store, ExportRequest request, IEnumerable<Channel>? channels = null)
    {
        if (store.GetMember(request.Requester) is not { } me || !Sessions.Permissions.Has(me, Perm.ExportChannels)) return false;
        return (channels ?? request.Channels).All(c => store.GetChannel(c.Id) is { } now && Sessions.Permissions.CanRead(me, now)
            && !E2eeChannelFeature.IsEncrypted(store, now));
    }

    public sealed class Job
    {
        public required string Id { get; init; }
        public required ExportRequest Request { get; init; }
        public required long CreatedAt { get; init; }
        public string State { get; set; } = "running";
        public long Done;
        public long Total;
        public string? Token { get; set; }
        public string? Path { get; set; }
        public string? FileName { get; set; }
        public long? Size { get; set; }
        public long? ExpiresAt { get; set; }
        public RequestException? Error { get; set; }
        public CancellationTokenSource Cancel { get; } = new();
        public ITimer? Expiry { get; set; }
    }

    public static object View(Job j) => new
    {
        id = j.Id,
        state = j.State,
        channelIds = j.Request.Channels.Select(c => c.Id),
        from = j.Request.From,
        to = j.Request.To,
        attachments = j.Request.Attachments,
        threads = j.Request.Threads,
        done = Interlocked.Read(ref j.Done),
        total = Interlocked.Read(ref j.Total),
        createdAt = j.CreatedAt,
        url = j.State == "done" ? $"/channel-export/{j.Token}" : null,
        name = j.FileName,
        size = j.Size,
        expiresAt = j.ExpiresAt,
        error = j.Error is { } e ? new { code = e.Code, message = e.Message, key = e.Key, args = e.Args } : null,
    };

    /// <summary>The requester's jobs, newest first (until they expire).</summary>
    public List<Job> JobsOf(string accountKey)
    {
        Expire();
        return _jobs.Values.Where(j => j.Request.Requester == accountKey).OrderByDescending(j => j.CreatedAt).ToList();
    }

    public Job? Find(string accountKey, string id) =>
        _jobs.TryGetValue(id, out var job) && job.Request.Requester == accountKey ? job : null;

    /// <summary>Starts a job in the background; null when another one is running on this server.</summary>
    public Job? Start(ExportRequest request, Files.Uploads uploads, Action<Job> changed)
    {
        if (Interlocked.CompareExchange(ref _running, 1, 0) != 0) return null;
        Expire();
        var job = new Job
        {
            Id = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(9)),
            Request = request,
            CreatedAt = Time.GetUtcNow().ToUnixTimeMilliseconds(),
        };
        _jobs[job.Id] = job;
        _ = Task.Run(() => Run(job, uploads, changed));
        return job;
    }

    private void Run(Job job, Files.Uploads uploads, Action<Job> changed)
    {
        var folder = System.IO.Path.Combine(_world.Path, DataExports.FolderName);
        var path = System.IO.Path.Combine(folder, $"channels-{Guid.NewGuid():N}.zip");
        try
        {
            AtomicFile.CreatePrivateDirectory(folder);
            var writer = new ExportWriter(_world.Store, uploads, job, MaxBytes, changed)
            {
                FreeSpace = () => FreeSpace(folder),
                BeforeChannel = BeforeChannel,
            };
            writer.Write(path);
            job.Path = path;
            job.Size = new FileInfo(path).Length;
            job.FileName = $"iskra-export-{Slug(_world.Settings.Name, 40)}-{DateTimeOffset.FromUnixTimeMilliseconds(job.CreatedAt):yyyy-MM-dd}.zip";
            job.Token = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(24));
            _byToken[job.Token] = job;
            job.ExpiresAt = (Time.GetUtcNow() + Lifetime).ToUnixTimeMilliseconds();
            job.State = "done"; // last: a status read never sees a finished job without its link and expiry
        }
        catch (Exception ex)
        {
            TryDelete(path);
            if (job.Cancel.IsCancellationRequested) job.State = "cancelled";
            else
            {
                if (ex is not RequestException) Log?.Error(ex, "BAK-160", "backup", "export-failed", ("id", job.Id));
                job.Error = ex as RequestException ?? new RequestException("internal", "The export couldn't be made.", "export_failed");
                job.ExpiresAt = (Time.GetUtcNow() + Lifetime).ToUnixTimeMilliseconds();
                job.State = "failed";
            }
        }
        finally
        {
            job.ExpiresAt ??= (Time.GetUtcNow() + Lifetime).ToUnixTimeMilliseconds();
            job.Expiry = Time.CreateTimer(_ => Remove(job), null, Lifetime, Timeout.InfiniteTimeSpan);
            Volatile.Write(ref _running, 0);
            changed(job);
        }
    }

    /// <summary>GET /channel-export/{token}: the zip as a download until the link expires, or 404.</summary>
    public IResult Serve(HttpContext context, string token)
    {
        Files.Uploads.AllowCors(context);
        Expire();
        if (!_byToken.TryGetValue(token, out var job) || job.Path is null || !File.Exists(job.Path)) return Results.NotFound();
        // Lost the right to export (or to read one of the channels) since: the link and the file go.
        if (!StillAllowed(_world.Store, job.Request))
        {
            Remove(job);
            return Results.NotFound();
        }
        context.Response.Headers.XContentTypeOptions = "nosniff";
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        return Results.File(job.Path, "application/zip", job.FileName);
    }

    /// <summary>Drops jobs whose link has expired (their timers normally do this) and deletes their files.</summary>
    public void Expire()
    {
        var now = Time.GetUtcNow().ToUnixTimeMilliseconds();
        foreach (var job in _jobs.Values)
            if (job.ExpiresAt is { } at && at <= now) Remove(job);
    }

    /// <summary>
    /// The hourly sweep: export zips older than a link's lifetime that no job holds any more (say Windows still had one
    /// open when its timer ran) are deleted.
    /// </summary>
    public int SweepFiles()
    {
        Expire();
        var folder = System.IO.Path.Combine(_world.Path, DataExports.FolderName);
        if (!Directory.Exists(folder)) return 0;
        var held = _jobs.Values.Select(j => j.Path).OfType<string>().Select(System.IO.Path.GetFullPath).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var cutoff = Time.GetUtcNow() - Lifetime;
        var deleted = 0;
        foreach (var file in Directory.EnumerateFiles(folder, "channels-*.zip"))
        {
            if (held.Contains(System.IO.Path.GetFullPath(file)) || File.GetLastWriteTimeUtc(file) > cutoff.UtcDateTime) continue;
            TryDelete(file);
            if (!File.Exists(file)) deleted++;
        }
        return deleted;
    }

    private void Remove(Job job)
    {
        _jobs.TryRemove(job.Id, out _);
        if (job.Token is not null) _byToken.TryRemove(job.Token, out _);
        job.Expiry?.Dispose();
        if (job.Path is not null) TryDelete(job.Path);
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    /// <summary>A safe file or folder name: letters, digits, dot, dash and underscore only.</summary>
    public static string Slug(string name, int max)
    {
        var sb = new StringBuilder();
        foreach (var c in name.Normalize(NormalizationForm.FormKD))
        {
            if (char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_') sb.Append(char.ToLowerInvariant(c));
            else if (char.GetUnicodeCategory(c) == System.Globalization.UnicodeCategory.NonSpacingMark) continue;
            else if (sb.Length > 0 && sb[^1] != '-') sb.Append('-');
        }
        var slug = sb.ToString().Trim('-', '.');
        if (slug.Length > max) slug = slug[..max].Trim('-', '.');
        return slug.Length == 0 ? "export" : slug;
    }
}

/// <summary>Writes one job's zip: per channel a JSON pass, an HTML pass, then the attachments.</summary>
internal sealed class ExportWriter(Store store, Files.Uploads uploads, ChannelExports.Job job, long maxBytes,
    Action<ChannelExports.Job> changed)
{
    private readonly ExportRequest _r = job.Request;
    private long _lastSent;
    private FileStream? _file;
    private Utf8JsonWriter? _json;
    private const int FlushAt = 64 * 1024;

    public Func<long> FreeSpace { get; init; } = () => long.MaxValue;
    public Action<ChannelExports.Job>? BeforeChannel { get; init; }

    public void Write(string path)
    {
        var from = _r.From ?? 0;
        var to = Math.Min(_r.To ?? long.MaxValue, job.CreatedAt);
        var channels = _r.Channels.Select(c => new ChannelPlan(c, Threads(c, from, to))).ToList();

        // Counted up front: an export that can't fit fails at once, before anything is written.
        long items = 0, attachmentBytes = 0;
        foreach (var plan in channels)
        {
            job.Cancel.Token.ThrowIfCancellationRequested();
            if (plan.Channel.Kind == "docs") items += store.DocPageCount(plan.Channel.Id);
            else items += store.ExportMessageCount(plan.Channel.Id, from, to);
            items += plan.Threads.Sum(t => store.ExportMessageCount(t.Id, from, to));
            if (_r.Attachments)
                attachmentBytes += store.ExportAttachmentBytes(plan.Channel.Id, from, to) + plan.Threads.Sum(t => store.ExportAttachmentBytes(t.Id, from, to));
        }
        if (attachmentBytes > maxBytes) throw TooBig();
        // Roughly what the zip needs (attachments, plus a few KB per message in two files), and a margin on top.
        if (FreeSpace() < attachmentBytes + items * 4096 + ChannelExports.DiskMargin)
            throw new RequestException("bad_request", "The server doesn't have enough free disk space for this export.", "export_disk");
        Interlocked.Exchange(ref job.Total, items * 2);

        using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write);
        _file = file;
        using (var zip = new ZipArchive(file, ZipArchiveMode.Create, leaveOpen: true))
        {
            var folders = new HashSet<string>();
            foreach (var plan in channels)
            {
                var folder = $"{plan.Channel.Id}-{ChannelExports.Slug(plan.Channel.Name, 40)}";
                if (!folders.Add(folder)) continue;
                BeforeChannel?.Invoke(job);
                job.Cancel.Token.ThrowIfCancellationRequested();
                if (!ChannelExports.StillAllowed(store, _r, [plan.Channel]))
                    throw RequestException.Forbidden("You can't export channels on this server.", "export_forbidden");
                var ctx = new Context(store, _r, plan.Channel);
                using (var entry = zip.CreateEntry($"{folder}/channel.json", CompressionLevel.Optimal).Open())
                    WriteJson(entry, ctx, plan, from, to);
                using (var entry = zip.CreateEntry($"{folder}/channel.html", CompressionLevel.Optimal).Open())
                    WriteHtml(entry, ctx, plan, from, to);
                foreach (var (fileId, name) in ctx.Files)
                {
                    job.Cancel.Token.ThrowIfCancellationRequested();
                    if (store.GetFile(fileId) is not { } stored || !File.Exists(uploads.PathFor(stored.Sha256))) continue;
                    var level = stored.Type.StartsWith("image/", StringComparison.Ordinal) || stored.Type.StartsWith("video/", StringComparison.Ordinal)
                        || stored.Type.StartsWith("audio/", StringComparison.Ordinal) ? CompressionLevel.NoCompression : CompressionLevel.Optimal;
                    using (var target = zip.CreateEntry($"{folder}/{name}", level).Open())
                    using (var source = File.OpenRead(uploads.PathFor(stored.Sha256)))
                    {
                        // In chunks, so cancelling (and the size cap) stop a big file part way.
                        var buffer = new byte[81920];
                        int read;
                        while ((read = source.Read(buffer)) > 0)
                        {
                            job.Cancel.Token.ThrowIfCancellationRequested();
                            target.Write(buffer, 0, read);
                            CheckSize();
                        }
                    }
                    CheckSize();
                }
            }
            using var readme = new StreamWriter(zip.CreateEntry("README.txt").Open(), new UTF8Encoding(false));
            readme.Write(Readme);
        }
        CheckSize();
    }

    private RequestException TooBig()
    {
        var maxMb = maxBytes / (1024 * 1024);
        return new RequestException("bad_request",
            $"This export would be bigger than {maxMb} MB. Leave out attachments or pick a shorter range.", "export_too_big", new { maxMb });
    }

    private void CheckSize()
    {
        if (_file is { } f && f.Position > maxBytes) throw TooBig();
    }

    private void Step()
    {
        job.Cancel.Token.ThrowIfCancellationRequested();
        // channel.json goes to the zip as it's written, so it never piles up in memory and the size cap sees it grow.
        if (_json is { BytesPending: > FlushAt } json) json.Flush();
        var done = Interlocked.Increment(ref job.Done);
        var total = Interlocked.Read(ref job.Total);
        // About every 2%, so a big export doesn't flood the socket.
        if (done - _lastSent >= Math.Max(total / 50, 1))
        {
            _lastSent = done;
            changed(job);
        }
        if (done % 50 == 0) CheckSize();
    }

    private sealed record ChannelPlan(Channel Channel, List<ThreadInfo> Threads);

    /// <summary>Threads (and forum posts) to include: with a message in the range, or whose first message is.</summary>
    private List<ThreadInfo> Threads(Channel c, long from, long to)
    {
        if (c.Kind == "docs") return [];
        if (!_r.Threads && c.Kind != "forum") return [];
        return store.ThreadIds(c.Id).Select(store.GetThread).OfType<ThreadInfo>()
            .Where(t => store.ExportMessageCount(t.Id, from, to) > 0 || (store.GetMessage(t.RootId) is { } root && InRange(root, from, to)))
            .OrderBy(t => t.RootId).ToList();
    }

    private static bool InRange(Message m, long from, long to) => m.CreatedAt >= from && m.CreatedAt <= to;

    private IEnumerable<Message> Messages(long channelId, long from, long to)
    {
        long after = 0;
        while (true)
        {
            var page = store.ExportMessages(channelId, from, to, after, 200);
            foreach (var m in page)
            {
                after = m.Id;
                yield return m;
            }
            if (page.Count < 200) yield break;
        }
    }

    // ── The shared view of a message ──────────────────────────────────────────

    private sealed record XFile(string Name, string Type, long Size, int? Width, int? Height, string? File);
    private sealed record XEmbed(string? Title, string? Description, string? Url, List<(string Name, string Value)> Fields, string? Footer);
    private sealed record XPoll(string Question, bool Multi, bool Closed, List<(string Text, int Votes)> Options);

    private sealed record XMessage(Message M, string Author, string Text, (long Id, string? Author, string? Excerpt, bool Deleted)? Reply,
        List<XFile> Files, List<(string Emoji, int Count)> Reactions, bool Pinned, XPoll? Poll, List<XEmbed> Embeds, string? Sticker,
        (string? Title, string Url)? Gif, long? VoiceMs, bool Forwarded, long? Thread);

    /// <summary>Authors as a1, a2…: display names at export time, never account keys.</summary>
    private sealed class Context(Store store, ExportRequest r, Channel channel) : ExportMarkdown.IContext
    {
        public readonly Dictionary<string, string> Ids = new();
        public readonly List<(string Id, string Name, string Type)> Authors = [];
        private readonly Dictionary<string, (string Name, string Type)> _byId = new();
        /// <summary>file id → its path in the zip (only with attachments on, and only files still on disk).</summary>
        public readonly Dictionary<string, string> Files = new();
        private readonly Dictionary<string, string?> _names = new();
        private readonly Dictionary<long, string?> _roles = new();
        public Channel Channel => channel;
        public string Word(string key) => ExportPage.Words[r.Lang][key];

        public string? NameOf(string accountKey)
        {
            if (_names.TryGetValue(accountKey, out var name)) return name;
            return _names[accountKey] = store.GetMember(accountKey) is { } m ? store.DisplayName(m) : store.GetDeparture(accountKey)?.Name;
        }

        public string? RoleName(long roleId) => _roles.TryGetValue(roleId, out var n) ? n : _roles[roleId] = store.GetRole(roleId)?.Name;

        public string FormatTime(long ms) =>
            TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeMilliseconds(ms), r.Zone).ToString("yyyy-MM-dd HH:mm", System.Globalization.CultureInfo.InvariantCulture);

        public string AuthorOf(Message m)
        {
            string key, name, type;
            if (m.AuthorKey.StartsWith(WebhookFeature.AuthorPrefix, StringComparison.Ordinal))
            {
                name = store.GetWebhookPost(m.Id)?.Name ?? "Webhook";
                (key, type) = (m.AuthorKey + "\n" + name, "webhook");
            }
            else if (m.AuthorKey.StartsWith(Import.DiscordImporter.AuthorPrefix, StringComparison.Ordinal))
                (key, name, type) = (m.AuthorKey, ImportFeature.AuthorName(store, m.AuthorKey) ?? "Discord user", "imported");
            else if (m.AuthorKey.StartsWith(AutoModFeature.Author, StringComparison.Ordinal))
                (key, name, type) = (AutoModFeature.Author, "AutoMod", "bot");
            else return AuthorOf(m.AuthorKey);
            return Register(key, name, type);
        }

        public string AuthorOf(string accountKey)
        {
            if (Ids.TryGetValue(accountKey, out var known)) return known;
            var member = store.GetMember(accountKey);
            var name = NameOf(accountKey) ?? Word("formerMember");
            return Register(accountKey, name, member is null ? "former" : store.IsBot(accountKey) ? "bot" : "member");
        }

        private string Register(string key, string name, string type)
        {
            if (Ids.TryGetValue(key, out var id)) return id;
            id = $"a{Authors.Count + 1}";
            Ids[key] = id;
            name = ExportMarkdown.Label(name);
            Authors.Add((id, name, type));
            _byId[id] = (name, type);
            return id;
        }

        /// <summary>Any text shown as a name or title: mentions as names (no account keys), no bidi or other format characters.</summary>
        public string P(string? text) => ExportMarkdown.Label(ExportMarkdown.PlainMentions(text ?? "", this));
        public string? PN(string? text) => text is null ? null : P(text);

        public string NameOfId(string id) => _byId[id].Name;
        public string TypeOfId(string id) => _byId[id].Type;

        public string? FilePath(StoredFile f, Files.Uploads uploads)
        {
            if (!r.Attachments) return null;
            if (Files.TryGetValue(f.Id, out var known)) return known;
            if (!File.Exists(uploads.PathFor(f.Sha256))) return null;
            var name = ChannelExports.Slug(System.IO.Path.GetFileNameWithoutExtension(f.Name), 60);
            var ext = System.IO.Path.GetExtension(f.Name).TrimStart('.').ToLowerInvariant();
            // Only passive kinds keep their extension: anything a browser or the system might run or render as a page
            // (html, svg, pdf, js, exe…, or no extension at all) gets ".bin" next to channel.html.
            var suffix = ChannelExports.PassiveExtensions.Contains(ext) ? "." + ext : ext.Length > 0 ? $".{ChannelExports.Slug(ext, 10)}.bin" : ".bin";
            var path = $"attachments/{Files.Count + 1}-{name}{suffix}";
            return Files[f.Id] = path;
        }
    }

    private XMessage View(Context ctx, Message m)
    {
        (long, string?, string?, bool)? reply = null;
        if (m.ReplyTo is { } replyId)
        {
            var original = store.GetMessage(replyId);
            // A reply to something gone (or about to disappear) shows no excerpt.
            reply = original is null || Expiring(original)
                ? (replyId, null, null, true)
                : (replyId, ctx.AuthorOf(original), Excerpt(ExportMarkdown.PlainMentions(original.Text, ctx)), false);
        }
        var files = m.Attachments.Select(store.GetFile).OfType<StoredFile>()
            .Select(f => new XFile(ctx.P(f.Name), f.Type, f.Size, f.Width, f.Height, ctx.FilePath(f, uploads))).ToList();
        var reactions = store.Reactions(m.Id).Select(x => (ctx.P(x.Emoji), x.Accounts.Count)).ToList();
        XPoll? poll = null;
        if (store.GetPoll(m.Id) is { } p)
        {
            var votes = store.PollVotes(m.Id, p.Options.Length);
            poll = new XPoll(ctx.P(p.Question), p.Multi, p.ClosedAt is not null || p.ExpiresAt is { } e && e <= job.CreatedAt,
                p.Options.Select((text, i) => (ctx.P(text), votes[i].Count)).ToList());
        }
        var embeds = new List<XEmbed>();
        if (m.AuthorKey.StartsWith(WebhookFeature.AuthorPrefix, StringComparison.Ordinal) && store.GetWebhookPost(m.Id)?.Embeds is { } json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                foreach (var e in doc.RootElement.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.Object))
                {
                    static string? S(JsonElement o, string name) => o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                    var fields = e.TryGetProperty("fields", out var fs) && fs.ValueKind == JsonValueKind.Array
                        ? fs.EnumerateArray().Where(f => f.ValueKind == JsonValueKind.Object).Select(f => (ctx.P(S(f, "name")), ExportMarkdown.PlainMentions(S(f, "value") ?? "", ctx))).ToList()
                        : [];
                    var footer = e.TryGetProperty("footer", out var ft) && ft.ValueKind == JsonValueKind.Object ? S(ft, "text") : null;
                    var description = S(e, "description") is { } d ? ExportMarkdown.PlainMentions(d, ctx) : null;
                    embeds.Add(new XEmbed(ctx.PN(S(e, "title")), description, S(e, "url"), fields, ctx.PN(footer)));
                }
            }
            catch (JsonException) { }
        }
        var sticker = ctx.PN(store.GetMessageSticker(m.Id)?.Name);
        var gif = store.GetMessageGif(m.Id) is { } g ? (ctx.PN(g.Title), g.Url) : ((string?, string)?)null;
        var voice = store.GetVoiceMessage(m.Id)?.DurationMs;
        var thread = store.ThreadForRoot(m.Id)?.Id;
        return new XMessage(m, ctx.AuthorOf(m), ExportMarkdown.PlainMentions(m.Text, ctx), reply, files, reactions, store.IsPinned(m.Id), poll,
            embeds, sticker, gif, voice, store.GetForward(m.Id) is not null, thread);
    }

    private static string Excerpt(string text) => text.Length <= 140 ? text : text[..140] + "…";

    // ── JSON ─────────────────────────────────────────────────────────────────

    private void WriteJson(Stream stream, Context ctx, ChannelPlan plan, long from, long to)
    {
        using var w = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        _json = w;
        var c = plan.Channel;
        w.WriteStartObject();
        w.WriteString("format", ChannelExports.Format);
        w.WriteNumber("version", ChannelExports.Version);
        w.WriteNumber("exportedAt", job.CreatedAt);
        w.WriteString("exportedBy", _r.RequesterName);
        w.WriteStartObject("server");
        w.WriteString("name", ctx.P(_r.ServerName));
        w.WriteEndObject();
        w.WriteStartObject("channel");
        w.WriteNumber("id", c.Id);
        w.WriteString("name", c.Name);
        w.WriteString("kind", c.Kind);
        w.WriteString("topic", ExportMarkdown.PlainMentions(store.Topic(c.Id), ctx));
        w.WriteEndObject();
        w.WriteStartObject("range");
        if (_r.From is { } f) w.WriteNumber("from", f); else w.WriteNull("from");
        if (_r.To is { } t) w.WriteNumber("to", t); else w.WriteNull("to");
        w.WriteEndObject();
        w.WriteStartObject("includes");
        w.WriteBoolean("attachments", _r.Attachments);
        w.WriteBoolean("threads", _r.Threads);
        w.WriteEndObject();

        w.WriteStartArray("messages");
        if (c.Kind is not ("forum" or "docs"))
            foreach (var m in Messages(c.Id, from, to)) { WriteMessage(w, View(ctx, m)); Step(); }
        w.WriteEndArray();

        w.WriteStartArray("threads");
        if (c.Kind != "forum")
            foreach (var thread in plan.Threads)
            {
                w.WriteStartObject();
                w.WriteNumber("id", thread.Id);
                w.WriteString("name", ctx.P(thread.Name));
                w.WriteNumber("rootId", thread.RootId);
                w.WriteString("author", ctx.AuthorOf(thread.CreatedBy));
                w.WriteNumber("createdAt", thread.CreatedAt);
                w.WriteStartArray("messages");
                foreach (var m in Messages(thread.Id, from, to)) { WriteMessage(w, View(ctx, m)); Step(); }
                w.WriteEndArray();
                w.WriteEndObject();
            }
        w.WriteEndArray();

        w.WriteStartArray("posts");
        if (c.Kind == "forum")
        {
            var tags = store.ForumTags(c.Id).ToDictionary(x => x.Id, x => ctx.P(x.Name));
            foreach (var thread in plan.Threads)
            {
                var post = store.GetForumPost(thread.Id);
                w.WriteStartObject();
                w.WriteNumber("id", thread.Id);
                w.WriteString("title", ctx.P(thread.Name));
                w.WriteString("author", ctx.AuthorOf(thread.CreatedBy));
                w.WriteNumber("createdAt", thread.CreatedAt);
                w.WriteStartArray("tags");
                foreach (var tag in post?.Tags ?? []) if (tags.TryGetValue(tag, out var name)) w.WriteStringValue(name);
                w.WriteEndArray();
                w.WriteBoolean("pinned", post?.PinnedAt is not null);
                w.WriteBoolean("closed", post?.Closed ?? false);
                w.WriteBoolean("locked", post?.Locked ?? false);
                w.WritePropertyName("message");
                if (post?.Root is { } root && InRange(root, from, to) && !Expiring(root)) { WriteMessage(w, View(ctx, root)); Step(); }
                else w.WriteNullValue();
                w.WriteStartArray("comments");
                foreach (var m in Messages(thread.Id, from, to)) { WriteMessage(w, View(ctx, m)); Step(); }
                w.WriteEndArray();
                w.WriteEndObject();
            }
        }
        w.WriteEndArray();

        w.WriteStartArray("pages");
        if (c.Kind == "docs")
            foreach (var page in store.ExportDocPages(c.Id))
            {
                w.WriteStartObject();
                w.WriteNumber("id", page.Id);
                if (page.ParentId is { } parent) w.WriteNumber("parentId", parent); else w.WriteNull("parentId");
                w.WriteString("title", ctx.P(page.Title));
                w.WriteString("text", ExportMarkdown.PlainMentions(page.Text ?? "", ctx));
                w.WriteNumber("createdAt", page.CreatedAt);
                w.WriteNumber("updatedAt", page.UpdatedAt);
                w.WriteString("updatedBy", ctx.AuthorOf(page.UpdatedBy));
                w.WriteEndObject();
                Step();
            }
        w.WriteEndArray();

        w.WriteStartObject("authors");
        foreach (var (id, name, type) in ctx.Authors)
        {
            w.WriteStartObject(id);
            w.WriteString("name", name);
            w.WriteString("type", type);
            w.WriteEndObject();
        }
        w.WriteEndObject();
        w.WriteEndObject();
        w.Flush();
        _json = null;
    }

    private bool Expiring(Message m) => store.MessageExpiry(m.Id).ExpiresAt is not null;

    private static void WriteMessage(Utf8JsonWriter w, XMessage x)
    {
        var m = x.M;
        w.WriteStartObject();
        w.WriteNumber("id", m.Id);
        w.WriteString("author", x.Author);
        w.WriteNumber("createdAt", m.CreatedAt);
        if (m.EditedAt is { } edited) w.WriteNumber("editedAt", edited); else w.WriteNull("editedAt");
        w.WriteString("text", x.Text);
        w.WritePropertyName("replyTo");
        if (x.Reply is { } r)
        {
            w.WriteStartObject();
            w.WriteNumber("id", r.Id);
            if (r.Deleted) w.WriteBoolean("deleted", true);
            else
            {
                w.WriteString("author", r.Author);
                w.WriteString("excerpt", r.Excerpt);
            }
            w.WriteEndObject();
        }
        else w.WriteNullValue();
        w.WriteStartArray("attachments");
        foreach (var f in x.Files)
        {
            w.WriteStartObject();
            w.WriteString("name", f.Name);
            w.WriteString("type", f.Type);
            w.WriteNumber("size", f.Size);
            if (f.Width is { } width) w.WriteNumber("width", width); else w.WriteNull("width");
            if (f.Height is { } height) w.WriteNumber("height", height); else w.WriteNull("height");
            w.WriteString("file", f.File);
            w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteStartArray("reactions");
        foreach (var (emoji, count) in x.Reactions)
        {
            w.WriteStartObject();
            w.WriteString("emoji", emoji);
            w.WriteNumber("count", count);
            w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteBoolean("pinned", x.Pinned);
        w.WritePropertyName("poll");
        if (x.Poll is { } poll)
        {
            w.WriteStartObject();
            w.WriteString("question", poll.Question);
            w.WriteBoolean("multi", poll.Multi);
            w.WriteBoolean("closed", poll.Closed);
            w.WriteStartArray("options");
            foreach (var (text, votes) in poll.Options)
            {
                w.WriteStartObject();
                w.WriteString("text", text);
                w.WriteNumber("votes", votes);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteEndObject();
        }
        else w.WriteNullValue();
        w.WriteStartArray("embeds");
        foreach (var e in x.Embeds)
        {
            w.WriteStartObject();
            w.WriteString("title", e.Title);
            w.WriteString("description", e.Description);
            w.WriteString("url", e.Url);
            w.WriteStartArray("fields");
            foreach (var (name, value) in e.Fields)
            {
                w.WriteStartObject();
                w.WriteString("name", name);
                w.WriteString("value", value);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteString("footer", e.Footer);
            w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteString("sticker", x.Sticker);
        w.WritePropertyName("gif");
        if (x.Gif is { } gif)
        {
            w.WriteStartObject();
            w.WriteString("title", gif.Title);
            w.WriteString("url", gif.Url);
            w.WriteEndObject();
        }
        else w.WriteNullValue();
        w.WritePropertyName("voiceMessage");
        if (x.VoiceMs is { } ms)
        {
            w.WriteStartObject();
            w.WriteNumber("durationMs", ms);
            w.WriteEndObject();
        }
        else w.WriteNullValue();
        w.WriteBoolean("forwarded", x.Forwarded);
        if (x.Thread is { } thread) w.WriteNumber("thread", thread); else w.WriteNull("thread");
        w.WriteEndObject();
    }

    // ── HTML ─────────────────────────────────────────────────────────────────

    private void WriteHtml(Stream stream, Context ctx, ChannelPlan plan, long from, long to)
    {
        using var w = new StreamWriter(stream, new UTF8Encoding(false), 64 * 1024);
        var c = plan.Channel;
        static string E(string s) => ExportMarkdown.Escape(s);
        var serverName = ctx.P(_r.ServerName);
        var prefix = c.Kind is "docs" or "forum" ? "" : "#";
        w.Write(ExportPage.Head(_r.Lang, $"{prefix}{c.Name} · {serverName}"));
        w.Write("<header class=\"top\"><div class=\"wrap\"><div class=\"server\">");
        w.Write(E(serverName));
        w.Write("</div><h1>");
        w.Write(E(prefix + c.Name));
        w.Write("</h1>");
        if (store.Topic(c.Id) is { Length: > 0 } topic) w.Write($"<p class=\"topic\">{ExportMarkdown.InlineHtml(topic, ctx)}</p>");
        w.Write($"<p class=\"meta\">{E(string.Format(ctx.Word("exported"), _r.RequesterName, ctx.FormatTime(job.CreatedAt)))}");
        if (_r.From is not null || _r.To is not null)
            w.Write(" · " + E(string.Format(ctx.Word("range"), _r.From is { } f ? ctx.FormatTime(f) : ctx.Word("start"), _r.To is { } t ? ctx.FormatTime(t) : ctx.Word("now"))));
        w.Write("</p></div></header>\n<main>\n");

        var threadsByRoot = plan.Threads.ToDictionary(t => t.RootId);
        var shown = new HashSet<long>();
        if (c.Kind == "forum")
        {
            var tags = store.ForumTags(c.Id).ToDictionary(x => x.Id, x => ctx.P(x.Name));
            if (plan.Threads.Count == 0) w.Write($"<p class=\"empty\">{E(ctx.Word("noPosts"))}</p>");
            foreach (var thread in plan.Threads)
            {
                var post = store.GetForumPost(thread.Id);
                w.Write($"<section class=\"post\" id=\"t{thread.Id}\"><h2>{E(ctx.P(thread.Name))}</h2><p class=\"head\">");
                foreach (var tag in post?.Tags ?? []) if (tags.TryGetValue(tag, out var name)) w.Write($"<span class=\"tag\">{E(name)}</span> ");
                if (post?.PinnedAt is not null) w.Write($"<span class=\"pin\">📌 {E(ctx.Word("pinned"))}</span> ");
                if (post?.Closed == true) w.Write($"<span class=\"tag\">{E(ctx.Word("closed"))}</span> ");
                if (post?.Locked == true) w.Write($"<span class=\"tag\">{E(ctx.Word("locked"))}</span> ");
                w.Write("</p>");
                if (post?.Root is { } root && InRange(root, from, to) && !Expiring(root)) { WriteHtmlMessage(w, ctx, View(ctx, root), null); Step(); }
                var comments = Messages(thread.Id, from, to).ToList();
                if (comments.Count > 0) w.Write($"<h3>{E(ctx.Word("comments"))}</h3>");
                foreach (var m in comments) { WriteHtmlMessage(w, ctx, View(ctx, m), null); Step(); }
                w.Write("</section>\n");
            }
        }
        else if (c.Kind == "docs")
        {
            var pages = store.ExportDocPages(c.Id);
            if (pages.Count == 0) w.Write($"<p class=\"empty\">{E(ctx.Word("noPages"))}</p>");
            foreach (var page in pages)
            {
                w.Write($"<section class=\"page\" id=\"p{page.Id}\"><h2>{E(ctx.P(page.Title))}</h2>");
                w.Write($"<p class=\"muted\">{E(string.Format(ctx.Word("updated"), ctx.NameOfId(ctx.AuthorOf(page.UpdatedBy)), ctx.FormatTime(page.UpdatedAt)))}</p>");
                w.Write($"<div class=\"text\">{ExportMarkdown.ToHtml(page.Text ?? "", ctx)}</div></section>\n");
                Step();
            }
        }
        else
        {
            var any = false;
            foreach (var m in Messages(c.Id, from, to))
            {
                any = true;
                var thread = threadsByRoot.GetValueOrDefault(m.Id);
                if (thread is not null) shown.Add(thread.Id);
                WriteHtmlMessage(w, ctx, View(ctx, m), thread is null ? null : () => WriteHtmlThread(w, ctx, thread, from, to));
                Step();
            }
            if (!any) w.Write($"<p class=\"empty\">{E(ctx.Word("empty"))}</p>");
            // Threads whose first message is outside the range (or gone).
            var rest = plan.Threads.Where(t => !shown.Contains(t.Id)).ToList();
            if (rest.Count > 0) w.Write($"<h2>{E(ctx.Word("threads"))}</h2>");
            foreach (var thread in rest) WriteHtmlThread(w, ctx, thread, from, to);
        }
        w.Write($"</main>\n<footer>{E(string.Format(ctx.Word("footer"), _r.Zone.Id))}</footer>\n</body>\n</html>\n");
    }

    private void WriteHtmlThread(StreamWriter w, Context ctx, ThreadInfo thread, long from, long to)
    {
        w.Write($"<section class=\"thread\" id=\"t{thread.Id}\"><h3>🧵 {ExportMarkdown.Escape(ctx.P(thread.Name))}</h3>");
        foreach (var m in Messages(thread.Id, from, to)) { WriteHtmlMessage(w, ctx, View(ctx, m), null); Step(); }
        w.Write("</section>");
    }

    private static string FormatSize(long bytes) =>
        bytes >= 1024 * 1024 ? $"{bytes / 1024.0 / 1024.0:0.0} MB" : bytes >= 1024 ? $"{bytes / 1024.0:0} KB" : $"{bytes} B";

    private static bool Inline(XFile f, string prefix) => f.Type.StartsWith(prefix, StringComparison.Ordinal) && f.File is not null;

    private void WriteHtmlMessage(StreamWriter w, Context ctx, XMessage x, Action? thread)
    {
        static string E(string s) => ExportMarkdown.Escape(s);
        var m = x.M;
        var name = ctx.NameOfId(x.Author);
        var color = int.Parse(x.Author[1..], System.Globalization.CultureInfo.InvariantCulture) % 8;
        w.Write($"<article class=\"msg\" id=\"m{m.Id}\"><div class=\"avatar c{color}\" aria-hidden=\"true\">{E(ExportPage.Initial(name))}</div><div class=\"body\">");
        if (x.Reply is { } r)
        {
            w.Write(r.Deleted
                ? $"<div class=\"reply\">↪ {E(ctx.Word("deletedReply"))}</div>"
                : $"<div class=\"reply\">↪ <a href=\"#m{r.Id}\"><b>{E(ctx.NameOfId(r.Author!))}</b></a> {E(r.Excerpt ?? "")}</div>");
        }
        w.Write($"<div class=\"head\"><span class=\"author\">{E(name)}</span>");
        if (ctx.TypeOfId(x.Author) is "bot" or "webhook") w.Write("<span class=\"tag\">BOT</span>");
        w.Write($"<time datetime=\"{DateTimeOffset.FromUnixTimeMilliseconds(m.CreatedAt).ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture)}\">{E(ctx.FormatTime(m.CreatedAt))}</time>");
        if (m.EditedAt is not null) w.Write($"<span class=\"edited\">({E(ctx.Word("edited"))})</span>");
        if (x.Pinned) w.Write($"<span class=\"pin\">📌 {E(ctx.Word("pinned"))}</span>");
        if (x.Forwarded) w.Write($"<span class=\"tag\">{E(ctx.Word("forwarded"))}</span>");
        w.Write("</div>");
        if (m.Text.Length > 0) w.Write($"<div class=\"text\">{ExportMarkdown.ToHtml(m.Text, ctx)}</div>");
        if (x.Sticker is { } sticker) w.Write($"<div class=\"muted\">{E(ctx.Word("sticker"))}: {E(sticker)}</div>");
        if (x.Gif is { } gif) w.Write($"<div>{ExportMarkdown.Link(gif.Url, E($"{ctx.Word("gif")}: {gif.Title ?? gif.Url}"))}</div>");
        if (x.VoiceMs is { } ms) w.Write($"<div class=\"muted\">🎤 {E(string.Format(ctx.Word("voiceMessage"), TimeSpan.FromMilliseconds(ms).ToString(@"m\:ss", System.Globalization.CultureInfo.InvariantCulture)))}</div>");
        if (x.Files.Count > 0)
        {
            w.Write("<div class=\"files\">");
            foreach (var f in x.Files)
            {
                var label = E($"{f.Name} ({FormatSize(f.Size)})");
                if (f.File is null) w.Write($"<span class=\"file\">📎 {label}</span>");
                else if (Inline(f, "image/") && f.Type != "image/svg+xml")
                    w.Write($"<a href=\"{E(f.File)}\"><img src=\"{E(f.File)}\" alt=\"{E(f.Name)}\" loading=\"lazy\"></a>");
                else if (Inline(f, "video/")) w.Write($"<video controls preload=\"metadata\" src=\"{E(f.File)}\"></video>");
                else if (Inline(f, "audio/")) w.Write($"<audio controls preload=\"none\" src=\"{E(f.File)}\"></audio>");
                else w.Write($"<a class=\"file\" href=\"{E(f.File)}\" download>📎 {label}</a>");
            }
            w.Write("</div>");
        }
        if (x.Poll is { } poll)
        {
            w.Write($"<div class=\"card\"><b>📊 {E(ctx.Word("poll"))}: {E(poll.Question)}</b>");
            if (poll.Closed) w.Write($" <span class=\"muted\">({E(ctx.Word("pollClosed"))})</span>");
            w.Write("<ul>");
            foreach (var (text, votes) in poll.Options)
                w.Write($"<li>{E(text)}: {E(votes == 1 ? ctx.Word("vote") : string.Format(ctx.Word("votes"), votes))}</li>");
            w.Write("</ul></div>");
        }
        foreach (var e in x.Embeds)
        {
            w.Write("<div class=\"card\">");
            if (e.Title is { } title) w.Write($"<div><b>{(e.Url is { } url ? ExportMarkdown.Link(url, E(title)) : E(title))}</b></div>");
            if (e.Description is { } description) w.Write($"<div class=\"text\">{ExportMarkdown.ToHtml(description, ctx)}</div>");
            foreach (var (fieldName, value) in e.Fields) w.Write($"<div><b>{E(fieldName)}</b><div class=\"text\">{ExportMarkdown.ToHtml(value, ctx)}</div></div>");
            if (e.Footer is { } footer) w.Write($"<div class=\"muted\">{E(footer)}</div>");
            w.Write("</div>");
        }
        if (x.Reactions.Count > 0)
        {
            w.Write("<ul class=\"reactions\">");
            foreach (var (emoji, count) in x.Reactions) w.Write($"<li>{E(EmojiText(emoji))} {count}</li>");
            w.Write("</ul>");
        }
        thread?.Invoke();
        w.Write("</div></article>\n");
    }

    /// <summary>A server emoji (<c>&lt;:name:id&gt;</c>) as <c>:name:</c>; anything else as is.</summary>
    private static string EmojiText(string emoji) =>
        emoji.StartsWith('<') && emoji.EndsWith('>') && emoji.Split(':') is { Length: 3 } parts ? $":{parts[1]}:" : emoji;

    private const string Readme = """
        Channel export from an Iskra server
        ===================================

        Each folder is one channel:

        - channel.html: open it in any browser to read the channel. It works offline and loads nothing from the internet.
        - channel.json: the same content for programs (format "iskra-channel-export", version 1; described in Iskra's
          protocol reference, "Channel export").
        - attachments/: the files and images posted in the channel (if attachments were included).

        Authors are listed by the name they had when the export was made. Deleted and disappearing messages aren't
        included, and neither are end-to-end encrypted channels or direct messages.
        Times in channel.json are milliseconds since 1970-01-01 UTC.
        """;
}

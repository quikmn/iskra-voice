using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Import;

/// <summary>
/// Imports while the server runs: the owner gets a single-use upload ticket, PUTs the export (zip or JSON, checked by
/// its first bytes) to /import/{ticket}, and the import starts right away on a worker thread. One at a time; the owner's
/// sessions get import.progress events, and import.status tells a reconnecting client where it stands.
/// </summary>
public sealed class ImportService(World world, Hub hub, Uploads uploads, TimeProvider time, ILogger<ImportService> log)
{
    private sealed record Ticket(string Owner, long MaxBytes, bool ReadOnly, DateTimeOffset Expires);

    private readonly Lock _gate = new();
    private (string Token, Ticket Ticket)? _ticket;
    private CancellationTokenSource? _running;
    private ImportProgress? _last;
    private List<ImportedChannel> _lastChannels = [];
    private long _lastSent;

    public long MaxBytes => (long)world.Settings.Import.MaxMb * 1024 * 1024;

    public string Folder => Path.Combine(world.Path, "imports");

    public bool Busy
    {
        get { lock (_gate) return _running is not null; }
    }

    /// <summary>A ticket for one upload of up to <paramref name="size"/> bytes, or null while another import is going.</summary>
    public string? Begin(string owner, long size, bool readOnly)
    {
        lock (_gate)
        {
            if (_running is not null) return null;
            var token = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(24));
            _ticket = (token, new Ticket(owner, size, readOnly, time.GetUtcNow().AddMinutes(30)));
            return token;
        }
    }

    public object? Status() => _last is null ? null : View(_last, _lastChannels);

    public static object View(ImportProgress p, IEnumerable<ImportedChannel> channels) => new
    {
        phase = p.Phase,
        channels = p.Channels,
        channelsDone = p.ChannelsDone,
        messages = p.Messages,
        messagesDone = p.MessagesDone,
        files = p.Files,
        missingFiles = p.MissingFiles,
        skipped = p.Skipped,
        current = p.Current,
        error = p.Error,
        warnings = p.Warnings,
        imported = channels.Select(c => new { id = c.Id, name = c.Name, category = c.Category, messages = c.Messages, thread = c.Thread }),
    };

    public bool Cancel()
    {
        lock (_gate)
        {
            if (_running is null) return false;
            _running.Cancel();
            return true;
        }
    }

    /// <summary>PUT /import/{token}.</summary>
    public async Task HandleUploadAsync(HttpContext context, string token)
    {
        Uploads.AllowCors(context);
        Ticket ticket;
        lock (_gate)
        {
            if (_ticket is not { } current || !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(current.Token), System.Text.Encoding.UTF8.GetBytes(token))
                || current.Ticket.Expires < time.GetUtcNow() || _running is not null)
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return;
            }
            ticket = current.Ticket;
            _ticket = null; // single use
            _running = new CancellationTokenSource();
        }
        var started = false;
        var path = Path.Combine(Folder, $"upload-{Guid.NewGuid():N}");
        try
        {
            if (context.Request.ContentLength is { } declared && declared > ticket.MaxBytes)
            {
                context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                return;
            }
            AtomicFile.CreatePrivateDirectory(Folder);
            long size = 0;
            var head = new byte[64];
            var headLength = 0;
            await using (var output = Backups.BackupArchive.PrivateCreate(path))
            {
                var buffer = new byte[81920];
                int read;
                while ((read = await context.Request.Body.ReadAsync(buffer, context.RequestAborted)) > 0)
                {
                    size += read;
                    if (size > ticket.MaxBytes)
                    {
                        context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                        return;
                    }
                    if (headLength < head.Length)
                    {
                        var take = Math.Min(read, head.Length - headLength);
                        buffer.AsSpan(0, take).CopyTo(head.AsSpan(headLength));
                        headLength += take;
                        // Checked by content as soon as we can: nothing that isn't a zip or JSON is kept.
                        if (headLength == head.Length && ExportSource.Sniff(head) is null)
                        {
                            context.Response.StatusCode = StatusCodes.Status415UnsupportedMediaType;
                            return;
                        }
                    }
                    await output.WriteAsync(buffer.AsMemory(0, read), context.RequestAborted);
                }
            }
            if (size == 0 || ExportSource.Sniff(head.AsSpan(0, headLength)) is null)
            {
                context.Response.StatusCode = StatusCodes.Status415UnsupportedMediaType;
                return;
            }
            started = true;
            Start(path, ticket);
            context.Response.StatusCode = StatusCodes.Status202Accepted;
            await context.Response.WriteAsJsonAsync(new { started = true });
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException)
        {
            log.Info("http", "aborted", ("what", "import-upload"), ("name", ex.GetType().Name));
            if (!context.Response.HasStarted) context.Response.StatusCode = StatusCodes.Status400BadRequest;
        }
        finally
        {
            if (!started)
            {
                File.Delete(path);
                lock (_gate) _running = null;
            }
        }
    }

    private void Start(string path, Ticket ticket)
    {
        var cancel = _running!.Token;
        _last = new ImportProgress();
        _lastChannels = [];
        _ = Task.Run(() =>
        {
            DiscordImporter? importer = null;
            ImportProgress? final = null;
            try
            {
                using var source = ExportSource.Open(path);
                importer = new DiscordImporter(world, uploads, new ImportOptions
                {
                    ReadOnly = ticket.ReadOnly,
                    ImportedBy = ticket.Owner,
                    MaxFileBytes = (long)world.Settings.MaxUploadMb * 1024 * 1024,
                    MaxTotalBytes = Math.Max(MaxBytes * 4, 1024L * 1024 * 1024),
                }, p =>
                {
                    // The end (done, failed, cancelled) is reported once, below.
                    if (p.Phase is "reading" or "importing") Report(p, force: false);
                });
                importer.Run(source, cancel);
                _lastChannels = [.. importer.Channels];
                final = importer.Progress;
                RefreshChannels();
                log.Info("store", "done", ("what", "import"), ("msgs", importer.Progress.MessagesDone), ("count", importer.Channels.Count));
            }
            catch (Exception ex)
            {
                if (ex is not (InvalidDataException or OperationCanceledException or IOException)) log.Error(ex, "STO-120", "store", "failed", ("what", "import"));
                final = importer?.Progress ?? new ImportProgress
                {
                    Phase = ex is OperationCanceledException ? "cancelled" : "failed",
                    Error = ex is InvalidDataException or IOException ? ex.Message : ex is OperationCanceledException ? null : "Something went wrong while importing.",
                };
            }
            finally
            {
                try { File.Delete(path); } catch (IOException) { }
                lock (_gate)
                {
                    _running?.Dispose();
                    _running = null;
                }
                // Reported only once the slot is free, so "done"/"failed" means a new import can start right away.
                if (final is not null) Report(final, force: true);
            }
        }, CancellationToken.None);
    }

    /// <summary>Sends progress to the owner's sessions (at most 4 times a second, plus every phase change).</summary>
    private void Report(ImportProgress progress, bool force)
    {
        var phaseChanged = _last?.Phase != progress.Phase;
        _last = progress;
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        if (!force && !phaseChanged && now - _lastSent < 250) return;
        _lastSent = now;
        var frame = Frames.Event("import.progress", new { job = View(progress, _lastChannels) });
        foreach (var session in hub.Sessions)
            if (session.CurrentMember() is { Role: Roles.Owner }) session.Send(frame);
    }

    private void RefreshChannels()
    {
        foreach (var session in hub.Sessions)
        {
            var member = session.CurrentMember();
            if (member is not null) session.Send(Frames.Event("channels", new { channels = hub.VisibleChannels(member) }));
        }
    }

    /// <summary>Leftover uploads from a server that stopped mid-import.</summary>
    public void CleanUp()
    {
        if (!Directory.Exists(Folder)) return;
        foreach (var stale in Directory.EnumerateFiles(Folder, "upload-*"))
        {
            try { File.Delete(stale); } catch (IOException) { }
        }
    }
}

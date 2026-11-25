using System.Collections.Concurrent;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Photos channels: a channel of kind "photos" holding pictures and videos, in albums or in none. Reading follows the
/// channel's read access; adding photos and making albums its write access. A photo is changed by whoever added it and
/// deleted by them or a moderator. Each photo has reactions and, once someone comments, a thread.
///
/// Uploads are cleaned of location and identifying metadata (Files/PhotoMetadata.cs, Files/HeifMetadata.cs, Files/Mp4Metadata.cs): by the app
/// before it uploads, and again here for channels the server can read. In an end-to-end encrypted photos channel the
/// server stores ciphertext files and one sealed envelope per photo and album; it can't clean, name or zip anything.
/// Admins set a storage cap per channel; adding beyond it is refused.
/// </summary>
public static class PhotoFeature
{
    public const string Kind = "photos";
    public const int MaxPhotosPerChannel = 50_000;
    public const int MaxAlbumsPerChannel = 500;
    public const int MaxPerAdd = 20;
    public const int MaxPerBulk = 200;
    public const int MaxPage = 500;
    public const int MaxCaptionLength = 500;
    public const int MaxAlbumNameLength = 80;
    public const int MaxEnvelopeChars = 8 * 1024;
    public const long MaxThumbBytes = 512 * 1024;
    public const int MaxCapMb = 4 * 1024 * 1024; // 4 TB
    public const int MaxReactionsPerPhoto = ChatFeature.MaxReactionsPerMessage;
    /// <summary>One notification per person and channel in this time, however many batches they add.</summary>
    public static readonly TimeSpan NotifyEvery = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan ZipLinkLifetime = TimeSpan.FromMinutes(10);
    private const string ZipContext = "iskra/photo-zip/v1";
    private static readonly byte[] ZipKey = RandomNumberGenerator.GetBytes(32);

    public static void Register(Router router)
    {
        router.Add("photo.info", Info);
        router.Add("photo.list", List);
        router.Add("photo.latest", Latest);
        router.Add("photo.upload.begin", BeginUpload);
        router.Add("photo.add", Add);
        router.Add("photo.update", Update);
        router.Add("photo.move", Move);
        router.Add("photo.delete", Delete);
        router.Add("photo.react", React);
        router.Add("photo.comments", Comments);
        router.Add("photo.links", Links);
        router.Add("photo.album.create", CreateAlbum);
        router.Add("photo.album.update", UpdateAlbum);
        router.Add("photo.album.delete", DeleteAlbum);
        router.Add("photo.album.zip", Zip);
        router.Add("photo.cap.set", SetCap);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    private static object UsageView(PhotoUsage u) => new { bytes = u.Bytes, count = u.Count, capBytes = u.CapBytes, maxPhotos = MaxPhotosPerChannel };

    private static object AlbumView(PhotoAlbum a) => new
    {
        id = a.Id,
        channelId = a.ChannelId,
        name = a.Name,
        coverId = a.CoverId,
        createdBy = a.CreatedBy,
        createdAt = a.CreatedAt,
        count = a.Count,
        e2ee = a.Envelope is null ? null : new { version = a.Version, envelope = JsonDocument.Parse(a.Envelope).RootElement.Clone() },
    };

    private static List<object> Views(Store store, IReadOnlyList<Photo> photos)
    {
        var ids = photos.Select(p => p.Id).ToList();
        var files = store.GetFiles(photos.Where(p => p.Envelope is null).SelectMany(p => new[] { p.FileId, p.ThumbId, p.DisplayId }).OfType<string>().ToList());
        var reactions = store.PhotoReactions(ids);
        var comments = store.PhotoCommentCounts(ids);
        return photos.Select(object (p) => new
        {
            id = p.Id,
            channelId = p.ChannelId,
            albumId = p.AlbumId,
            uploader = p.Uploader,
            createdAt = p.CreatedAt,
            size = p.Size,
            kind = p.Envelope is null ? p.Kind : null,
            file = p.Envelope is null && files.TryGetValue(p.FileId, out var file) ? Uploads.Public(file) : null,
            thumb = p.Envelope is null && p.ThumbId is not null && files.TryGetValue(p.ThumbId, out var thumb) ? Uploads.Public(thumb) : null,
            display = p.Envelope is null && p.DisplayId is not null && files.TryGetValue(p.DisplayId, out var display) ? Uploads.Public(display) : null,
            width = p.Width,
            height = p.Height,
            duration = p.Duration,
            takenAt = p.TakenAt,
            caption = p.Caption,
            e2ee = p.Envelope is null ? null : new { version = p.Version, envelope = JsonDocument.Parse(p.Envelope).RootElement.Clone() },
            reactions = reactions.TryGetValue(p.Id, out var r) ? r.Select(x => new { emoji = x.Emoji, accounts = x.Accounts }) : [],
            threadId = p.ThreadId,
            comments = comments.GetValueOrDefault(p.Id),
        }).ToList();
    }

    private static object View(Store store, Photo photo) => Views(store, [photo])[0];

    // ── Lookups and checks ───────────────────────────────────────────────────

    private static Channel ReadableChannel(Session s, Member me, long id)
    {
        var channel = ChatFeature.ReadableChannel(s, me, id);
        return channel.Kind == Kind ? channel : throw RequestException.BadRequest("That isn't a photos channel.");
    }

    private static (Photo Photo, Channel Channel) ReadablePhoto(Session s, Member me, long id)
    {
        var photo = s.World.Store.GetPhoto(id) ?? throw RequestException.NotFound("Photo");
        if (s.World.Store.GetChannel(photo.ChannelId) is not { Kind: Kind } channel || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Photo");
        return (photo, channel);
    }

    private static (PhotoAlbum Album, Channel Channel) ReadableAlbum(Session s, Member me, long id)
    {
        var album = s.World.Store.GetPhotoAlbum(id) ?? throw RequestException.NotFound("Album");
        if (s.World.Store.GetChannel(album.ChannelId) is not { Kind: Kind } channel || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Album");
        return (album, channel);
    }

    private static void RequireWriter(Member me, Channel channel)
    {
        if (!Permissions.CanWrite(me, channel)) throw RequestException.Forbidden("You can't add photos to this channel.", "photos_write");
    }

    /// <summary>Someone who may delete or move other people's photos here (and albums): they manage messages and outrank the owner.</summary>
    private static bool Moderates(Store store, Member me, string ownerKey) =>
        Permissions.Has(me, Perm.ManageMessages) && (store.GetMember(ownerKey) is not { } owner || Permissions.Outranks(me, owner));

    private static bool CanDelete(Store store, Member me, Photo photo) => photo.Uploader == me.AccountKey || Moderates(store, me, photo.Uploader);

    private static string Caption(string raw)
    {
        if (raw.Trim().Length == 0) return "";
        return Text.Normalize(raw, MaxCaptionLength, allowNewlines: true)
            ?? throw RequestException.BadRequest($"Captions can be up to {MaxCaptionLength} characters.", "photo_caption_length", new { max = MaxCaptionLength });
    }

    private static string AlbumName(string raw) =>
        Text.Normalize(raw, MaxAlbumNameLength, allowNewlines: false)
        ?? throw RequestException.BadRequest($"Album names must be 1–{MaxAlbumNameLength} characters.", "photo_album_name", new { max = MaxAlbumNameLength });

    /// <summary>A date taken: between 1970 and tomorrow, in Unix milliseconds.</summary>
    private static long? TakenAt(Session s, Body body, string field = "takenAt") =>
        body.OptionalLong(field, 0, s.Now + 86_400_000L);

    /// <summary>The album photos go to: one of this channel's, or none.</summary>
    private static long? AlbumIn(Session s, Channel channel, Body body)
    {
        if (body.OptionalLong("albumId", min: 1) is not { } id) return null;
        return s.World.Store.GetPhotoAlbum(id) is { } album && album.ChannelId == channel.Id ? id : throw RequestException.BadRequest("That album isn't in this channel.", "photo_album_gone");
    }

    private static RequestException Full(PhotoUsage usage, int adding = 1) => usage.CapBytes is { } cap && usage.Count + adding <= MaxPhotosPerChannel
        ? RequestException.BadRequest($"This channel's photo storage is full ({cap / 1024 / 1024} MB). Delete some photos or ask an admin to raise the limit.",
            "photos_full", new { mb = cap / 1024 / 1024 })
        : RequestException.BadRequest($"A photos channel can hold up to {MaxPhotosPerChannel} photos.", "photos_max", new { max = MaxPhotosPerChannel });

    /// <summary>
    /// Checks an envelope's routing in an encrypted photos channel (the server reads nothing else): sealed by you, in the
    /// chain, under the current version, for this channel and purpose. Returns the envelope as sent.
    /// </summary>
    private static string Sealed(Member me, Channel channel, E2eeChannel e, long version, JsonElement envelope, string what)
    {
        if (!e.Members.Contains(me.AccountKey)) throw RequestException.Forbidden("You don't have this channel's key yet.");
        if (version != e.Version) throw new RequestException("conflict", "Who's in this channel changed in the meantime. Refresh and try again.", "e2ee_members_changed");
        if (envelope.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'envelope' must be an object.");
        var raw = envelope.GetRawText();
        if (raw.Length > MaxEnvelopeChars) throw RequestException.BadRequest("That is too big. Shorten the caption or name.", "photo_envelope_size");
        var env = new Body(envelope);
        var header = env.OptionalElement("header") is { ValueKind: JsonValueKind.Object } h ? new Body(h) : throw RequestException.BadRequest("Envelope without a header.");
        if (env.OptionalString("kind", 8) != "photo" || header.OptionalString("from", 64) != me.AccountKey || header.OptionalString("chain", 32) != e.ChainId
            || header.OptionalLong("version") != version || header.OptionalLong("channel") != channel.Id || header.OptionalString("what", 16) != what)
            throw RequestException.BadRequest("The envelope doesn't match this channel.");
        return raw;
    }

    private static long Version(Body body) => body.OptionalLong("version", 1) ?? throw RequestException.BadRequest("'version' is required.");

    private static void NotABot(Session s, Member me)
    {
        if (s.World.Store.IsBot(me.AccountKey))
            throw RequestException.Forbidden("Bots can't take part in end-to-end encrypted channels: they don't hold the channel's keys.");
    }

    // ── Hooks ────────────────────────────────────────────────────────────────

    /// <summary>A photo's comment thread goes with the photo, not on its own.</summary>
    public static void CheckThreadChange(Session s, ThreadInfo thread)
    {
        if (s.World.Store.GetChannel(thread.ParentId) is { Kind: Kind })
            throw RequestException.BadRequest("A photo's comments belong to the photo. Delete the photo or the comments instead.", "photo_thread");
    }

    // ── Reading ──────────────────────────────────────────────────────────────

    private static object Info(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        var store = s.World.Store;
        return new { albums = store.PhotoAlbums(channel.Id).Select(AlbumView), usage = UsageView(store.PhotoUsage(channel.Id)) };
    }

    private static object List(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        var limit = (int)(body.OptionalLong("limit", 1, MaxPage) ?? MaxPage);
        var photos = s.World.Store.Photos(channel.Id, body.OptionalLong("after", min: 0) ?? 0, limit + 1);
        var hasMore = photos.Count > limit;
        if (hasMore) photos.RemoveAt(limit);
        return new { photos = Views(s.World.Store, photos), hasMore };
    }

    /// <summary>
    /// The newest photo of every photos channel you can read (its id, who added it and when), so an app can tell what was
    /// added while it was away without loading the channels.
    /// </summary>
    private static object Latest(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var latest = store.LatestPhotos();
        return new
        {
            channels = store.AllChannels().Where(c => c.Kind == Kind && latest.ContainsKey(c.Id) && Permissions.CanRead(me, c))
                .Select(c => new { channelId = c.Id, id = latest[c.Id].Id, by = latest[c.Id].Uploader, at = latest[c.Id].CreatedAt }),
        };
    }

    /// <summary>
    /// Short-lived download links for the ciphertext of photos in an encrypted channel (<c>what</c>: "thumb", "display" or "file"),
    /// for the photos whose files you may read: the ones added while you were in the channel's encryption.
    /// </summary>
    private static object Links(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        var store = s.World.Store;
        if (store.GetE2ee(channel.Id) is null) throw RequestException.BadRequest("That channel isn't end-to-end encrypted.");
        var what = body.OptionalString("what", 8) ?? "thumb";
        if (what is not ("thumb" or "display" or "file")) throw RequestException.BadRequest("'what' must be thumb, display or file.");
        var ids = LongArray(body, "ids", MaxPerBulk);
        var links = new Dictionary<string, string>();
        foreach (var photo in store.GetPhotos(ids))
        {
            if (photo.ChannelId != channel.Id) continue;
            var fileId = what == "thumb" ? photo.ThumbId : what == "display" ? photo.DisplayId : photo.FileId;
            if (fileId is null || !store.CanReadDmFile(fileId, me.AccountKey)) continue;
            links[photo.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)] = DmFileFeature.LinkFor(fileId, s.Now);
        }
        return new { links };
    }

    private static List<long> LongArray(Body body, string name, int max)
    {
        var element = body.Element(name);
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() is 0 || element.GetArrayLength() > max)
            throw RequestException.BadRequest($"'{name}' must list 1–{max} ids.");
        var ids = new List<long>();
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Number || !item.TryGetInt64(out var id) || id < 1) throw RequestException.BadRequest($"'{name}' must list ids.");
            if (!ids.Contains(id)) ids.Add(id);
        }
        return ids;
    }

    // ── Uploading ────────────────────────────────────────────────────────────

    /// <summary>
    /// Tickets for one photo, its thumbnail and (for a HEIC or AVIF) the picture made for display, after checking that you may add here and that it would fit under the cap.
    /// In an encrypted channel the tickets are for ciphertext only the channel's members can fetch.
    /// </summary>
    private static object BeginUpload(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        RequireWriter(me, channel);
        var store = s.World.Store;
        var size = body.OptionalLong("size", min: 1) ?? throw RequestException.BadRequest("'size' is required.");
        var thumbSize = body.OptionalLong("thumbSize", min: 1);
        var displaySize = body.OptionalLong("displaySize", min: 1);
        if (size > s.Uploads.MaxBytes)
            throw RequestException.BadRequest($"Files can be up to {s.Uploads.MaxBytes / 1024 / 1024} MB on this server.", "file_size", new { mb = s.Uploads.MaxBytes / 1024 / 1024 });
        if (thumbSize > MaxThumbBytes) throw RequestException.BadRequest("The thumbnail is too large.", "photo_thumb_size");
        if (displaySize > s.Uploads.MaxBytes)
            throw RequestException.BadRequest($"Files can be up to {s.Uploads.MaxBytes / 1024 / 1024} MB on this server.", "file_size", new { mb = s.Uploads.MaxBytes / 1024 / 1024 });
        var usage = store.PhotoUsage(channel.Id);
        if (usage.Count >= MaxPhotosPerChannel || (usage.CapBytes is { } cap && usage.Bytes + size + (thumbSize ?? 0) + (displaySize ?? 0) > cap)) throw Full(usage);

        string[]? readers = null;
        if (store.GetE2ee(channel.Id) is not null)
        {
            NotABot(s, me);
            readers = E2eeChannelFeature.UploadReaders(s, me, channel.Id);
        }
        if (!s.Hub.Limits.TryTake(me.AccountKey, "photo.upload")) throw new RequestException("rate_limited", "Slow down a little.");
        RequestException Quota() => new("rate_limited",
            $"You've reached today's upload limit on this server ({s.Uploads.DailyQuota(me.Role)!.Value / 1024 / 1024} MB a day). Try again later.",
            "upload_quota", new { mb = s.Uploads.DailyQuota(me.Role)!.Value / 1024 / 1024 });
        var name = readers is null ? body.OptionalString("name", 512) ?? "photo" : "photo";
        var token = s.Uploads.Issue(me.AccountKey, me.Role, name, size, readers) ?? throw Quota();
        string? thumbToken = null;
        if (thumbSize is { } t) thumbToken = s.Uploads.Issue(me.AccountKey, me.Role, "thumbnail.jpg", t, readers) ?? throw Quota();
        string? displayToken = null;
        if (displaySize is { } d) displayToken = s.Uploads.Issue(me.AccountKey, me.Role, "display.jpg", d, readers) ?? throw Quota();
        return new
        {
            url = $"/upload/{token}",
            thumbUrl = thumbToken is null ? null : $"/upload/{thumbToken}",
            displayUrl = displayToken is null ? null : $"/upload/{displayToken}",
            maxBytes = s.Uploads.MaxBytes,
            partBytes = Uploads.PartBytes,
        };
    }

    /// <summary>Your own upload that nothing uses yet.</summary>
    private static StoredFile OwnUpload(Session s, Member me, string id, bool encrypted)
    {
        var store = s.World.Store;
        var file = store.GetFile(id);
        if (file is null || file.Uploader != me.AccountKey || (store.GetDmFile(id) is not null) != encrypted || store.PhotoUsesFile(id))
            throw RequestException.BadRequest("Unknown upload.", "photo_upload_unknown");
        if (encrypted && store.GetDmFile(id)!.MessageId is not null) throw RequestException.BadRequest("Unknown upload.", "photo_upload_unknown");
        return file;
    }

    private static object Add(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        RequireWriter(me, channel);
        var store = s.World.Store;
        var e2ee = store.GetE2ee(channel.Id);
        var albumId = AlbumIn(s, channel, body);
        var batch = body.OptionalString("batch", 32);
        var total = (int)(body.OptionalLong("total", 1, MaxPhotosPerChannel) ?? 0);
        var keepDate = body.OptionalBool("keepDate") ?? true;
        var raw = body.Element("items");
        if (raw.ValueKind != JsonValueKind.Array || raw.GetArrayLength() is 0 || raw.GetArrayLength() > MaxPerAdd)
            throw RequestException.BadRequest($"'items' must have 1–{MaxPerAdd} photos.");
        long version = 0;
        if (e2ee is not null)
        {
            NotABot(s, me);
            version = Version(body);
        }

        var items = new List<NewPhoto>();
        var replaced = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            foreach (var element in raw.EnumerateArray())
            {
                if (element.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("Each item must be an object.");
                var item = new Body(element);
                var fileId = item.String("file", 64);
                var thumbId = item.OptionalString("thumb", 64);
                var displayId = item.OptionalString("display", 64);
                if (!seen.Add(fileId) || (thumbId is not null && !seen.Add(thumbId)) || (displayId is not null && !seen.Add(displayId)))
                    throw RequestException.BadRequest("Unknown upload.", "photo_upload_unknown");
                var file = OwnUpload(s, me, fileId, e2ee is not null);
                var thumb = thumbId is null ? null : OwnUpload(s, me, thumbId, e2ee is not null);
                var display = displayId is null ? null : OwnUpload(s, me, displayId, e2ee is not null);
                if (thumb is not null && thumb.Size > MaxThumbBytes + 1024) throw RequestException.BadRequest("The thumbnail is too large.", "photo_thumb_size");

                if (e2ee is not null)
                {
                    var envelope = Sealed(me, channel, e2ee, version, item.Element("envelope"), "photo");
                    items.Add(new NewPhoto(file.Id, thumb?.Id, null, "", 0, 0, null, file.Size + (thumb?.Size ?? 0) + (display?.Size ?? 0), "", envelope, version, display?.Id));
                    continue;
                }
                if (item.Has("envelope")) throw RequestException.BadRequest("That channel isn't end-to-end encrypted.");
                var kind = s.Uploads.PhotoKind(file)
                    ?? throw RequestException.BadRequest("Photos channels take JPEG, PNG, WebP, GIF, HEIC and AVIF pictures and MP4 or MOV videos.", "photo_type");
                if (thumb is not null && !PhotoMetadata.IsStill(thumb.Type)) throw RequestException.BadRequest("The thumbnail must be a picture.", "photo_thumb_type");
                // Not every app can draw a HEIC or AVIF: the uploader's app sends a picture that every app can, next to the original.
                var heif = HeifMetadata.IsHeif(file.Type);
                if (heif && display is null)
                    throw RequestException.BadRequest("A HEIC or AVIF picture needs a copy that every app can show. Update Iskra and add it again.", "photo_display_needed");
                if (display is not null && (!heif || !PhotoMetadata.IsStill(display.Type)))
                    throw RequestException.BadRequest("The picture made for display must be a JPEG, PNG or WebP next to a HEIC or AVIF original.", "photo_display_type");
                var caption = item.OptionalString("caption", MaxCaptionLength * 2) is { } text ? Caption(text) : "";
                if (caption.Length > 0) AutoModFeature.Check(s, me, channel, caption, "photo");
                // The server trusts no app to have cleaned the files: it does it again (a cleaned file comes back as it is).
                StoredFile cleanFile, cleanThumb, cleanDisplay;
                try
                {
                    cleanFile = s.Uploads.CleanForPhotos(file, keepDate);
                    cleanThumb = thumb is null ? file : s.Uploads.CleanForPhotos(thumb, false);
                    cleanDisplay = display is null ? file : s.Uploads.CleanForPhotos(display, false);
                }
                catch (Exception ex) when (ex is ImageMetadata.Refused or Mp4Metadata.Refused)
                {
                    throw RequestException.BadRequest($"\"{file.Name}\" can't be added: its metadata couldn't be removed.", "photo_unclean", new { name = file.Name, why = ex.Message });
                }
                if (cleanFile.Id != file.Id) replaced.Add(file.Id);
                if (thumb is not null && cleanThumb.Id != thumb.Id) replaced.Add(thumb.Id);
                if (display is not null && cleanDisplay.Id != display.Id) replaced.Add(display.Id);
                var width = (int)(item.OptionalLong("width", 1, 100_000) ?? cleanFile.Width ?? 0);
                var height = (int)(item.OptionalLong("height", 1, 100_000) ?? cleanFile.Height ?? 0);
                var duration = kind == "video" ? item.OptionalLong("duration", 0, 24L * 3600 * 1000) : null;
                items.Add(new NewPhoto(cleanFile.Id, thumb is null ? null : cleanThumb.Id, keepDate ? TakenAt(s, item) : null, kind, width, height, duration,
                    cleanFile.Size + (thumb is null ? 0 : cleanThumb.Size) + (display is null ? 0 : cleanDisplay.Size), caption, null, null,
                    display is null ? null : cleanDisplay.Id));
            }

            var ids = store.AddPhotos(channel.Id, albumId, me.AccountKey, items, s.Now, MaxPhotosPerChannel) ?? throw Full(store.PhotoUsage(channel.Id), items.Count);
            foreach (var id in replaced) s.Uploads.DeleteIfUnused(id);
            var photos = store.GetPhotos(ids);
            var views = Views(store, photos);
            var usage = UsageView(store.PhotoUsage(channel.Id));
            var first = batch is not null && s.Hub.PhotoBatches.First(channel.Id, me.AccountKey, batch, s.Now, (long)NotifyEvery.TotalMilliseconds);
            var count = Math.Max(total, photos.Count);
            s.Hub.BroadcastToReaders(channel, Frames.Event("photo.added", new
            {
                channelId = channel.Id, photos = views, usage, by = me.AccountKey, batch = batch is null ? null : new { id = batch, total = count, first },
            }));
            if (first) s.Push.PhotosAdded(channel, me, count);
            return new { photos = views, usage };
        }
        catch
        {
            // Cleaned copies made for a request that failed are not left behind.
            foreach (var item in items.Where(i => i.Envelope is null))
            {
                if (!store.PhotoUsesFile(item.FileId)) s.Uploads.DeleteIfUnused(item.FileId);
                if (item.ThumbId is not null && !store.PhotoUsesFile(item.ThumbId)) s.Uploads.DeleteIfUnused(item.ThumbId);
                if (item.DisplayId is not null && !store.PhotoUsesFile(item.DisplayId)) s.Uploads.DeleteIfUnused(item.DisplayId);
            }
            throw;
        }
    }

    // ── Changing ─────────────────────────────────────────────────────────────

    /// <summary>The caption and date taken (encrypted: a new envelope), by whoever added the photo.</summary>
    private static object Update(Session s, Member me, Body body)
    {
        var (photo, channel) = ReadablePhoto(s, me, body.Long("id"));
        RequireWriter(me, channel);
        if (photo.Uploader != me.AccountKey) throw RequestException.Forbidden("Only whoever added this photo can change it.", "photo_change_owner");
        var store = s.World.Store;
        if (store.GetE2ee(channel.Id) is { } e2ee)
        {
            var version = Version(body);
            var envelope = Sealed(me, channel, e2ee, version, body.Element("envelope"), "photo");
            store.UpdatePhoto(photo.Id, null, null, false, envelope, version);
        }
        else
        {
            if (body.Has("envelope")) throw RequestException.BadRequest("That channel isn't end-to-end encrypted.");
            var caption = body.OptionalString("caption", MaxCaptionLength * 2) is { } raw ? Caption(raw) : null;
            var takenAt = TakenAt(s, body);
            var clearTaken = body.IsNull("takenAt");
            if (caption is null && takenAt is null && !clearTaken) throw RequestException.BadRequest("Nothing to change.", "nothing_to_change");
            if (caption is { Length: > 0 } && caption != photo.Caption) AutoModFeature.Check(s, me, channel, caption, "photo");
            store.UpdatePhoto(photo.Id, caption, takenAt, clearTaken, null, null);
        }
        var view = View(store, store.GetPhoto(photo.Id)!);
        s.Hub.BroadcastToReaders(channel, Frames.Event("photo.updated", new { photo = view }));
        return new { photo = view };
    }

    /// <summary>The photos among <c>ids</c> that are in one channel you can read, and that channel.</summary>
    private static (List<Photo> Photos, Channel Channel) Bulk(Session s, Member me, Body body)
    {
        var photos = s.World.Store.GetPhotos(LongArray(body, "ids", MaxPerBulk));
        if (photos.Count == 0) throw RequestException.NotFound("Photo");
        if (photos.Any(p => p.ChannelId != photos[0].ChannelId)) throw RequestException.BadRequest("Those photos are in different channels.");
        if (s.World.Store.GetChannel(photos[0].ChannelId) is not { Kind: Kind } channel || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Photo");
        return (photos, channel);
    }

    /// <summary>Puts photos in an album or in none: your own, or anyone's if you moderate.</summary>
    private static object Move(Session s, Member me, Body body)
    {
        var (photos, channel) = Bulk(s, me, body);
        RequireWriter(me, channel);
        var store = s.World.Store;
        var albumId = AlbumIn(s, channel, body);
        if (photos.Any(p => p.Uploader != me.AccountKey && !Moderates(store, me, p.Uploader)))
            throw RequestException.Forbidden("You can only move your own photos.", "photo_move_owner");
        var ids = photos.Where(p => p.AlbumId != albumId).Select(p => p.Id).ToList();
        if (ids.Count > 0)
        {
            store.MovePhotos(ids, albumId);
            s.Hub.BroadcastToReaders(channel, Frames.Event("photo.moved", new { channelId = channel.Id, ids, albumId, albums = store.PhotoAlbums(channel.Id).Select(AlbumView) }));
        }
        return new { ids };
    }

    /// <summary>Deletes photos: your own, or anyone's if you moderate (audited). Their comments and files go with them.</summary>
    private static object Delete(Session s, Member me, Body body)
    {
        var (photos, channel) = Bulk(s, me, body);
        var store = s.World.Store;
        if (photos.Any(p => !CanDelete(store, me, p)))
            throw RequestException.Forbidden("Only whoever added a photo, or a moderator, can delete it.", "photo_delete_owner");
        foreach (var group in photos.Where(p => p.Uploader != me.AccountKey).GroupBy(p => p.Uploader))
            Audit.Record(s, "photo.delete", group.Key, details: new { channelId = channel.Id, channelName = channel.Name, count = group.Count() });

        var ids = photos.Select(p => p.Id).ToList();
        store.DeletePhotos(ids);
        foreach (var photo in photos)
        {
            if (photo.ThreadId is { } threadId)
            {
                store.DeleteChannel(threadId);
                s.Hub.BroadcastToReaders(channel, Frames.Event("thread.deleted", new { id = threadId, channelId = channel.Id, rootId = -threadId }));
            }
            s.Uploads.DeleteIfUnused(photo.FileId);
            if (photo.ThumbId is not null) s.Uploads.DeleteIfUnused(photo.ThumbId);
            if (photo.DisplayId is not null) s.Uploads.DeleteIfUnused(photo.DisplayId);
        }
        if (photos.Any(p => p.Envelope is not null)) store.ForgetDeletedDmFiles();
        var usage = UsageView(store.PhotoUsage(channel.Id));
        s.Hub.BroadcastToReaders(channel, Frames.Event("photo.deleted", new { channelId = channel.Id, ids, usage, albums = store.PhotoAlbums(channel.Id).Select(AlbumView) }));
        return new { ids, usage };
    }

    private static object? React(Session s, Member me, Body body)
    {
        var (photo, channel) = ReadablePhoto(s, me, body.Long("id"));
        if (!Permissions.CanWrite(me, channel)) throw RequestException.Forbidden();
        var store = s.World.Store;
        var emoji = EmojiFeature.Reaction(store, body.String("emoji", 64)) ?? throw RequestException.BadRequest("That isn't a valid reaction.");
        var on = body.OptionalBool("on") ?? true;
        if (on && !store.HasPhotoReaction(photo.Id, emoji) && store.DistinctPhotoReactions(photo.Id) >= MaxReactionsPerPhoto)
            throw RequestException.BadRequest("This photo has too many different reactions.", "photo_reactions_full");
        store.SetPhotoReaction(photo.Id, me.AccountKey, emoji, on, s.Now);
        var reactions = store.PhotoReactions([photo.Id]).GetValueOrDefault(photo.Id, []).Select(x => new { emoji = x.Emoji, accounts = x.Accounts });
        s.Hub.BroadcastToReaders(channel, Frames.Event("photo.reactions", new { channelId = channel.Id, id = photo.Id, reactions }));
        return null;
    }

    /// <summary>The photo's comment thread, made the first time someone who can write asks for it.</summary>
    private static object Comments(Session s, Member me, Body body)
    {
        var (photo, channel) = ReadablePhoto(s, me, body.Long("id"));
        var store = s.World.Store;
        if (photo.ThreadId is { } existing && store.GetThread(existing) is { } known) return new { thread = ThreadFeature.View(known) };
        if (!Permissions.CanWrite(me, channel)) return new { thread = (object?)null };
        if (!s.Hub.Limits.TryTake(me.AccountKey, "photo.thread")) throw new RequestException("rate_limited", "Slow down a little.");
        // Encrypted channels: the server can't keep a name secret, so the thread has none.
        var name = store.GetE2ee(channel.Id) is not null ? ThreadFeature.EncryptedThreadName
            : photo.Caption.Length > 0 ? Text.Normalize(photo.Caption.ReplaceLineEndings(" "), ThreadFeature.MaxNameLength, allowNewlines: false) ?? "Photo"
            : "Photo";
        if (name.Length > ThreadFeature.MaxNameLength) name = name[..ThreadFeature.MaxNameLength];
        var thread = store.CreatePhotoThread(channel, photo.Id, name, me.AccountKey, s.Now);
        s.Hub.BroadcastToReaders(channel, Frames.Event("thread.updated", new { thread = ThreadFeature.View(thread) }));
        s.Hub.BroadcastToReaders(channel, Frames.Event("photo.updated", new { photo = View(store, store.GetPhoto(photo.Id)!) }));
        return new { thread = ThreadFeature.View(thread) };
    }

    // ── Albums ───────────────────────────────────────────────────────────────

    private static void AlbumChanged(Session s, Channel channel, long id) =>
        s.Hub.BroadcastToReaders(channel, Frames.Event("photo.album.updated", new { album = AlbumView(s.World.Store.GetPhotoAlbum(id)!) }));

    private static object CreateAlbum(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        RequireWriter(me, channel);
        var store = s.World.Store;
        if (store.PhotoAlbumCount(channel.Id) >= MaxAlbumsPerChannel)
            throw RequestException.BadRequest($"A photos channel can have up to {MaxAlbumsPerChannel} albums.", "photo_albums_max", new { max = MaxAlbumsPerChannel });
        long id;
        if (store.GetE2ee(channel.Id) is { } e2ee)
        {
            NotABot(s, me);
            var version = Version(body);
            id = store.CreatePhotoAlbum(channel.Id, "", me.AccountKey, s.Now, Sealed(me, channel, e2ee, version, body.Element("envelope"), "album"), version);
        }
        else
        {
            if (body.Has("envelope")) throw RequestException.BadRequest("That channel isn't end-to-end encrypted.");
            var name = AlbumName(body.String("name", MaxAlbumNameLength * 2));
            AutoModFeature.Check(s, me, channel, name, "photo");
            id = store.CreatePhotoAlbum(channel.Id, name, me.AccountKey, s.Now, null, null);
        }
        AlbumChanged(s, channel, id);
        return new { album = AlbumView(store.GetPhotoAlbum(id)!) };
    }

    /// <summary>Renames an album or picks its cover: whoever made it, or a moderator.</summary>
    private static object UpdateAlbum(Session s, Member me, Body body)
    {
        var (album, channel) = ReadableAlbum(s, me, body.Long("id"));
        RequireWriter(me, channel);
        var store = s.World.Store;
        if (album.CreatedBy != me.AccountKey && !Moderates(store, me, album.CreatedBy))
            throw RequestException.Forbidden("Only whoever made this album, or a moderator, can change it.", "photo_album_owner");
        string? name = null, envelope = null;
        long? version = null;
        if (store.GetE2ee(channel.Id) is { } e2ee)
        {
            if (body.Has("envelope"))
            {
                version = Version(body);
                envelope = Sealed(me, channel, e2ee, version.Value, body.Element("envelope"), "album");
            }
        }
        else
        {
            if (body.Has("envelope")) throw RequestException.BadRequest("That channel isn't end-to-end encrypted.");
            if (body.OptionalString("name", MaxAlbumNameLength * 2) is { } raw)
            {
                name = AlbumName(raw);
                if (name != album.Name) AutoModFeature.Check(s, me, channel, name, "photo");
            }
        }
        var coverId = body.OptionalLong("coverId", min: 1);
        var clearCover = body.IsNull("coverId");
        if (coverId is { } cover && (store.GetPhoto(cover) is not { } coverPhoto || coverPhoto.AlbumId != album.Id))
            throw RequestException.BadRequest("The cover must be a photo in this album.", "photo_album_cover");
        if (name is null && envelope is null && coverId is null && !clearCover) throw RequestException.BadRequest("Nothing to change.", "nothing_to_change");
        store.UpdatePhotoAlbum(album.Id, name, envelope, version, coverId, clearCover);
        AlbumChanged(s, channel, album.Id);
        return new { album = AlbumView(store.GetPhotoAlbum(album.Id)!) };
    }

    /// <summary>Deletes an album (whoever made it, or a moderator). Its photos stay in the channel, in no album.</summary>
    private static object? DeleteAlbum(Session s, Member me, Body body)
    {
        var (album, channel) = ReadableAlbum(s, me, body.Long("id"));
        RequireWriter(me, channel);
        var store = s.World.Store;
        if (album.CreatedBy != me.AccountKey && !Moderates(store, me, album.CreatedBy))
            throw RequestException.Forbidden("Only whoever made this album, or a moderator, can delete it.", "photo_album_delete_owner");
        if (album.CreatedBy != me.AccountKey)
            Audit.Record(s, "photo.album.delete", album.CreatedBy.Length > 0 ? album.CreatedBy : null,
                details: new { channelId = channel.Id, channelName = channel.Name, name = album.Name, count = album.Count });
        store.DeletePhotoAlbum(album.Id);
        s.Hub.BroadcastToReaders(channel, Frames.Event("photo.album.deleted", new { channelId = channel.Id, id = album.Id }));
        return null;
    }

    // ── The storage cap ──────────────────────────────────────────────────────

    /// <summary>How much the channel's photos may take, in MB (null: no cap). Photos already there stay.</summary>
    private static object SetCap(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        if (!Permissions.Has(me, Perm.ManageChannels)) throw RequestException.Forbidden("You can't manage channels on this server.", "manage_channels");
        var store = s.World.Store;
        long? mb = body.IsNull("mb") ? null : body.OptionalLong("mb", 1, MaxCapMb) ?? throw RequestException.BadRequest("'mb' must be a number of megabytes, or null for no limit.");
        var before = store.PhotoUsage(channel.Id).CapBytes;
        var bytes = mb * 1024 * 1024;
        if (before != bytes)
        {
            store.SetPhotoCap(channel.Id, bytes);
            Audit.Record(s, "photo.cap", details: new { channelId = channel.Id, channelName = channel.Name, from = before / 1024 / 1024, to = mb });
        }
        var usage = UsageView(store.PhotoUsage(channel.Id));
        s.Hub.BroadcastToReaders(channel, Frames.Event("photo.usage", new { channelId = channel.Id, usage }));
        return new { usage };
    }

    // ── Download an album as a zip ───────────────────────────────────────────

    /// <summary>
    /// A short-lived link to a zip of an album (<c>albumId</c>), of the photos in no album (no <c>albumId</c>) or of the
    /// whole channel (<c>all</c>). Not for encrypted channels: the server can't read their files (the app builds the zip).
    /// </summary>
    private static object Zip(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        var store = s.World.Store;
        if (store.GetE2ee(channel.Id) is not null)
            throw RequestException.BadRequest("The server can't read an encrypted channel's photos. The app builds the zip on your device.", "photo_zip_encrypted");
        var all = body.OptionalBool("all") ?? false;
        var albumId = all ? null : AlbumIn(s, channel, body);
        var photos = store.PhotosForZip(channel.Id, albumId, all);
        if (photos.Count == 0) throw RequestException.BadRequest("There is nothing to download.", "photo_zip_empty");
        if (!s.Hub.Limits.TryTake(me.AccountKey, "photo.zip")) throw new RequestException("rate_limited", "Slow down a little.");
        var expires = s.Now + (long)ZipLinkLifetime.TotalMilliseconds;
        var album = all ? "all" : albumId?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "none";
        return new
        {
            url = $"/photos/zip/{channel.Id}?album={album}&by={me.AccountKey}&exp={expires}&sig={ZipSig(channel.Id, album, me.AccountKey, expires)}",
            count = photos.Count,
            bytes = photos.Sum(p => p.Size),
        };
    }

    private static string ZipSig(long channelId, string album, string account, long expires) =>
        Ed25519.ToB64u(HMACSHA256.HashData(ZipKey, Encoding.UTF8.GetBytes($"{ZipContext}\0{channelId}\0{album}\0{account}\0{expires}")));

    /// <summary>GET /photos/zip/{channelId}?album=&amp;by=&amp;exp=&amp;sig=: the originals, stored (not compressed), streamed.</summary>
    public static async Task ServeZip(HttpContext context, World world, Uploads uploads, long channelId)
    {
        Uploads.AllowCors(context);
        var now = context.RequestServices.GetRequiredService<TimeProvider>().GetUtcNow().ToUnixTimeMilliseconds();
        var album = context.Request.Query["album"].ToString();
        var account = context.Request.Query["by"].ToString();
        if (!long.TryParse(context.Request.Query["exp"], out var expires) || expires < now || album.Length > 20 || account.Length > 64
            || !Ed25519.TryFromB64u(context.Request.Query["sig"].ToString(), out var sig)
            || !CryptographicOperations.FixedTimeEquals(sig, Ed25519.TryFromB64u(ZipSig(channelId, album, account, expires), out var good) ? good : []))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        var store = world.Store;
        // Access is checked again now: the link may be older than a role change.
        if (store.GetChannel(channelId) is not { Kind: Kind } channel || store.GetMember(account) is not { } member || !Permissions.CanRead(member, channel)
            || store.GetE2ee(channelId) is not null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        var all = album == "all";
        long? albumId = !all && long.TryParse(album, out var parsed) ? parsed : null;
        var photos = store.PhotosForZip(channelId, albumId, all);
        var files = store.GetFiles(photos.Select(p => p.FileId).ToList());
        var name = albumId is { } id && store.GetPhotoAlbum(id) is { } named ? named.Name : channel.Name;

        var headers = context.Response.Headers;
        headers.XContentTypeOptions = "nosniff";
        headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        headers.CacheControl = "private, no-store";
        headers.ContentDisposition = new System.Net.Http.Headers.ContentDispositionHeaderValue("attachment") { FileNameStar = FileSniffer.CleanName(name) + ".zip" }.ToString();
        context.Response.ContentType = "application/zip";
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        await using var zip = new ZipArchive(new WriteOnly(context.Response.Body), ZipArchiveMode.Create, leaveOpen: true);
        foreach (var photo in photos)
        {
            if (!files.TryGetValue(photo.FileId, out var file)) continue;
            var path = uploads.PathFor(file.Sha256);
            if (!File.Exists(path)) continue;
            var entry = zip.CreateEntry(ZipNames.Unique(used, file.Name), CompressionLevel.NoCompression);
            entry.LastWriteTime = DateTimeOffset.FromUnixTimeMilliseconds(Math.Clamp(photo.SortAt, 315532800000L, 4102444800000L));
            await using var target = await entry.OpenAsync(context.RequestAborted);
            await using var source = File.OpenRead(path);
            await source.CopyToAsync(target, context.RequestAborted);
        }
    }

    /// <summary>ZipArchive seeks when it can; a response body can't, and must be told so without throwing on Position.</summary>
    private sealed class WriteOnly(Stream inner) : Stream
    {
        private long _written;
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => _written; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override Task FlushAsync(CancellationToken cancellationToken) => inner.FlushAsync(cancellationToken);
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => WriteAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await inner.WriteAsync(buffer, cancellationToken);
            _written += buffer.Length;
        }
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
    }
}

/// <summary>File names inside a zip: each one once.</summary>
public static class ZipNames
{
    /// <summary>"IMG_1.jpg", then "IMG_1 (2).jpg" for the next file of that name.</summary>
    public static string Unique(HashSet<string> used, string name)
    {
        if (used.Add(name)) return name;
        var dot = name.LastIndexOf('.');
        var (stem, extension) = dot > 0 ? (name[..dot], name[dot..]) : (name, "");
        for (var n = 2; ; n++)
        {
            var candidate = $"{stem} ({n}){extension}";
            if (used.Add(candidate)) return candidate;
        }
    }
}

/// <summary>Which upload batch last notified, per person and photos channel (in memory; a restart forgets it).</summary>
public sealed class PhotoBatches
{
    private readonly ConcurrentDictionary<(long Channel, string Account), (string Batch, long At)> _last = new();

    /// <summary>True the first time a batch is seen, at most once per <paramref name="everyMs"/> for a person and channel.</summary>
    public bool First(long channelId, string accountKey, string batch, long now, long everyMs)
    {
        var key = (channelId, accountKey);
        while (true)
        {
            if (_last.TryGetValue(key, out var last))
            {
                if (last.Batch == batch || now - last.At < everyMs) return false;
                if (_last.TryUpdate(key, (batch, now), last)) return true;
            }
            else if (_last.TryAdd(key, (batch, now))) return true;
        }
    }
}

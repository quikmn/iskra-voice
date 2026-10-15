using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Whiteboards: a board per whiteboard channel, and one a voice call can open (kept until cleared). A board is a set of
/// objects with fields; every change is an op (an object id and the fields to set), sent in batches. The server gives each
/// batch the board's next seq and relays it to the board's viewers in that order, so every app folds the same ops the same
/// way (a last-writer-wins register per field, ordered by the server). Plain boards are checked field by field and folded
/// into a snapshot here; encrypted boards are envelopes the server can't read, and the apps upload the snapshots.
/// </summary>
public static partial class WhiteboardFeature
{
    public const int MaxOpsPerBatch = 200;
    public const int MaxBatchChars = 48 * 1024;
    public const int MaxLiveChars = 8 * 1024;
    /// <summary>Snapshot plus the batches after it.</summary>
    public const int MaxBoardBytes = 6 * 1024 * 1024;
    public const int MaxPlainSnapshotChars = 4 * 1024 * 1024;
    public const int MaxObjects = 20_000;
    /// <summary>Plain boards: fold once this many batches (or bytes) piled up since the last snapshot.</summary>
    public const int CompactBatches = 500;
    public const int CompactBytes = 512 * 1024;
    /// <summary>Encrypted boards: ask the apps for a snapshot past this many batches (or <see cref="CompactBytes"/>).</summary>
    public const int WantSnapshotBatches = 300;
    /// <summary>Encrypted boards: past this many bytes of batches, new ones wait for a snapshot.</summary>
    public const int MaxEncryptedBatchBytes = 4 * 1024 * 1024;
    public const int PageChars = 1024 * 1024;
    public const int MaxText = 2000;
    public const int MaxPoints = 4000;
    private const double MaxCoord = 1_000_000;
    private const double MaxPoint = 10_000_000;
    private const double MaxZ = 1_000_000_000;
    private static readonly string[] Kinds = ["pen", "hl", "line", "arrow", "rect", "ellipse", "text", "note", "image"];
    /// <summary>One batch at a time across boards: its seq, storing it and relaying it happen together, so events go out in order.</summary>
    private static readonly Lock Gate = new();

    [GeneratedRegex("^[A-Za-z0-9_-]{8,24}$")]
    private static partial Regex ObjectId();

    [GeneratedRegex("^#[0-9a-f]{6}$")]
    private static partial Regex Color();

    [GeneratedRegex("^/files/([A-Za-z0-9_-]{16,64})/[^/?#\\s]{1,255}$")]
    private static partial Regex FileSrc();

    public static void Register(Router router)
    {
        router.Add("wb.boards", Boards);
        router.Add("wb.open", Open);
        router.Add("wb.get", Get);
        router.Add("wb.leave", Leave);
        router.Add("wb.update", Update);
        router.Add("wb.live", Live);
        router.Add("wb.snapshot", Snapshot);
        router.Add("wb.clear", Clear);
    }

    // ── Views and delivery ─────────────────────────────────────────────────────

    private static object View(Store store, WbBoard b) => new
    {
        channelId = b.ChannelId, id = b.Id, seq = b.Seq, openedBy = b.OpenedBy, openedAt = b.OpenedAt,
        encrypted = store.GetE2ee(b.ChannelId) is not null,
    };

    private static JsonObject BatchView(WbBatch b)
    {
        var view = new JsonObject { ["seq"] = b.Seq, ["by"] = b.Author, ["at"] = b.CreatedAt };
        if (b.Version is { } version)
        {
            view["version"] = version;
            view["envelope"] = JsonNode.Parse(b.Data);
        }
        else view["ops"] = JsonNode.Parse(b.Data);
        return view;
    }

    private static string NewId() => Ed25519.ToB64u(RandomNumberGenerator.GetBytes(12));

    /// <summary>Sends to the board's viewers who can still read its channel (not to <paramref name="except"/>).</summary>
    private static void SendToViewers(Hub hub, Store store, Channel channel, string frame, Session? except = null)
    {
        var sessions = hub.Boards.Sessions(channel.Id);
        if (sessions.Count == 0) return;
        var members = store.GetMembers(sessions.Select(x => x.AccountKey).OfType<string>().Distinct().ToList());
        foreach (var session in sessions)
        {
            if (session == except || session.AccountKey is null) continue;
            if (members.TryGetValue(session.AccountKey, out var member) && Permissions.CanRead(member, channel)) session.Send(frame);
        }
    }

    /// <summary>Someone started or stopped viewing a board: its viewers get the new list.</summary>
    public static void ViewersChanged(Hub hub, Store store, long channelId)
    {
        if (store.GetChannel(channelId) is not { } channel) return;
        SendToViewers(hub, store, channel, Frames.Event("wb.viewers", new { channelId, viewers = hub.Boards.Accounts(channelId) }));
    }

    // ── Checks ─────────────────────────────────────────────────────────────────

    private static void NotABot(Session s, Member me)
    {
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't use whiteboards.", "wb_bots");
    }

    /// <summary>A readable channel that can have a board: a whiteboard channel, or a voice channel.</summary>
    private static Channel BoardChannel(Session s, Member me, Body body)
    {
        NotABot(s, me);
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind is not ("whiteboard" or "voice")) throw RequestException.BadRequest("That channel has no whiteboard.", "wb_channel");
        return channel;
    }

    private static void RequireWriter(Member me, Channel channel)
    {
        if (!Permissions.CanSend(me, channel)) throw RequestException.Forbidden("You can't draw on this whiteboard.", "wb_draw");
    }

    /// <summary>The channel's board, if it's the one named (a cleared board's id is gone).</summary>
    private static WbBoard CurrentBoard(Store store, Channel channel, Body body)
    {
        var id = body.String("boardId", 32);
        return store.GetBoard(channel.Id) is { } board && board.Id == id ? board : throw RequestException.NotFound("Board");
    }

    private static bool WantSnapshot(Store store, WbBoard board, E2eeChannel e) =>
        board.Seq > 0 && (board.BatchCount >= WantSnapshotBatches || board.BatchBytes >= CompactBytes
            || (board.SnapSeq > 0 && (board.SnapVersion ?? 0) < e.Version)
            || (board.BatchCount > 0 && store.OldestBatchVersion(board.ChannelId) is { } oldest && oldest < e.Version));

    // ── Requests ───────────────────────────────────────────────────────────────

    /// <summary>Open boards in voice channels you can read.</summary>
    private static object Boards(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var channels = store.AllChannels().ToDictionary(c => c.Id);
        return new
        {
            boards = store.VoiceBoards()
                .Where(b => channels.TryGetValue(b.ChannelId, out var c) && Permissions.CanRead(me, c))
                .Select(b => View(store, b)),
        };
    }

    /// <summary>Opens a voice channel's board (someone in the call who can post in its chat). Answers the open one if any.</summary>
    private static object Open(Session s, Member me, Body body)
    {
        var channel = BoardChannel(s, me, body);
        if (channel.Kind != "voice") throw RequestException.BadRequest("Whiteboards open in voice channels.", "wb_voice_only");
        RequireWriter(me, channel);
        if (!s.Voice.Watch.InRoom(channel.Id, me.AccountKey)) throw RequestException.BadRequest("Join the voice channel first.", "voice_join_first");
        var store = s.World.Store;
        var (board, created) = store.EnsureBoard(channel.Id, NewId(), me.AccountKey, s.Now);
        if (created) s.Hub.BroadcastToReaders(channel, Frames.Event("wb.board", new { channelId = channel.Id, board = View(store, board) }));
        return new { board = View(store, board) };
    }

    /// <summary>The board (snapshot and batches after it, or after <c>since</c>); this session views it from now on.</summary>
    private static object Get(Session s, Member me, Body body)
    {
        var channel = BoardChannel(s, me, body);
        var store = s.World.Store;
        var since = body.OptionalLong("since", 0);
        long? previous;
        WbBoard? board;
        bool fresh;
        lock (Gate)
        {
            board = channel.Kind == "whiteboard" ? store.EnsureBoard(channel.Id, NewId(), null, s.Now).Board : store.GetBoard(channel.Id);
            previous = s.Hub.Boards.View(s, channel.Id);
            fresh = previous != channel.Id;
            if (board is null)
            {
                if (fresh) ViewersChanged(s.Hub, store, channel.Id);
                if (previous is { } p && fresh) ViewersChanged(s.Hub, store, p);
                return new { board = (object?)null, snapshot = (object?)null, batches = Array.Empty<object>(), hasMore = false, viewers = s.Hub.Boards.Accounts(channel.Id), wantSnapshot = false };
            }
            var e = store.GetE2ee(channel.Id);
            JsonObject? snapshot = null;
            var after = since ?? 0;
            if ((since is null || since < board.SnapSeq) && board.SnapSeq > 0 && store.BoardSnapshot(channel.Id) is { } data)
            {
                snapshot = new JsonObject { ["seq"] = board.SnapSeq, ["at"] = board.SnapAt };
                if (e is null) snapshot["objects"] = JsonNode.Parse(data);
                else
                {
                    snapshot["by"] = board.SnapBy;
                    snapshot["version"] = board.SnapVersion;
                    snapshot["envelope"] = JsonNode.Parse(data);
                }
                after = board.SnapSeq;
            }
            var (batches, hasMore) = store.Batches(channel.Id, after, PageChars);
            if (fresh) ViewersChanged(s.Hub, store, channel.Id);
            if (previous is { } old && fresh) ViewersChanged(s.Hub, store, old);
            return new
            {
                board = View(store, board), snapshot, batches = new JsonArray(batches.Select(b => (JsonNode)BatchView(b)).ToArray()), hasMore,
                viewers = s.Hub.Boards.Accounts(channel.Id), wantSnapshot = e is not null && WantSnapshot(store, board, e),
            };
        }
    }

    private static object? Leave(Session s, Member me, Body body)
    {
        var channelId = body.Long("channelId");
        if (s.Hub.Boards.Viewing(s) == channelId && s.Hub.Boards.Leave(s) is { } left) ViewersChanged(s.Hub, s.World.Store, left);
        return null;
    }

    /// <summary>A batch of ops (plain) or an envelope of them (encrypted), as the board's next seq.</summary>
    private static object Update(Session s, Member me, Body body)
    {
        var channel = BoardChannel(s, me, body);
        RequireWriter(me, channel);
        var store = s.World.Store;
        var boardId = body.String("boardId", 32);
        var cid = body.OptionalString("cid", 24);
        var e = store.GetE2ee(channel.Id);
        string data;
        long? version = null;
        string[] files = [];
        var onlyDeletes = false;
        JsonNode? live = null;
        if (e is null)
        {
            if (body.Has("envelope")) throw RequestException.BadRequest("That board isn't end-to-end encrypted.");
            var parsed = ParseOps(store, body.Element("ops"));
            if (parsed.Texts.Count > 0) AutoModFeature.Check(s, me, channel, string.Join("\n", parsed.Texts), "whiteboard");
            (data, files, onlyDeletes) = (parsed.Json, parsed.Files, parsed.OnlyDeletes);
            if (body.OptionalElement("live") is { } raw) live = ParseLive(raw, canDraw: true);
        }
        else
        {
            if (body.Has("ops") || body.Has("live")) throw RequestException.BadRequest("Encrypted boards carry everything inside the envelope.");
            (version, data) = Sealed(me, channel, e, body, body.Element("envelope"), "ops", boardId, MaxBatchChars, null);
        }
        var bytes = Encoding.UTF8.GetByteCount(data);

        lock (Gate)
        {
            var board = store.GetBoard(channel.Id) is { } b && b.Id == boardId ? b : throw RequestException.NotFound("Board");
            if (e is null)
            {
                if (!onlyDeletes && board.SnapBytes + board.BatchBytes + bytes > MaxBoardBytes) throw Full();
            }
            else if (board.BatchBytes + bytes > MaxEncryptedBatchBytes || board.SnapBytes + board.BatchBytes + bytes > MaxBoardBytes)
            {
                throw board.BatchCount > 0
                    ? RequestException.BadRequest("This board needs tidying up first. Try again in a moment.", "wb_compact")
                    : Full();
            }
            var seq = store.AppendBatch(channel.Id, boardId, me.AccountKey, data, version, s.Now, files) ?? throw RequestException.NotFound("Board");
            board = board with { Seq = seq, BatchCount = board.BatchCount + 1, BatchBytes = board.BatchBytes + bytes };
            var batch = BatchView(new WbBatch(channel.Id, seq, me.AccountKey, data, version, s.Now));
            var frame = new JsonObject { ["channelId"] = channel.Id, ["boardId"] = boardId, ["batch"] = batch };
            if (cid is not null) frame["cid"] = cid;
            if (e is not null && WantSnapshot(store, board, e)) frame["wantSnapshot"] = true;
            SendToViewers(s.Hub, store, channel, Frames.Event("wb.batch", frame));
            if (live is not null)
                SendToViewers(s.Hub, store, channel, Frames.Event("wb.live", new { channelId = channel.Id, boardId, accountKey = me.AccountKey, live }), except: s);
            if (e is null && (board.BatchCount >= CompactBatches || board.BatchBytes >= CompactBytes)) Compact(store, board, s.Now);
            return new { seq };
        }
    }

    private static RequestException Full() =>
        RequestException.BadRequest("This whiteboard is full. Erase something or clear it first.", "wb_full");

    /// <summary>Live cursors and the stroke being drawn: passed on to the board's other viewers, never stored.</summary>
    private static object? Live(Session s, Member me, Body body)
    {
        var channel = BoardChannel(s, me, body);
        var store = s.World.Store;
        if (s.Hub.Boards.Viewing(s) != channel.Id) throw RequestException.BadRequest("Open the whiteboard first.");
        var board = CurrentBoard(store, channel, body);
        object frame;
        if (store.GetE2ee(channel.Id) is { } e)
        {
            if (body.Has("live")) throw RequestException.BadRequest("Encrypted boards carry everything inside the envelope.");
            var (version, raw) = Sealed(me, channel, e, body, body.Element("envelope"), "live", board.Id, MaxLiveChars, null);
            frame = new { channelId = channel.Id, boardId = board.Id, accountKey = me.AccountKey, version, envelope = JsonNode.Parse(raw) };
        }
        else
        {
            var live = ParseLive(body.Element("live"), Permissions.CanSend(me, channel));
            frame = new { channelId = channel.Id, boardId = board.Id, accountKey = me.AccountKey, live };
        }
        SendToViewers(s.Hub, store, channel, Frames.Event("wb.live", frame), except: s);
        return null;
    }

    /// <summary>Encrypted boards: an app's snapshot of the board after <c>seq</c>, sealed under the current epoch.</summary>
    private static object? Snapshot(Session s, Member me, Body body)
    {
        var channel = BoardChannel(s, me, body);
        RequireWriter(me, channel);
        var store = s.World.Store;
        var e = store.GetE2ee(channel.Id) ?? throw RequestException.BadRequest("The server keeps the snapshots of boards that aren't encrypted.");
        var boardId = body.String("boardId", 32);
        var seq = body.OptionalLong("seq", 1) ?? throw RequestException.BadRequest("'seq' is required.");
        string raw;
        if (body.Has("file"))
        {
            if (body.Has("envelope")) throw RequestException.BadRequest("Send the envelope or a file, not both.");
            var file = store.GetFile(body.String("file", 64));
            if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown snapshot file.");
            if (file.Size > MaxBoardBytes) throw Full();
            try
            {
                raw = new UTF8Encoding(false, true).GetString(File.ReadAllBytes(s.Uploads.PathFor(file.Sha256)));
            }
            catch (DecoderFallbackException) { throw RequestException.BadRequest("A snapshot must be JSON text."); }
            catch (IOException) { throw RequestException.NotFound("Snapshot file"); }
        }
        else raw = body.Element("envelope").GetRawText();
        JsonElement envelope;
        try { envelope = JsonDocument.Parse(raw).RootElement; }
        catch (JsonException) { throw RequestException.BadRequest("A snapshot must be JSON text."); }
        var (version, sealedRaw) = Sealed(me, channel, e, body, envelope, "snapshot", boardId, MaxBoardBytes, seq);

        lock (Gate)
        {
            var board = store.GetBoard(channel.Id) is { } b && b.Id == boardId ? b : throw RequestException.NotFound("Board");
            // Newer than the snapshot there is, or the same one sealed again under a newer key (for people who joined since).
            var newer = seq > board.SnapSeq || (seq == board.SnapSeq && (board.SnapVersion ?? 0) < version);
            if (!newer || seq > board.Seq) throw RequestException.BadRequest("That snapshot is out of date.", "wb_snapshot_old");
            if (!store.SaveBoardSnapshot(channel.Id, boardId, seq, sealedRaw, me.AccountKey, s.Now, version, null))
                throw RequestException.BadRequest("That snapshot is out of date.", "wb_snapshot_old");
            SendToViewers(s.Hub, store, channel, Frames.Event("wb.snapshot", new { channelId = channel.Id, boardId, seq }));
        }
        return null;
    }

    /// <summary>Clears a board: moderators, or whoever opened a voice channel's board.</summary>
    private static object? Clear(Session s, Member me, Body body)
    {
        var channel = BoardChannel(s, me, body);
        var store = s.World.Store;
        var board = CurrentBoard(store, channel, body);
        var mayClear = Permissions.CanSend(me, channel)
            && (Permissions.CanPin(me, channel) || (channel.Kind == "voice" && board.OpenedBy == me.AccountKey));
        if (!mayClear) throw RequestException.Forbidden("Only a moderator can clear this whiteboard.", "wb_clear");
        lock (Gate)
        {
            if (!store.ClearBoard(channel.Id, board.Id, channel.Kind == "whiteboard" ? NewId() : null, s.Now)) throw RequestException.NotFound("Board");
        }
        Audit.Record(s, "wb.clear", details: new { channelId = channel.Id, channelName = channel.Name });
        s.Hub.BroadcastToReaders(channel, Frames.Event("wb.cleared", new { channelId = channel.Id, boardId = board.Id }));
        if (channel.Kind == "voice") s.Hub.BroadcastToReaders(channel, Frames.Event("wb.board", new { channelId = channel.Id, board = (object?)null }));
        return null;
    }

    // ── Encrypted envelopes ────────────────────────────────────────────────────

    /// <summary>
    /// Checks a board envelope's routing (the server reads nothing else): sent by you, in the chain, under the current
    /// version, for this channel, board and purpose. Returns the version and the envelope as sent.
    /// </summary>
    private static (long Version, string Raw) Sealed(Member me, Channel channel, E2eeChannel e, Body body, JsonElement envelope,
        string what, string boardId, int maxChars, long? seq)
    {
        if (!e.Members.Contains(me.AccountKey)) throw RequestException.Forbidden("You don't have this channel's key yet.");
        var version = body.OptionalLong("version", 1) ?? throw RequestException.BadRequest("'version' is required.");
        if (version != e.Version) throw new RequestException("conflict", "Who's in this channel changed in the meantime. Refresh and try again.", "e2ee_members_changed");
        if (envelope.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'envelope' must be an object.");
        var raw = envelope.GetRawText();
        if (raw.Length > maxChars) throw what == "snapshot" ? Full() : RequestException.BadRequest("That change is too big for the whiteboard.", "wb_batch_size");
        var env = new Body(envelope);
        var header = env.OptionalElement("header") is { ValueKind: JsonValueKind.Object } h ? new Body(h) : throw RequestException.BadRequest("Envelope without a header.");
        if (env.OptionalString("kind", 8) != "wb" || header.OptionalString("from", 64) != me.AccountKey || header.OptionalString("chain", 32) != e.ChainId
            || header.OptionalLong("version") != version || header.OptionalLong("channel") != channel.Id || header.OptionalString("board", 32) != boardId
            || header.OptionalString("what", 16) != what || header.OptionalLong("seq") != seq)
            throw RequestException.BadRequest("The envelope doesn't match this board.");
        return (version, raw);
    }

    // ── Plain boards: ops, live cursors, compaction ────────────────────────────

    internal sealed record ParsedOps(string Json, string[] Files, List<string> Texts, bool OnlyDeletes);

    /// <summary>A plain batch, field by field (PROTOCOL.md → Whiteboards → The board model). Unknown or bad fields are refused.</summary>
    internal static ParsedOps ParseOps(Store store, JsonElement ops)
    {
        if (ops.ValueKind != JsonValueKind.Array || ops.GetArrayLength() is 0 or > MaxOpsPerBatch)
            throw RequestException.BadRequest($"'ops' must be a list of 1–{MaxOpsPerBatch} changes.");
        if (ops.GetRawText().Length > MaxBatchChars) throw RequestException.BadRequest("That change is too big for the whiteboard.", "wb_batch_size");
        var list = new JsonArray();
        var files = new HashSet<string>(StringComparer.Ordinal);
        var texts = new List<string>();
        var onlyDeletes = true;
        foreach (var op in ops.EnumerateArray())
        {
            if (op.ValueKind != JsonValueKind.Object) throw Bad("Each change must be an object.");
            string? id = null;
            JsonObject? props = null;
            foreach (var part in op.EnumerateObject())
            {
                if (part.Name == "id" && part.Value.ValueKind == JsonValueKind.String && ObjectId().IsMatch(part.Value.GetString()!)) id = part.Value.GetString();
                else if (part.Name == "p" && part.Value.ValueKind == JsonValueKind.Object) props = Props(store, part.Value, files, texts, ref onlyDeletes);
                else throw Bad("Each change is { id, p }.");
            }
            if (id is null || props is null || props.Count == 0) throw Bad("Each change is { id, p }.");
            list.Add(new JsonObject { ["id"] = id, ["p"] = props });
        }
        return new ParsedOps(list.ToJsonString(), [.. files], texts, onlyDeletes);
    }

    private static RequestException Bad(string message) => RequestException.BadRequest(message);

    private static JsonObject Props(Store store, JsonElement p, HashSet<string> files, List<string> texts, ref bool onlyDeletes)
    {
        var props = new JsonObject();
        foreach (var field in p.EnumerateObject())
        {
            var v = field.Value;
            if (props.ContainsKey(field.Name)) throw Bad($"'{field.Name}' is there twice.");
            if (v.ValueKind == JsonValueKind.Null)
            {
                if (field.Name is not ("kind" or "x" or "y" or "w" or "h" or "pts" or "color" or "fill" or "size" or "text" or "src" or "z" or "d"))
                    throw Bad($"Unknown whiteboard field '{Clip(field.Name)}'.");
                props[field.Name] = null;
                onlyDeletes = false;
                continue;
            }
            JsonNode value = field.Name switch
            {
                "kind" => v.ValueKind == JsonValueKind.String && Kinds.Contains(v.GetString()) ? v.GetString()! : throw Bad("Unknown kind of whiteboard object."),
                "x" or "y" or "w" or "h" => Number(v, field.Name, -MaxCoord, MaxCoord),
                "size" => Number(v, field.Name, 1, 200),
                "z" => Number(v, field.Name, -MaxZ, MaxZ),
                "pts" => Points(v),
                "color" or "fill" => v.ValueKind == JsonValueKind.String && Color().IsMatch(v.GetString()!) ? v.GetString()! : throw Bad($"'{field.Name}' must be a colour like #1a2b3c."),
                "text" => TextField(v, texts),
                "src" => Picture(store, v, files),
                "d" => v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : throw Bad("'d' must be true or false."),
                _ => throw Bad($"Unknown whiteboard field '{Clip(field.Name)}'."),
            };
            if (!(field.Name == "d" && v.ValueKind == JsonValueKind.True)) onlyDeletes = false;
            props[field.Name] = value;
        }
        return props;
    }

    private static string Clip(string name) => name.Length <= 24 ? name : name[..24];

    private static JsonNode Number(JsonElement v, string name, double min, double max)
    {
        if (v.ValueKind != JsonValueKind.Number || !v.TryGetDouble(out var n) || !double.IsFinite(n) || n < min || n > max)
            throw Bad($"'{name}' is out of range.");
        return JsonValue.Create(n);
    }

    private static JsonNode Points(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Array) throw Bad("'pts' must be a list of numbers.");
        var count = v.GetArrayLength();
        if (count < 2 || count > MaxPoints || count % 2 != 0) throw Bad($"'pts' must hold 2–{MaxPoints} numbers, in pairs.");
        var list = new JsonArray();
        foreach (var n in v.EnumerateArray())
        {
            if (n.ValueKind != JsonValueKind.Number || !n.TryGetInt64(out var whole) || Math.Abs(whole) > MaxPoint) throw Bad("'pts' must be whole numbers.");
            list.Add(whole);
        }
        return list;
    }

    private static JsonNode TextField(JsonElement v, List<string> texts)
    {
        if (v.ValueKind != JsonValueKind.String) throw Bad("'text' must be a string.");
        var text = v.GetString()!;
        if (text.Length > MaxText) throw RequestException.BadRequest($"Text on a whiteboard can be up to {MaxText} characters.", "wb_text_length", new { max = MaxText });
        if (text.Any(c => c is not ('\n' or '\t') && char.GetUnicodeCategory(c) is UnicodeCategory.Control))
            throw Bad("'text' can't hold control characters.");
        if (text.Length > 0) texts.Add(text);
        return text;
    }

    /// <summary>A picture must be an image uploaded to this server; the board keeps the file while it refers to it.</summary>
    private static JsonNode Picture(Store store, JsonElement v, HashSet<string> files)
    {
        if (v.ValueKind != JsonValueKind.String || FileSrc().Match(v.GetString()!) is not { Success: true } m)
            throw Bad("'src' must be a /files/… link to this server.");
        var file = store.GetFile(m.Groups[1].Value);
        if (file is null || !file.Type.StartsWith("image/", StringComparison.Ordinal))
            throw RequestException.BadRequest("Pictures on a whiteboard must be images uploaded to this server.", "wb_picture");
        files.Add(file.Id);
        return v.GetString()!;
    }

    /// <summary>A live cursor: where it is, the tool, and the stroke being drawn (only from people who can draw).</summary>
    internal static JsonNode ParseLive(JsonElement live, bool canDraw)
    {
        if (live.ValueKind != JsonValueKind.Object) throw Bad("'live' must be an object.");
        if (live.GetRawText().Length > MaxLiveChars) throw Bad("'live' is too big.");
        var node = JsonNode.Parse(live.GetRawText())!.AsObject();
        foreach (var (name, value) in node)
        {
            switch (name)
            {
                case "x" or "y":
                    if (value is not JsonValue n || !n.TryGetValue<double>(out var d) || !double.IsFinite(d) || Math.Abs(d) > MaxCoord * 10) throw Bad("'live' needs x and y.");
                    break;
                case "tool":
                    if (value is not JsonValue t || !t.TryGetValue<string>(out var tool) || tool.Length > 16) throw Bad("'tool' must be a short name.");
                    break;
                case "draft":
                    if (!canDraw) throw RequestException.Forbidden("You can't draw on this whiteboard.", "wb_draw");
                    if (value is not JsonObject) throw Bad("'draft' must be an object.");
                    break;
                default:
                    throw Bad($"Unknown live field '{Clip(name)}'.");
            }
        }
        if (!node.ContainsKey("x") || !node.ContainsKey("y")) throw Bad("'live' needs x and y.");
        return node;
    }

    /// <summary>
    /// Folds a plain board's batches into its snapshot (dropping deleted objects). Leaves it as it is when the result would
    /// pass <see cref="MaxObjects"/> or <see cref="MaxPlainSnapshotChars"/>. Runs under <see cref="Gate"/>.
    /// </summary>
    internal static bool Compact(Store store, WbBoard board, long now)
    {
        var objects = board.SnapSeq > 0 && store.BoardSnapshot(board.ChannelId) is { } snap ? JsonNode.Parse(snap)!.AsObject() : new JsonObject();
        var (batches, _) = store.Batches(board.ChannelId, board.SnapSeq, int.MaxValue);
        if (batches.Count == 0) return false;
        foreach (var batch in batches)
        {
            foreach (var op in JsonNode.Parse(batch.Data)!.AsArray())
            {
                var id = (string)op!["id"]!;
                if (objects[id] is not JsonObject target)
                {
                    target = new JsonObject();
                    objects[id] = target;
                }
                foreach (var (name, value) in op["p"]!.AsObject())
                {
                    if (value is null) target.Remove(name);
                    else target[name] = value.DeepClone();
                }
            }
        }
        var gone = objects.Where(o => o.Value is not JsonObject x || x["kind"] is null || (x["d"] is JsonValue d && d.TryGetValue<bool>(out var deleted) && deleted))
            .Select(o => o.Key).ToList();
        foreach (var id in gone) objects.Remove(id);
        if (objects.Count > MaxObjects) return false;
        var json = objects.ToJsonString();
        if (json.Length > MaxPlainSnapshotChars) return false;
        var files = objects.Select(o => o.Value?["src"] is JsonValue src && src.TryGetValue<string>(out var path) ? FileSrc().Match(path) : Match.Empty)
            .Where(m => m.Success).Select(m => m.Groups[1].Value).Distinct().ToArray();
        return store.SaveBoardSnapshot(board.ChannelId, board.Id, batches[^1].Seq, json, null, now, null, files);
    }
}

/// <summary>Which board each session is viewing (one at a time), for relaying batches and live cursors.</summary>
public sealed class BoardRegistry
{
    private readonly Lock _gate = new();
    private readonly Dictionary<Session, long> _viewing = [];

    /// <summary>The session views this channel's board now. Returns what it viewed before (null: nothing).</summary>
    public long? View(Session session, long channelId)
    {
        lock (_gate)
        {
            long? before = _viewing.TryGetValue(session, out var old) ? old : null;
            _viewing[session] = channelId;
            return before;
        }
    }

    /// <summary>Stops viewing. Returns the channel it viewed, if any.</summary>
    public long? Leave(Session session)
    {
        lock (_gate) return _viewing.Remove(session, out var old) ? old : null;
    }

    public long? Viewing(Session session)
    {
        lock (_gate) return _viewing.TryGetValue(session, out var id) ? id : null;
    }

    public List<Session> Sessions(long channelId)
    {
        lock (_gate) return _viewing.Where(v => v.Value == channelId).Select(v => v.Key).ToList();
    }

    public string[] Accounts(long channelId)
    {
        lock (_gate) return _viewing.Where(v => v.Value == channelId).Select(v => v.Key.AccountKey).OfType<string>().Distinct().ToArray();
    }
}

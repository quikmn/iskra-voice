using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// End-to-end encrypted channels: small private text and voice channels whose messages only the members' devices can read.
/// Membership is a signed chain like a group DM's (same payload format, its own signing context and rules), kept in step
/// with who may read the channel: a member's app adds people who gained read access and removes people who lost it, and
/// every change brings a new random channel key (an epoch), wrapped for each member device in DM envelopes. Messages are
/// encrypted with the key of the current epoch and signed by the sender's device. The server stores ciphertext, checks that
/// changes follow the permissions, and only ever delivers envelopes to people who can read the channel.
/// </summary>
public static class E2eeChannelFeature
{
    public const string Context = "iskra/channel-change/v1";
    public const int MaxMembers = 50;
    public const int MaxPayloadChars = 8192;
    /// <summary>One key envelope: a slot for up to ~180 devices. Bigger member lists use several.</summary>
    public const int MaxKeyEnvelopeBytes = 52 * 1024;
    public const int MaxKeysPerVersion = 64;
    public const int MaxMessageEnvelopeBytes = 32 * 1024;
    public const int MaxKeysPerFetch = 200;
    private static readonly Lock Gate = new(); // one membership change at a time, so versions never fork

    public static void Register(Router router)
    {
        router.Add("echan.get", Get);
        router.Add("echan.change", Change);
        router.Add("echan.keys.add", AddKeys);
        router.Add("echan.keys", Keys);
    }

    // ── Helpers used by other features ─────────────────────────────────────────

    public static bool IsEncrypted(Store store, Channel channel) => store.GetE2ee(channel.Id) is not null;

    /// <summary>Features that would store or post readable text in a channel refuse encrypted ones.</summary>
    public static void RefusePlaintext(Store store, Channel channel, string what)
    {
        if (IsEncrypted(store, channel))
            throw RequestException.BadRequest($"{what} can't be used in an end-to-end encrypted channel: the server can't read or write its messages.");
    }

    /// <summary>The <c>e2ee</c> field of a Channel.</summary>
    public static object? Info(E2eeChannel? e) => e is null ? null : new { chain = e.ChainId, version = e.Version };

    public static object? Info(Store store, long channelId) => Info(store.GetE2ee(channelId));

    /// <summary>The <c>e2ee</c> field of a Message: the envelope as sent and the chain version it was encrypted for.</summary>
    public static object? MessageView(Store store, long messageId) =>
        store.GetE2eeMessage(messageId) is { } m ? new { version = m.Version, envelope = JsonDocument.Parse(m.Envelope).RootElement.Clone() } : null;

    /// <summary>Who should be in the chain: people (not bots) who can read the channel now, in join order.</summary>
    public static List<string> Readers(Store store, Channel channel) =>
        store.AllMembers().Where(m => !store.IsBot(m.AccountKey) && Permissions.CanRead(m, channel)).Select(m => m.AccountKey).ToList();

    /// <summary>Encrypted channels hold at most <see cref="MaxMembers"/> readers; settings that would let more in are refused.</summary>
    public static void CheckCapacity(Store store, Channel channel)
    {
        if (!IsEncrypted(store, channel)) return;
        if (Readers(store, channel).Count > MaxMembers)
            throw RequestException.BadRequest($"At most {MaxMembers} people can read an end-to-end encrypted channel.", "e2ee_readers_max", new { max = MaxMembers });
    }

    // ── Creating ───────────────────────────────────────────────────────────────

    public sealed record Prepared(GroupChange Change, string Payload, string Sig, byte[] PayloadBytes, List<(string[] Devices, string Envelope)> Keys);

    /// <summary>
    /// Checks <c>e2ee</c> on channel.create before the channel exists: a <c>create</c> change by you listing exactly the people
    /// who will be able to read it, and its first key envelopes.
    /// </summary>
    public static Prepared? CheckCreate(Session s, Member me, Body body, string kind, string readRole, string writeRole)
    {
        if (body.OptionalElement("e2ee") is not { } raw) return null;
        if (raw.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'e2ee' must be an object.");
        if (kind is not ("text" or "voice")) throw RequestException.BadRequest("Only text and voice channels can be end-to-end encrypted.", "e2ee_kinds");
        NotABot(s, me);
        var e2ee = new Body(raw);
        var (change, payloadText, sig, payload) = ParseChange(s, me, e2ee);
        if (change.Action != "create") throw RequestException.BadRequest("Use a 'create' change.");
        var draft = new Channel(0, "", kind, 0, readRole, writeRole);
        if (!Permissions.CanRead(me, draft)) throw RequestException.BadRequest("You must be able to read an encrypted channel you create.", "e2ee_must_read");
        CheckCreateMembers(s.World.Store, draft, change);
        ChannelChain.Apply(null, change);
        var keys = KeyEnvelopes(e2ee, change, me, required: true);
        if (!s.Hub.Limits.TryTake(me.AccountKey, "group.change"))
            throw new RequestException("rate_limited", "Too many changes in a short time. Try again in a minute.", "too_many_changes");
        return new Prepared(change, payloadText, sig, payload, keys);
    }

    public static void Created(Session s, Channel channel, Prepared p)
    {
        var e = new E2eeChannel(channel.Id, p.Change.Group, 1, GroupChain.Head(p.PayloadBytes), p.Change.Members, s.Now);
        lock (Gate)
        {
            if (s.World.Store.AllE2ee().Values.Any(x => x.ChainId == e.ChainId)) throw RequestException.BadRequest("That chain id is taken.");
            s.World.Store.SaveE2eeChange(e, new E2eeChange(1, p.Payload, p.Sig, p.Change.By, s.Now), p.Keys, fresh: true);
        }
    }

    /// <summary>A create lists exactly the readers (you first), and fits.</summary>
    private static void CheckCreateMembers(Store store, Channel channel, GroupChange change)
    {
        var readers = Readers(store, channel);
        if (readers.Count > MaxMembers)
            throw RequestException.BadRequest($"At most {MaxMembers} people can read an end-to-end encrypted channel. Choose who can read it more narrowly.", "e2ee_readers_narrow", new { max = MaxMembers });
        if (!readers.ToHashSet(StringComparer.Ordinal).SetEquals(change.Members) || change.Members.Length != readers.Count)
            throw new RequestException("conflict", "Who can read this channel changed in the meantime. Try again.", "e2ee_readers_changed");
    }

    // ── Requests ───────────────────────────────────────────────────────────────

    private static void NotABot(Session s, Member me)
    {
        if (s.World.Store.IsBot(me.AccountKey))
            throw RequestException.Forbidden("Bots can't take part in end-to-end encrypted channels: they don't hold the channel's keys.");
    }

    /// <summary>A readable encrypted channel (threads: their parent).</summary>
    private static (Channel Channel, E2eeChannel E2ee) Encrypted(Session s, Member me, long id)
    {
        var channel = ChatFeature.ReadableChannel(s, me, id);
        if (channel.Kind == "thread") throw RequestException.BadRequest("Use the thread's channel.");
        var e = s.World.Store.GetE2ee(channel.Id) ?? throw RequestException.BadRequest("That channel isn't end-to-end encrypted.");
        return (channel, e);
    }

    private static (string[] Add, string[] Remove, bool Full) Want(Store store, Channel channel, E2eeChannel e)
    {
        var readers = Readers(store, channel);
        var inChain = e.Members.ToHashSet(StringComparer.Ordinal);
        var remove = e.Members.Where(m => !readers.Contains(m)).ToArray();
        var add = readers.Where(r => !inChain.Contains(r)).ToArray();
        var room = MaxMembers - (e.Members.Length - remove.Length);
        return (add.Take(Math.Max(0, room)).ToArray(), remove, add.Length > room);
    }

    private static object Public(E2eeChannel e) => new { chain = e.ChainId, version = e.Version, head = e.Head, members = e.Members };

    /// <summary>The chain after <c>since</c>, and who should be added or removed to match the permissions.</summary>
    private static object Get(Session s, Member me, Body body)
    {
        var (channel, e) = Encrypted(s, me, body.Long("channelId"));
        var since = body.OptionalLong("since", 0, e.Version) ?? 0;
        var (add, remove, full) = Want(s.World.Store, channel, e);
        return new
        {
            e2ee = Public(e),
            changes = s.World.Store.E2eeChanges(channel.Id, since).Select(c => new { version = c.Version, payload = c.Payload, sig = c.Sig }),
            want = new { add, remove, full },
        };
    }

    private static (GroupChange Change, string Payload, string Sig, byte[] Bytes) ParseChange(Session s, Member me, Body body)
    {
        var wire = body.Element("change");
        if (wire.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'change' must be an object.");
        var changeBody = new Body(wire);
        var payloadText = changeBody.String("payload", MaxPayloadChars);
        var sig = changeBody.String("sig", 128);
        var (change, payload) = GroupChain.Parse(payloadText, sig, Context, MaxMembers, MaxPayloadChars);
        if (change.By != me.AccountKey) throw RequestException.BadRequest("Sign changes with your own account.");
        if (Math.Abs(change.At - s.Now) > GroupChain.MaxClockSkew.TotalMilliseconds) throw RequestException.BadRequest("The change's time is off. Check your clock.", "clock_off");
        return (change, payloadText, sig, payload);
    }

    /// <summary>
    /// The next membership change, with the new epoch's first key envelopes. Who changes what follows the permissions:
    /// add people (not bots) who can read the channel now, remove people who can't, or just rekey. A chain whose members
    /// all lost access can be started again (a new <c>create</c>) by someone who can read it.
    /// </summary>
    private static object Change(Session s, Member me, Body body)
    {
        NotABot(s, me);
        var (channel, current) = Encrypted(s, me, body.Long("channelId"));
        var store = s.World.Store;
        var (change, payloadText, sig, payload) = ParseChange(s, me, body);
        var keys = KeyEnvelopes(body, change, me, required: true);
        if (!s.Hub.Limits.TryTake(me.AccountKey, "group.change"))
            throw new RequestException("rate_limited", "Too many changes in a short time. Try again in a minute.", "too_many_changes");

        E2eeChannel after;
        var fresh = false;
        lock (Gate)
        {
            current = store.GetE2ee(channel.Id)!;
            var readers = Readers(store, channel).ToHashSet(StringComparer.Ordinal);
            if (change.Action == "create")
            {
                // Starting over: only when nobody left in the chain can read the channel (so nobody could hand the key on).
                if (current.Members.Any(readers.Contains)) throw RequestException.BadRequest("This channel's members can still add you.");
                if (change.Group == current.ChainId) throw RequestException.BadRequest("A new chain needs a new id.");
                CheckCreateMembers(store, channel, change);
                fresh = true;
            }
            else
            {
                if (change.Group != current.ChainId) throw RequestException.BadRequest("That change is for another channel.");
                if (!current.Members.Contains(me.AccountKey)) throw RequestException.Forbidden("You aren't in this channel's encryption yet.");
                switch (change.Action)
                {
                    case "add":
                        if (change.Targets.Any(t => !readers.Contains(t)))
                            throw RequestException.BadRequest("Only people who can read the channel can be added.");
                        break;
                    case "remove":
                        if (change.Targets.Any(readers.Contains))
                            throw RequestException.BadRequest("Only people who can't read the channel any more can be removed.");
                        break;
                }
            }
            var members = ChannelChain.Apply(fresh ? null : current, change);
            after = new E2eeChannel(channel.Id, change.Group, change.Version, GroupChain.Head(payload), members, fresh ? s.Now : current.CreatedAt);
            store.SaveE2eeChange(after, new E2eeChange(change.Version, payloadText, sig, me.AccountKey, s.Now), keys, fresh);
        }

        s.Hub.BroadcastToReaders(channel, Frames.Event("echan.changed", new
        {
            channelId = channel.Id, e2ee = Public(after), change = new { version = change.Version, payload = payloadText, sig },
        }));
        return new { e2ee = Public(after) };
    }

    /// <summary>More key envelopes for the epoch you started (member lists too big for one).</summary>
    private static object? AddKeys(Session s, Member me, Body body)
    {
        NotABot(s, me);
        var (channel, e) = Encrypted(s, me, body.Long("channelId"));
        var version = body.Long("version");
        var change = s.World.Store.E2eeChangeAt(channel.Id, version);
        if (change is null || change.By != me.AccountKey || version != e.Version)
            throw RequestException.Forbidden("Only whoever made the newest change hands out its key.");
        var stub = new GroupChange(e.ChainId, version, "", me.AccountKey, "rekey", [], [], 0);
        var keys = KeyEnvelopes(body, stub, me, required: true);
        lock (Gate)
        {
            if (s.World.Store.E2eeKeyCount(channel.Id, version) + keys.Count > MaxKeysPerVersion)
                throw RequestException.BadRequest("Too many key envelopes for one version.");
            foreach (var (devices, envelope) in keys) s.World.Store.AddE2eeKey(channel.Id, version, me.AccountKey, devices, envelope, s.Now);
        }
        var frame = Frames.Event("echan.keys", new { channelId = channel.Id, version });
        s.Hub.BroadcastToReaders(channel, frame);
        return null;
    }

    /// <summary>Key envelopes with a slot for this device, from version <c>since</c> on.</summary>
    private static object Keys(Session s, Member me, Body body)
    {
        var (channel, e) = Encrypted(s, me, body.Long("channelId"));
        var since = body.OptionalLong("since", 1, e.Version) ?? 1;
        var device = s.DeviceKey ?? throw RequestException.BadRequest("This connection has no device.");
        var keys = s.World.Store.E2eeKeysFor(channel.Id, device, since, MaxKeysPerFetch);
        return new
        {
            keys = keys.Select(k => new { version = k.Version, from = k.From, envelope = JsonDocument.Parse(k.Envelope).RootElement.Clone() }),
            hasMore = keys.Count == MaxKeysPerFetch,
        };
    }

    /// <summary>
    /// The <c>keys</c> of a change: channel key envelopes (DM envelope v2 with a channel-key header) for that version, from you.
    /// The server only reads the header and which devices have a slot (so each device fetches only its own).
    /// </summary>
    private static List<(string[] Devices, string Envelope)> KeyEnvelopes(Body body, GroupChange change, Member me, bool required)
    {
        var list = new List<(string[], string)>();
        if (body.OptionalElement("keys") is not { } raw)
            return required ? throw RequestException.BadRequest("'keys' is required: the new channel key for every member device.") : list;
        if (raw.ValueKind != JsonValueKind.Array || raw.GetArrayLength() is 0 || raw.GetArrayLength() > MaxKeysPerVersion)
            throw RequestException.BadRequest($"'keys' must have 1–{MaxKeysPerVersion} envelopes.");
        foreach (var env in raw.EnumerateArray())
        {
            if (env.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("Each key envelope must be an object.");
            var text = env.GetRawText();
            if (text.Length > MaxKeyEnvelopeBytes) throw RequestException.BadRequest("A key envelope is too large.");
            var header = env.TryGetProperty("header", out var h) && h.ValueKind == JsonValueKind.Object ? new Body(h) : throw RequestException.BadRequest("Key envelope without a header.");
            if (!env.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.String || kind.GetString() != "channel-key"
                || header.OptionalString("chain", GroupChain.IdLength) != change.Group || header.OptionalLong("version") != change.Version
                || header.OptionalString("from", 64) != me.AccountKey)
                throw RequestException.BadRequest("A key envelope doesn't match the change.");
            if (!env.TryGetProperty("keys", out var slots) || slots.ValueKind != JsonValueKind.Array || slots.GetArrayLength() == 0)
                throw RequestException.BadRequest("A key envelope has no key slots.");
            var devices = slots.EnumerateArray()
                .Select(slot => slot.ValueKind == JsonValueKind.Object && slot.TryGetProperty("device", out var d) && d.ValueKind == JsonValueKind.String
                    && d.GetString() is { Length: 43 } key && key.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')
                        ? key : throw RequestException.BadRequest("A key slot names no device."))
                .Distinct(StringComparer.Ordinal).ToArray();
            list.Add((devices, text));
        }
        return list;
    }

    /// <summary>Who can fetch an encrypted upload for this channel: the chain's members now (you must be one).</summary>
    public static string[] UploadReaders(Session s, Member me, long channelId)
    {
        var channel = ChatFeature.ReadableChannel(s, me, channelId);
        var e = s.World.Store.GetE2ee(channel.Id) ?? throw RequestException.BadRequest("That channel isn't end-to-end encrypted.");
        if (!e.Members.Contains(me.AccountKey)) throw RequestException.Forbidden("You don't have this channel's key yet.");
        return e.Members;
    }

    // ── Messages (chat.send / chat.edit in an encrypted channel) ──────────────

    /// <summary>
    /// The ciphertext a chat.send or chat.edit carries in an encrypted channel (threads: their parent's), or null for
    /// other channels. Plain text, server-side attachments, stickers, GIFs and voice notes are refused there.
    /// </summary>
    public static (E2eeChannel E2ee, long Version, string Envelope)? Sealed(Session s, Member me, Channel channel, Body body)
    {
        var e = s.World.Store.GetE2ee(channel.Id);
        if (e is null)
        {
            if (body.Has("envelope")) throw RequestException.BadRequest("That channel isn't end-to-end encrypted.");
            return null;
        }
        NotABot(s, me);
        if (body.OptionalElement("envelope") is not { ValueKind: JsonValueKind.Object } envelope)
            throw RequestException.BadRequest("This channel is end-to-end encrypted: messages must be encrypted by the app (update Iskra).", "e2ee_update_app");
        if ((body.OptionalString("text", 16) ?? "") != "" || body.OptionalStringArray("attachments", ChatFeature.MaxAttachments, 64).Length > 0
            || body.Has("sticker") || body.Has("gif") || body.Has("voice"))
            throw RequestException.BadRequest("Encrypted channels carry everything inside the envelope.");
        var version = body.OptionalLong("version", 1) ?? throw RequestException.BadRequest("'version' is required.");
        // Only the current epoch: nobody keeps writing with a key people who lost access still hold.
        if (version != e.Version) throw new RequestException("conflict", "Who's in this channel changed in the meantime. Refresh and try again.", "e2ee_members_changed");
        if (!e.Members.Contains(me.AccountKey)) throw RequestException.Forbidden("You don't have this channel's key yet.");
        var raw = envelope.GetRawText();
        if (raw.Length > MaxMessageEnvelopeBytes) throw RequestException.BadRequest("Message is too large.", "message_too_large");
        var header = envelope.TryGetProperty("header", out var h) && h.ValueKind == JsonValueKind.Object ? new Body(h) : throw RequestException.BadRequest("Envelope without a header.");
        if (header.OptionalString("from", 64) != me.AccountKey || header.OptionalLong("version") != version || header.OptionalString("chain", 32) != e.ChainId)
            throw RequestException.BadRequest("The envelope doesn't match this send.");
        // From v2 an envelope names its channel and thread (signed; members' apps refuse it anywhere else). Older ones don't.
        if (envelope.TryGetProperty("v", out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var format) && format >= 2)
        {
            long? thread = channel.Id == e.ChannelId ? null : channel.Id;
            if (header.OptionalLong("channel") != e.ChannelId || header.OptionalLong("thread") != thread)
                throw RequestException.BadRequest("The envelope doesn't match this send.");
        }
        return (e, version, raw);
    }

    /// <summary>Encrypted files the send carries: your own encrypted uploads for this channel, readable by every member, sent once.</summary>
    private static string[] Files(Session s, Member me, E2eeChannel e, Body body) =>
        DmFileFeature.CheckGroupAttachments(s, me, e.Members, body);

    internal static object Send(Session s, Member me, Channel channel, Body body, (E2eeChannel E2ee, long Version, string Envelope) sealedMsg)
    {
        var store = s.World.Store;
        var files = Files(s, me, sealedMsg.E2ee, body);
        long? replyTo = body.OptionalLong("replyTo", min: 1);
        if (replyTo is { } replyId && store.GetMessage(replyId)?.ChannelId != channel.Id)
            throw RequestException.BadRequest("You can only reply to messages in the same channel.");
        var nonce = ChatFeature.Nonce(body);
        if (nonce is not null && store.NonceUsed(me.AccountKey, nonce)) return ChatFeature.Repeat(s, me, nonce);
        // No AutoMod: the server can't read the message. Slowmode still applies.
        ModerationFeature.CheckSlowmode(s, me, channel);

        Message message;
        if (nonce is null) message = store.AddMessage(channel.Id, me.AccountKey, "", s.Now, null, replyTo);
        else
        {
            var (stored, created) = store.AddMessageOnce(nonce, channel.Id, me.AccountKey, "", s.Now, null, replyTo);
            if (!created) return ChatFeature.Repeat(s, me, nonce);
            message = stored!;
        }
        store.SaveE2eeMessage(message.Id, sealedMsg.Version, sealedMsg.Envelope);
        if (files.Length > 0) store.LinkDmFiles(message.Id, files);
        var view = MessageViews.Public(store, message);
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = view, nonce }));
        ThreadFeature.Touched(s, channel);
        s.Push.ChatMessage(channel, message);
        InboxFeature.Record(s, channel, message);
        return new { message = view, nonce };
    }

    internal static object Edit(Session s, Channel channel, Message message, (E2eeChannel E2ee, long Version, string Envelope) sealedMsg)
    {
        var store = s.World.Store;
        if (store.GetE2eeMessage(message.Id) is null) throw RequestException.BadRequest("That message can't be edited.", "message_no_edit");
        store.SaveE2eeMessage(message.Id, sealedMsg.Version, sealedMsg.Envelope);
        store.EditMessage(message.Id, "", s.Now);
        var edited = MessageViews.Public(store, message with { Text = "", EditedAt = s.Now });
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.edited", new { message = edited }));
        return new { message = edited };
    }
}

/// <summary>
/// The rules of an encrypted channel's membership chain (client: core/channelChain.ts). Same payload as a group DM's change,
/// signed under <see cref="E2eeChannelFeature.Context"/>. Any member adds, removes or rekeys; the server additionally checks
/// that adds and removes follow the channel's read permission.
/// </summary>
public static class ChannelChain
{
    public static string[] Apply(E2eeChannel? current, GroupChange c)
    {
        static bool Distinct(string[] keys) => keys.Distinct(StringComparer.Ordinal).Count() == keys.Length;
        string[] expected;
        if (c.Action == "create")
        {
            if (current is not null) throw RequestException.BadRequest("That chain already exists.");
            if (c.Version != 1 || c.Prev != "") throw RequestException.BadRequest("A new chain starts at version 1.");
            if (!Distinct([c.By, .. c.Targets])) throw RequestException.BadRequest("Everyone in the list must be different.");
            expected = [c.By, .. c.Targets];
        }
        else
        {
            if (current is null) throw RequestException.NotFound("Channel");
            if (c.Version != current.Version + 1 || c.Prev != current.Head)
                throw new RequestException("conflict", "Who's in this channel changed in the meantime. Refresh and try again.", "e2ee_members_changed");
            if (!current.Members.Contains(c.By)) throw RequestException.Forbidden("You aren't in this channel's encryption.");
            switch (c.Action)
            {
                case "add":
                    if (c.Targets.Length == 0 || !Distinct(c.Targets) || c.Targets.Any(current.Members.Contains))
                        throw RequestException.BadRequest("Add people who aren't in the channel yet.");
                    expected = [.. current.Members, .. c.Targets];
                    break;
                case "remove":
                    if (c.Targets.Length == 0 || !Distinct(c.Targets) || c.Targets.Any(t => !current.Members.Contains(t)) || c.Targets.Contains(c.By))
                        throw RequestException.BadRequest("Remove people who are in the channel (not yourself).");
                    expected = current.Members.Where(m => !c.Targets.Contains(m)).ToArray();
                    break;
                case "rekey":
                    if (c.Targets.Length != 0) throw RequestException.BadRequest("A rekey names nobody.");
                    expected = current.Members;
                    break;
                default:
                    throw RequestException.BadRequest("Unknown channel change.");
            }
        }
        if (expected.Length > E2eeChannelFeature.MaxMembers)
            throw RequestException.BadRequest($"At most {E2eeChannelFeature.MaxMembers} people can be in an encrypted channel.", "e2ee_members_max", new { max = E2eeChannelFeature.MaxMembers });
        if (!expected.SequenceEqual(c.Members, StringComparer.Ordinal)) throw RequestException.BadRequest("The change's member list doesn't match.");
        return expected;
    }
}

using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Key transparency: an append-only log of which account keys this server has shown (joins, names, rotations,
/// disputes), hash-chained and signed with the server key. Clients check that each new head extends the one they
/// stored and compare heads with each other, so a server can't quietly show different people different keys.
/// The log is brought up to date from the members and rotations tables before it's read, so no other feature has to
/// write to it. See "Key transparency" in PROTOCOL.md.
/// </summary>
public static class KeyLogFeature
{
    public const string EntryContext = "iskra/keylog-entry/v1";
    public const string HeadContext = "iskra/keylog-head/v1";
    public const int MaxEntries = 100;

    public static void Register(Router router)
    {
        router.Add("keylog.head", (s, _, _) => new { head = Head(s.World, s.Now) });
        router.Add("keylog.entries", Entries);
    }

    // ── Hashing and signing ─────────────────────────────────────────────────

    public static byte[] EntryHash(byte[] prev, long seq, string data) =>
        SHA256.HashData(Ed25519.Payload(EntryContext, prev, Ed25519.U64BigEndian(seq), Encoding.UTF8.GetBytes(data)));

    public static byte[] HeadPayload(byte[] serverKey, long seq, byte[] hash, long at) =>
        Ed25519.Payload(HeadContext, serverKey, Ed25519.U64BigEndian(seq), hash, Ed25519.U64BigEndian(at));

    private static string SignHead(World world, long seq, byte[] hash, long at) =>
        Ed25519.ToB64u(Ed25519.Sign(world.ServerKey, HeadPayload(world.ServerPublicKey, seq, hash, at)));

    /// <summary>The newest signed head, after bringing the log up to date.</summary>
    public static object Head(World world, long now)
    {
        Sync(world, now);
        return world.Store.KeyLogLast() is { } last
            ? new { seq = last.Seq, hash = Ed25519.ToB64u(last.Hash), at = last.At, sig = last.Sig }
            : new { seq = 0L, hash = Ed25519.ToB64u(new byte[32]), at = 0L, sig = SignHead(world, 0, new byte[32], 0) };
    }

    private static object Entries(Session s, Member me, Body body)
    {
        var after = body.OptionalLong("after", 0) ?? 0;
        var limit = (int)(body.OptionalLong("limit", 1, MaxEntries) ?? MaxEntries);
        var head = Head(s.World, s.Now);
        var entries = s.World.Store.KeyLogEntries(after, limit).Select(e => new { seq = e.Seq, data = e.Data });
        return new { entries, head };
    }

    // ── Keeping the log up to date ──────────────────────────────────────────

    private sealed class LoggedRotation
    {
        public required string NewKey;
        public string? Contest;
        public bool Resolved;
    }

    /// <summary>What the log says so far, replayed from its entries (cached per store).</summary>
    private sealed class State
    {
        public long Seq;
        public byte[] Hash = new byte[32];
        public readonly Dictionary<string, string> Names = new(StringComparer.Ordinal);
        public readonly Dictionary<string, LoggedRotation> Rotations = new(StringComparer.Ordinal);
    }

    private static readonly ConditionalWeakTable<Store, State> States = new();

    /// <summary>Appends whatever changed in members and rotations since the last entry.</summary>
    public static void Sync(World world, long now)
    {
        var store = world.Store;
        var state = States.GetValue(store, _ => new State { Seq = -1 });
        lock (state)
        {
            // A restore can swap the database underneath: replay when our view doesn't match it.
            var last = store.KeyLogLast();
            if (state.Seq != (last?.Seq ?? 0) || (last is not null && !last.Hash.AsSpan().SequenceEqual(state.Hash))) Replay(store, state);

            foreach (var r in store.AllRotationsForLog())
            {
                var rot = r.Rotation;
                if (!state.Rotations.TryGetValue(rot.OldKey, out var logged))
                {
                    Append(world, state, now, new { kind = "rotate", at = now, rotation = KeyFeature.PublicRotation(rot) });
                    if (r.Disputed) Append(world, state, now, new { kind = "contest", at = now, rotation = KeyFeature.PublicRotation(r.Contest!) });
                }
                else if (logged.NewKey != rot.NewKey)
                    Append(world, state, now, new { kind = "resolve", at = now, rotation = KeyFeature.PublicRotation(rot), previousKey = logged.NewKey });
                else if (r.Contest is { } contest && logged.Contest != contest.NewKey && !logged.Resolved)
                    Append(world, state, now, new { kind = "contest", at = now, rotation = KeyFeature.PublicRotation(contest) });
                else if (r.ResolvedAt is not null && logged.Contest is not null && !logged.Resolved)
                    Append(world, state, now, new { kind = "resolve", at = now, rotation = KeyFeature.PublicRotation(rot), previousKey = rot.NewKey });
            }
            foreach (var m in store.AllMembers())
            {
                if (!state.Names.TryGetValue(m.AccountKey, out var name))
                    Append(world, state, now, new { kind = "join", at = now, key = m.AccountKey, name = m.Name });
                else if (name != m.Name)
                    Append(world, state, now, new { kind = "name", at = now, key = m.AccountKey, name = m.Name });
            }
        }
    }

    private static void Append(World world, State state, long now, object entry)
    {
        var data = JsonSerializer.Serialize(entry);
        var seq = state.Seq + 1;
        var hash = EntryHash(state.Hash, seq, data);
        world.Store.KeyLogAppend(new KeyLogEntry(seq, now, data, hash, SignHead(world, seq, hash, now)));
        Apply(state, data);
        state.Seq = seq;
        state.Hash = hash;
    }

    private static void Replay(Store store, State state)
    {
        state.Seq = 0;
        state.Hash = new byte[32];
        state.Names.Clear();
        state.Rotations.Clear();
        for (List<KeyLogEntry> page; (page = store.KeyLogEntries(state.Seq, 1000)).Count > 0;)
        {
            foreach (var e in page)
            {
                Apply(state, e.Data);
                state.Seq = e.Seq;
                state.Hash = e.Hash;
            }
        }
    }

    /// <summary>Folds one entry into the state (the same rules clients use to read the log).</summary>
    private static void Apply(State state, string data)
    {
        using var doc = JsonDocument.Parse(data);
        var e = doc.RootElement;
        string Str(JsonElement o, string name) => o.GetProperty(name).GetString()!;
        switch (Str(e, "kind"))
        {
            case "join":
            case "name":
                state.Names[Str(e, "key")] = Str(e, "name");
                break;
            case "rotate":
            {
                var r = e.GetProperty("rotation");
                var (oldKey, newKey) = (Str(r, "oldKey"), Str(r, "newKey"));
                state.Rotations[oldKey] = new LoggedRotation { NewKey = newKey };
                if (state.Names.Remove(oldKey, out var name)) state.Names[newKey] = name;
                break;
            }
            case "contest":
            {
                var r = e.GetProperty("rotation");
                if (state.Rotations.TryGetValue(Str(r, "oldKey"), out var logged)) logged.Contest = Str(r, "newKey");
                break;
            }
            case "resolve":
            {
                var r = e.GetProperty("rotation");
                var (oldKey, newKey, previous) = (Str(r, "oldKey"), Str(r, "newKey"), Str(e, "previousKey"));
                if (!state.Rotations.TryGetValue(oldKey, out var logged)) break;
                logged.Resolved = true;
                if (previous != newKey)
                {
                    logged.Contest = previous;
                    logged.NewKey = newKey;
                    if (state.Names.Remove(previous, out var name)) state.Names[newKey] = name;
                }
                break;
            }
        }
    }
}

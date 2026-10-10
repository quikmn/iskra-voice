using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Account key rotation: the old account key signs over to a new one, and the server moves the account.
/// The first valid rotation away from a key wins here. A different claim on the same old key within the contest
/// window doesn't win; it marks the account as disputed (role capped at member) until an admin picks the real one.
/// See "Account key rotation" in PROTOCOL.md.
/// </summary>
public static class KeyFeature
{
    public const string RotateContext = "iskra/account-rotate/v1";
    public const long ContestWindowMs = 30L * 24 * 60 * 60 * 1000;
    public const int MaxChain = 16;
    public const int MaxAuthRotations = 4;
    public const int MaxCerts = 20;
    public const int MaxHistory = 200;
    private const long ClockSkew = 10 * 60 * 1000;

    public static void Register(Router router)
    {
        router.Add("account.rotate", Rotate);
        router.Add("account.rotations", History);
        router.Add("account.dispute.resolve", Resolve);
    }

    public enum Outcome { Applied, Already, Contested, Refused }

    // ── Wire shapes ─────────────────────────────────────────────────────────

    public static object PublicRotation(Rotation r) =>
        new { oldKey = r.OldKey, newKey = r.NewKey, rotatedAt = r.RotatedAt, oldSig = r.OldSig, newSig = r.NewSig };

    public static object PublicApplied(AppliedRotation a) =>
        new
        {
            oldKey = a.Rotation.OldKey, newKey = a.Rotation.NewKey, rotatedAt = a.Rotation.RotatedAt, oldSig = a.Rotation.OldSig, newSig = a.Rotation.NewSig,
            appliedAt = a.AppliedAt, contest = a.Contest is null ? null : PublicRotation(a.Contest), disputed = a.Disputed,
        };

    /// <summary>For welcome: the most recent rotations on this server.</summary>
    public static IEnumerable<object> Recent(Store store) => store.RecentRotations(MaxHistory).Select(PublicApplied);

    public static Rotation ParseRotation(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'rotation' must be an object.");
        var b = new Body(e);
        return new Rotation(b.String("oldKey", 64), b.String("newKey", 64), b.OptionalLong("rotatedAt", 0) ?? throw RequestException.BadRequest("'rotatedAt' is required."),
            b.String("oldSig", 128), b.String("newSig", 128));
    }

    /// <summary>Both keys signed the same statement: the old one hands over, the new one proves it's held.</summary>
    public static bool VerifyRotation(Rotation r)
    {
        if (r.RotatedAt < 0 || r.OldKey == r.NewKey) return false;
        if (!Ed25519.TryFromB64u(r.OldKey, out var oldKey) || oldKey.Length != Ed25519.PublicKeySize) return false;
        if (!Ed25519.TryFromB64u(r.NewKey, out var newKey) || newKey.Length != Ed25519.PublicKeySize) return false;
        if (!Ed25519.TryFromB64u(r.OldSig, out var oldSig) || !Ed25519.TryFromB64u(r.NewSig, out var newSig)) return false;
        var payload = Ed25519.Payload(RotateContext, oldKey, newKey, Ed25519.U64BigEndian(r.RotatedAt));
        return Ed25519.Verify(oldKey, payload, oldSig) && Ed25519.Verify(newKey, payload, newSig);
    }

    /// <summary>The keys this account had before, oldest first (the rotations that led to <paramref name="accountKey"/>).</summary>
    public static List<AppliedRotation> ChainTo(Store store, string accountKey)
    {
        var chain = new List<AppliedRotation>();
        for (var key = accountKey; chain.Count < MaxChain && store.RotationTo(key) is { } r; key = r.Rotation.OldKey) chain.Insert(0, r);
        return chain;
    }

    /// <summary>Where a retired key went, step by step.</summary>
    public static List<AppliedRotation> ChainFrom(Store store, string oldKey)
    {
        var chain = new List<AppliedRotation>();
        for (var key = oldKey; chain.Count < MaxChain && store.RotationFrom(key) is { } r; key = r.Rotation.NewKey) chain.Add(r);
        return chain;
    }

    // ── Applying ────────────────────────────────────────────────────────────

    /// <summary>Checks a rotation against this server's rules and applies it (or records a contest). Thread-safe enough: the store serializes writes.</summary>
    public static (Outcome Outcome, string Reason) TryApply(World world, Hub hub, VoiceRegistry voice, Rotation r,
        IReadOnlyList<DeviceCert> certs, IReadOnlyList<(string DeviceKey, string Seal)> handovers, long now, bool allowContest, Session? requester = null)
    {
        var store = world.Store;
        if (r.RotatedAt > now + ClockSkew) return (Outcome.Refused, "The rotation is dated in the future.");
        if (!VerifyRotation(r)) return (Outcome.Refused, "Invalid rotation signatures.");
        certs = certs.Where(c => c.AccountKey == r.NewKey && Identity.VerifyDeviceCert(c) && !store.IsDeviceRevoked(r.OldKey, c.DeviceKey))
            .DistinctBy(c => c.DeviceKey).Take(MaxCerts).ToList();
        var certified = certs.Select(c => c.DeviceKey).ToHashSet(StringComparer.Ordinal);
        handovers = handovers.Where(h => certified.Contains(h.DeviceKey)).ToList();

        lock (Gate)
        {
            if (store.RotationFrom(r.OldKey) is { } existing)
            {
                if (existing.Rotation.NewKey == r.NewKey)
                {
                    store.AddHandovers(r.NewKey, handovers, certs, r.OldKey, now);
                    return (Outcome.Already, "");
                }
                if (!allowContest || existing.Contest is not null || now - existing.AppliedAt > ContestWindowMs || store.KeyKnown(r.NewKey))
                    return (Outcome.Refused, "This account key was already rotated to a different key.");
                var holder = store.GetMember(existing.Rotation.NewKey);
                if (holder is null) return (Outcome.Refused, "This account key was already rotated to a different key.");
                var capped = Roles.Rank(holder.Role) > Roles.Rank(Roles.Member) ? Roles.Member : holder.Role;
                store.RecordContest(r.OldKey, r, holder.AccountKey, holder.Role, capped, now);
                var disputed = store.RotationFrom(r.OldKey)!;
                var member = hub.PublicMember(holder with { Role = capped });
                hub.Broadcast(Frames.Event("account.disputed", new { rotation = PublicApplied(disputed), member }));
                hub.Broadcast(Frames.Event("member.updated", new { member }));
                hub.RefreshChannels(holder.AccountKey);
                voice.EnforceAccess();
                return (Outcome.Contested, "");
            }

            if (store.GetMember(r.OldKey) is null && !store.IsBanned(r.OldKey)) return (Outcome.Refused, "That account isn't on this server.");
            if (store.KeyKnown(r.NewKey)) return (Outcome.Refused, "The new key is already in use here.");
            if (ChainTo(store, r.OldKey).Count >= MaxChain - 1) return (Outcome.Refused, "This account has rotated its key too many times.");
            store.ApplyRotation(r, certs, handovers, now);
        }

        var applied = store.RotationFrom(r.OldKey)!;
        // The old key's live sessions learn where the account went (with this device's sealed hand-over, if any), then close.
        foreach (var session in hub.Sessions.Where(s => s.AccountKey == r.OldKey))
        {
            void Retire()
            {
                session.Send(Frames.Event("account.rotated", new
                {
                    rotations = new[] { PublicApplied(applied) },
                    handover = session.DeviceKey is null ? null : store.HandoverFor(r.NewKey, session.DeviceKey),
                }));
                session.End(CloseCodes.Rotated, "This account moved to a new key.");
            }
            // The device that asked gets its answer first.
            if (session == requester) session.AfterReply(Retire);
            else Retire();
        }
        if (store.GetMember(r.NewKey) is { } moved)
            hub.Broadcast(Frames.Event("member.rotated", new { rotation = PublicApplied(applied), member = hub.PublicMember(moved) }));
        voice.EnforceAccess();
        return (Outcome.Applied, "");
    }

    // Rotations for one key must be decided one at a time (first valid one wins).
    private static readonly Lock Gate = new();

    // ── Handshake ───────────────────────────────────────────────────────────

    /// <summary>
    /// Runs in the handshake once the device's identity is proven. Applies a rotation chain the client brought
    /// (`auth.rotations`, catching up a server it missed), and refuses keys that were rotated away.
    /// Returns the error to send, or null to carry on with normal auth.
    /// </summary>
    public static (string Code, string Message, object Extra)? OnAuth(World world, Hub hub, VoiceRegistry voice, DeviceCert cert, JsonElement body, long now)
    {
        var store = world.Store;
        if (store.GetMember(cert.AccountKey) is null && body.TryGetProperty("rotations", out var list) && list.ValueKind == JsonValueKind.Array
            && list.GetArrayLength() is > 0 and <= MaxAuthRotations)
        {
            List<Rotation>? chain;
            try { chain = list.EnumerateArray().Select(ParseRotation).ToList(); }
            catch (RequestException) { chain = null; }
            // Contiguous and ending at the key this device is certified by.
            if (chain is not null && chain[^1].NewKey == cert.AccountKey && chain.Zip(chain.Skip(1)).All(p => p.First.NewKey == p.Second.OldKey))
            {
                foreach (var link in chain)
                {
                    var (outcome, _) = TryApply(world, hub, voice, link, [cert], [], now, allowContest: link == chain[^1]);
                    if (outcome == Outcome.Contested)
                        return ("account_disputed", "Someone else already moved this account to a different key. The server's admins will decide.",
                            new { rotations = ChainFrom(store, link.OldKey).Select(PublicApplied) });
                    if (outcome == Outcome.Refused) break;
                }
            }
        }

        var away = ChainFrom(store, cert.AccountKey);
        if (away.Count == 0) return null;
        // The newest hand-over sealed to this device, if the account's other device made one.
        var handover = away.Select(a => store.HandoverFor(a.Rotation.NewKey, cert.DeviceKey)).LastOrDefault(h => h is not null);
        return ("account_rotated", "This account moved to a new key.", new { rotations = away.Select(PublicApplied), handover });
    }

    /// <summary>A device that signed in with the new key no longer needs its hand-over.</summary>
    public static void SignedIn(Store store, DeviceCert cert)
    {
        if (store.RotationTo(cert.AccountKey) is not null) store.DropHandover(cert.AccountKey, cert.DeviceKey);
    }

    // ── Requests ────────────────────────────────────────────────────────────

    private static object Rotate(Session s, Member me, Body body)
    {
        var rotation = ParseRotation(body.Element("rotation"));
        if (me.AccountKey != rotation.OldKey && me.AccountKey != rotation.NewKey) throw RequestException.Forbidden("You can only rotate your own account key.");
        var certs = ParseCerts(body);
        var handovers = ParseHandovers(body);
        var (outcome, reason) = TryApply(s.World, s.Hub, s.Voice, rotation, certs, handovers, s.Now, allowContest: false, requester: s);
        return outcome switch
        {
            Outcome.Applied => new { status = "applied" },
            Outcome.Already => new { status = "already" },
            _ when reason.StartsWith("This account key was already", StringComparison.Ordinal) => throw new RequestException("rotation_conflict", reason),
            _ => throw RequestException.BadRequest(reason),
        };
    }

    private static List<DeviceCert> ParseCerts(Body body)
    {
        if (!body.Has("certs")) return [];
        var list = body.Element("certs");
        if (list.ValueKind != JsonValueKind.Array || list.GetArrayLength() > MaxCerts) throw RequestException.BadRequest($"'certs' must be a list of at most {MaxCerts}.");
        return list.EnumerateArray().Select(e =>
        {
            if (e.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'certs' must be device certificates.");
            var c = new Body(e);
            return new DeviceCert(c.String("accountKey", 64), c.String("deviceKey", 64), c.OptionalLong("created", 0) ?? -1, c.String("sig", 128));
        }).ToList();
    }

    private static List<(string, string)> ParseHandovers(Body body)
    {
        if (!body.Has("handovers")) return [];
        var list = body.Element("handovers");
        if (list.ValueKind != JsonValueKind.Array || list.GetArrayLength() > MaxCerts) throw RequestException.BadRequest($"'handovers' must be a list of at most {MaxCerts}.");
        return list.EnumerateArray().Select(e =>
        {
            if (e.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'handovers' must be objects.");
            var h = new Body(e);
            var device = h.String("device", 64);
            var seal = h.String("seal", 160);
            if (!Ed25519.TryFromB64u(seal, out var bytes) || bytes.Length != 80) throw RequestException.BadRequest("'seal' must be a sealed 32-byte key.");
            return (device, seal);
        }).ToList();
    }

    private static object History(Session s, Member me, Body body)
    {
        var key = body.String("accountKey", 64);
        return new { rotations = ChainTo(s.World.Store, key).Select(PublicApplied) };
    }

    /// <summary>An admin decides which key keeps a disputed account.</summary>
    private static object? Resolve(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden();
        var oldKey = body.String("oldKey", 64);
        var keep = body.String("keep", 64);
        var store = s.World.Store;
        var applied = store.RotationFrom(oldKey);
        if (applied is not { Disputed: true } || store.GetMember(applied.Rotation.NewKey) is not { } holder) throw RequestException.NotFound("Dispute");
        if (holder.AccountKey == me.AccountKey) throw RequestException.BadRequest("You can't settle a dispute about your own account.");
        if (!Permissions.Outranks(me, holder)) throw RequestException.Forbidden("You can only manage members ranked below you.");
        var keepContest = keep == applied.Contest!.NewKey;
        if (!keepContest && keep != applied.Rotation.NewKey) throw RequestException.BadRequest("'keep' must be one of the two keys in the dispute.");
        if (keepContest && store.KeyKnown(keep)) throw RequestException.BadRequest("That key is already in use here.");

        lock (Gate) store.ResolveDispute(applied, keepContest, [], s.Now);
        var resolved = store.RotationFrom(oldKey)!;
        if (keepContest)
        {
            foreach (var session in s.Hub.Sessions.Where(x => x.AccountKey == holder.AccountKey))
            {
                session.Send(Frames.Event("account.rotated", new { rotations = new[] { PublicApplied(resolved) }, handover = (string?)null }));
                session.End(CloseCodes.Rotated, "An admin gave this account to its other key.");
            }
        }
        var member = store.GetMember(resolved.Rotation.NewKey)!;
        s.Hub.Broadcast(Frames.Event("account.resolved", new { rotation = PublicApplied(resolved), previousKey = holder.AccountKey, member = s.Hub.PublicMember(member) }));
        s.Hub.RefreshChannels(member.AccountKey);
        s.Voice.EnforceAccess();
        return null;
    }
}

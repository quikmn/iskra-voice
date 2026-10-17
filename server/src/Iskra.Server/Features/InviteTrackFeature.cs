using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Which invite someone joined with, for moderators: recorded at the join (never the invite's code, which is its secret:
/// a public id derived from it, its label, who made it), shown with <c>invite.joins</c> and in the join's audit entry.
/// Forgotten when the person stops being a member.
/// </summary>
public static class InviteTrackFeature
{
    public const int MaxLabelLength = 40;
    public const int MaxJoins = 1000;

    public static void Register(Router router) => router.Add("invite.joins", Joins);

    /// <summary>
    /// An invite's public id: the first 66 bits of SHA-256 over a context string and the code. It names the invite in
    /// lists and audit entries without being usable to join.
    /// </summary>
    public static string PublicId(string code) =>
        Ed25519.ToB64u(SHA256.HashData(Encoding.UTF8.GetBytes("iskra-invite-id-v1\n" + code)))[..11];

    /// <summary>An invite's optional label (≤ 40 characters, one line); "" means none.</summary>
    public static string? Label(Body body)
    {
        var raw = body.OptionalString("label", MaxLabelLength * 4);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return Text.Normalize(raw, MaxLabelLength, allowNewlines: false)
            ?? throw RequestException.BadRequest($"Invite labels are at most {MaxLabelLength} characters, on one line.", "invite_label", new { max = MaxLabelLength });
    }

    /// <summary>
    /// Records the invite a new member came through. Direct joins also get a <c>member.join</c> audit entry (approved
    /// ones are in <c>join.approve</c>, which carries the returned view).
    /// </summary>
    public static object Joined(Store store, Member member, string code, string? approvedBy, long now)
    {
        var invite = store.GetInvite(code);
        var via = new JoinedVia(member.AccountKey, PublicId(code), invite?.Label, invite?.CreatedBy, invite?.Role ?? member.Role, approvedBy, now);
        store.SaveJoinedVia(via);
        var view = AuditView(via);
        if (approvedBy is null)
            store.AddAudit(now, "member.join", member.AccountKey, member.Name, member.AccountKey, member.Name, null,
                JsonSerializer.Serialize(new { role = member.Role, invite = view }, Json.Options));
        return view;
    }

    /// <summary>What an audit entry keeps about the invite: its public id, label and maker (never the code).</summary>
    private static object AuditView(JoinedVia v) => new { id = v.InviteId, label = v.Label, createdBy = v.CreatedBy };

    private static object Joins(Session s, Member me, Body body)
    {
        if (!ReportFeature.IsModerator(me)) throw RequestException.Forbidden("Only moderators can do that.", "mods_only");
        var store = s.World.Store;
        var limit = (int)(body.OptionalLong("limit", min: 1, max: MaxJoins) ?? 500);
        var joins = store.JoinsVia(body.OptionalString("accountKey", 64), body.OptionalString("inviteId", 32), limit);
        var names = new Dictionary<string, string?>();
        string? NameOf(string? key) => key is null ? null : names.TryGetValue(key, out var n) ? n : names[key] = store.GetMember(key)?.Name;
        return new
        {
            joins = joins.Select(j => new
            {
                accountKey = j.AccountKey, joinedAt = j.JoinedAt,
                invite = new { id = j.InviteId, label = j.Label, createdBy = j.CreatedBy, createdByName = NameOf(j.CreatedBy), role = j.Role },
                approvedBy = j.ApprovedBy, approvedByName = NameOf(j.ApprovedBy),
            }),
        };
    }
}

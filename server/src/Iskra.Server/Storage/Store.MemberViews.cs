namespace Iskra.Server.Storage;

/// <summary>What the member list shows about everyone, loaded in one go (see <see cref="Store.MemberViews"/>).</summary>
public sealed record MemberViewData(
    Dictionary<string, PublicProfile> Profiles, Dictionary<string, string> Nicknames, Dictionary<string, PresenceRecord> Presence,
    Dictionary<string, long> Timeouts);

/// <summary>Batched reads for busy paths: a few queries for many members instead of a few per member.</summary>
public sealed partial class Store
{
    /// <summary>The given members (with their roles) by account key; unknown keys are left out.</summary>
    public Dictionary<string, Member> GetMembers(IReadOnlyCollection<string> accountKeys)
    {
        if (accountKeys.Count == 0) return [];
        var keys = System.Text.Json.JsonSerializer.Serialize(accountKeys);
        lock (_gate)
        {
            var members = Query($"SELECT {MemberColumns} FROM members WHERE account_key IN (SELECT value FROM json_each($keys));", ReadMember, ("$keys", keys));
            var roles = Query("""
                SELECT mr.account_key, r.id, r.position, r.perms FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                WHERE mr.account_key IN (SELECT value FROM json_each($keys));
                """, r => (Key: r.GetString(0), Role: (r.GetInt64(1), r.GetInt32(2), (Perm)r.GetInt64(3))), ("$keys", keys));
            var byKey = roles.GroupBy(x => x.Key).ToDictionary(g => g.Key, g => g.Select(x => x.Role).ToList());
            return members.ToDictionary(m => m.AccountKey, m => byKey.TryGetValue(m.AccountKey, out var r) ? WithRoles(m, r) : m);
        }
    }

    /// <summary>
    /// Every member's profile, nickname, presence and timeout end, as GetPublicProfile, GetNickname, GetPresence and
    /// GetTimeout give them one at a time.
    /// </summary>
    public MemberViewData MemberViews()
    {
        lock (_gate)
        {
            var profiles = Query($"""
                SELECT m.account_key, p.bio, p.pronouns, p.accent, pg.page_id, pg.sha256, {string.Join(", ", FileColumns.Split(", ").Select(c => "f." + c))}
                FROM members m
                LEFT JOIN profiles p ON p.account_key = m.account_key
                LEFT JOIN files f ON f.id = p.avatar_file
                LEFT JOIN profile_pages pg ON pg.account_key = m.account_key;
                """,
                r => (Key: r.GetString(0), Profile: new PublicProfile(
                    ProfileText(r, 1), ProfileText(r, 2), ProfileText(r, 3),
                    r.IsDBNull(6) ? null : new StoredFile(r.GetString(6), r.GetString(7), r.GetString(8), r.GetInt64(9), r.GetString(10),
                        NullableInt(r, 11), NullableInt(r, 12), r.GetString(13), r.GetInt64(14)),
                    ProfileText(r, 4), ProfileText(r, 5))));
            var nicknames = Query("SELECT account_key, nick FROM nicknames;", r => (Key: r.GetString(0), Nick: r.GetString(1)));
            var presence = Query("SELECT account_key, status, emoji, text, expires_at, updated_at FROM presence;",
                r => (Key: r.GetString(0), Record: new PresenceRecord(r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2),
                    r.IsDBNull(3) ? null : r.GetString(3), NullableLong(r, 4), r.GetInt64(5))));
            var timeouts = Query("SELECT account_key, until FROM timeouts;", r => (Key: r.GetString(0), Until: r.GetInt64(1)));
            return new(
                profiles.GroupBy(x => x.Key).ToDictionary(g => g.Key, g => g.First().Profile),
                nicknames.ToDictionary(x => x.Key, x => x.Nick),
                presence.ToDictionary(x => x.Key, x => x.Record),
                timeouts.ToDictionary(x => x.Key, x => x.Until));
        }
    }
}

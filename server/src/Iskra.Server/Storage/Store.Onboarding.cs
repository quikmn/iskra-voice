namespace Iskra.Server.Storage;

/// <summary>
/// Join questions (the pick groups of RoleFeature.SelfAssign, grown up): each question has answers that give
/// self-assignable roles and suggest channels. Also each member's answers, the roles those answers gave them (so changing
/// an answer takes back only what an answer gave), and the roles every new member gets.
/// </summary>
public sealed partial class Store
{
    // Existing pick groups become questions whose answers are their roles, one each (label "" = the role's name).
    private const string OnboardingMigration = """
        ALTER TABLE role_groups ADD COLUMN required INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE role_group_answers (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id    INTEGER NOT NULL REFERENCES role_groups(id) ON DELETE CASCADE,
            label       TEXT NOT NULL,
            emoji       TEXT,
            position    INTEGER NOT NULL
        );
        CREATE INDEX role_group_answers_group ON role_group_answers (group_id, position);
        CREATE TABLE role_group_answer_roles (
            answer_id   INTEGER NOT NULL REFERENCES role_group_answers(id) ON DELETE CASCADE,
            role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
            position    INTEGER NOT NULL,
            PRIMARY KEY (answer_id, role_id)
        );
        CREATE TABLE role_group_answer_channels (
            answer_id   INTEGER NOT NULL REFERENCES role_group_answers(id) ON DELETE CASCADE,
            channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            position    INTEGER NOT NULL,
            PRIMARY KEY (answer_id, channel_id)
        );
        CREATE TABLE onboarding_answers (
            account_key TEXT NOT NULL,
            answer_id   INTEGER NOT NULL REFERENCES role_group_answers(id) ON DELETE CASCADE,
            PRIMARY KEY (account_key, answer_id)
        );
        CREATE TABLE onboarding_grants (
            account_key TEXT NOT NULL,
            role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
            PRIMARY KEY (account_key, role_id)
        );
        CREATE TABLE onboarding_auto_roles (
            role_id     INTEGER PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
            position    INTEGER NOT NULL
        );
        CREATE TRIGGER onboarding_member_gone AFTER DELETE ON members BEGIN
            DELETE FROM onboarding_answers WHERE account_key = OLD.account_key;
            DELETE FROM onboarding_grants WHERE account_key = OLD.account_key;
        END;
        INSERT INTO role_group_answers (group_id, label, emoji, position)
            SELECT group_id, '', NULL, position FROM role_group_roles ORDER BY group_id, position;
        INSERT INTO role_group_answer_roles (answer_id, role_id, position)
            SELECT a.id, g.role_id, 0 FROM role_group_answers a JOIN role_group_roles g ON g.group_id = a.group_id AND g.position = a.position;
        DROP TABLE role_group_roles;
        """;

    // ── Questions ────────────────────────────────────────────────────────────

    /// <summary>In the order shown, each with its answers in order.</summary>
    public List<RoleGroup> AllRoleGroups()
    {
        lock (_gate)
        {
            var roles = Query("SELECT answer_id, role_id FROM role_group_answer_roles ORDER BY position;", r => (Answer: r.GetInt64(0), Id: r.GetInt64(1)))
                .GroupBy(x => x.Answer).ToDictionary(g => g.Key, g => g.Select(x => x.Id).ToArray());
            var channels = Query("SELECT answer_id, channel_id FROM role_group_answer_channels ORDER BY position;", r => (Answer: r.GetInt64(0), Id: r.GetInt64(1)))
                .GroupBy(x => x.Answer).ToDictionary(g => g.Key, g => g.Select(x => x.Id).ToArray());
            var answers = Query("SELECT id, group_id, label, emoji FROM role_group_answers ORDER BY position, id;",
                    r => (Group: r.GetInt64(1), Answer: new JoinAnswer(r.GetInt64(0), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3),
                        roles.GetValueOrDefault(r.GetInt64(0)) ?? [], channels.GetValueOrDefault(r.GetInt64(0)) ?? [])))
                .Where(x => x.Answer.Label != "" || x.Answer.RoleIds.Length > 0) // an answer that was just a role that's gone
                .GroupBy(x => x.Group).ToDictionary(g => g.Key, g => g.Select(x => x.Answer).ToArray());
            return Query("SELECT id, title, question, multi, position, required FROM role_groups ORDER BY position, id;", r =>
            {
                var mine = answers.GetValueOrDefault(r.GetInt64(0)) ?? [];
                return new RoleGroup(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetInt64(3) != 0, r.GetInt32(4),
                    mine.SelectMany(a => a.RoleIds).Distinct().ToArray()) { Required = r.GetInt64(5) != 0, Answers = mine };
            });
        }
    }

    public RoleGroup? GetRoleGroup(long id) => AllRoleGroups().FirstOrDefault(g => g.Id == id);

    public int RoleGroupCount() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM role_groups;"));

    /// <summary>A question whose answers are these roles, one each (templates and the older `roles` form).</summary>
    public RoleGroup CreateRoleGroup(string title, string question, bool multi, IReadOnlyList<long> roleIds, long now) =>
        CreateRoleGroup(title, question, multi, false, AnswersFromRoles(roleIds), now);

    public static JoinAnswer[] AnswersFromRoles(IEnumerable<long> roleIds) => roleIds.Select(id => new JoinAnswer(0, "", null, [id], [])).ToArray();

    /// <summary>New questions go last.</summary>
    public RoleGroup CreateRoleGroup(string title, string question, bool multi, bool required, IReadOnlyList<JoinAnswer> answers, long now)
    {
        lock (_gate)
        {
            var position = Convert.ToInt32(Scalar("SELECT COALESCE(MAX(position), 0) + 1 FROM role_groups;"));
            var id = Convert.ToInt64(Scalar("""
                INSERT INTO role_groups (title, question, multi, position, created_at, required) VALUES ($t, $q, $m, $p, $now, $r) RETURNING id;
                """, ("$t", title), ("$q", question), ("$m", multi ? 1 : 0), ("$p", position), ("$now", now), ("$r", required ? 1 : 0)));
            SaveAnswers(id, answers);
            return GetRoleGroup(id)!;
        }
    }

    /// <summary>Answers keep their id (and who picked them) when listed with it; ones left out go, with everyone's picks of them.</summary>
    public void UpdateRoleGroup(RoleGroup group)
    {
        lock (_gate)
        {
            Exec("UPDATE role_groups SET title = $t, question = $q, multi = $m, required = $r WHERE id = $id;",
                ("$id", group.Id), ("$t", group.Title), ("$q", group.Question), ("$m", group.Multi ? 1 : 0), ("$r", group.Required ? 1 : 0));
            SaveAnswers(group.Id, group.Answers);
        }
    }

    private void SaveAnswers(long groupId, IReadOnlyList<JoinAnswer> answers)
    {
        var existing = Query("SELECT id FROM role_group_answers WHERE group_id = $g;", r => r.GetInt64(0), ("$g", groupId)).ToHashSet();
        var kept = answers.Where(a => existing.Contains(a.Id)).Select(a => a.Id).ToHashSet();
        foreach (var gone in existing.Except(kept)) Exec("DELETE FROM role_group_answers WHERE id = $id;", ("$id", gone));
        for (var i = 0; i < answers.Count; i++)
        {
            var a = answers[i];
            long id;
            if (kept.Contains(a.Id))
            {
                id = a.Id;
                Exec("UPDATE role_group_answers SET label = $l, emoji = $e, position = $p WHERE id = $id;", ("$id", id), ("$l", a.Label), ("$e", a.Emoji), ("$p", i));
                Exec("DELETE FROM role_group_answer_roles WHERE answer_id = $id;", ("$id", id));
                Exec("DELETE FROM role_group_answer_channels WHERE answer_id = $id;", ("$id", id));
            }
            else
            {
                id = Convert.ToInt64(Scalar("INSERT INTO role_group_answers (group_id, label, emoji, position) VALUES ($g, $l, $e, $p) RETURNING id;",
                    ("$g", groupId), ("$l", a.Label), ("$e", a.Emoji), ("$p", i)));
            }
            for (var j = 0; j < a.RoleIds.Length; j++)
                Exec("INSERT OR IGNORE INTO role_group_answer_roles (answer_id, role_id, position) VALUES ($a, $r, $p);", ("$a", id), ("$r", a.RoleIds[j]), ("$p", j));
            for (var j = 0; j < a.ChannelIds.Length; j++)
                Exec("INSERT OR IGNORE INTO role_group_answer_channels (answer_id, channel_id, position) VALUES ($a, $c, $p);", ("$a", id), ("$c", a.ChannelIds[j]), ("$p", j));
        }
    }

    public void DeleteRoleGroup(long id) => Exec("DELETE FROM role_groups WHERE id = $id;", ("$id", id));

    /// <summary>
    /// When a role stops being self-assignable: no answer gives it, it's no longer given on join, and whoever holds it now
    /// keeps it as if given by hand. Answers that were just that role go.
    /// </summary>
    public void RemoveRoleFromGroups(long roleId)
    {
        lock (_gate)
        {
            Exec("DELETE FROM role_group_answer_roles WHERE role_id = $r;", ("$r", roleId));
            Exec("""
                DELETE FROM role_group_answers WHERE label = ''
                    AND id NOT IN (SELECT answer_id FROM role_group_answer_roles) AND id NOT IN (SELECT answer_id FROM role_group_answer_channels);
                """);
            Exec("DELETE FROM onboarding_auto_roles WHERE role_id = $r;", ("$r", roleId));
            Exec("DELETE FROM onboarding_grants WHERE role_id = $r;", ("$r", roleId));
        }
    }

    // ── A member's answers ───────────────────────────────────────────────────

    /// <summary>The answer ids this member picked, across every question.</summary>
    public long[] OnboardingAnswers(string accountKey) =>
        [.. Query("SELECT answer_id FROM onboarding_answers WHERE account_key = $a ORDER BY answer_id;", r => r.GetInt64(0), ("$a", accountKey))];

    /// <summary>Replaces the member's answers to one question.</summary>
    public void SetOnboardingAnswers(string accountKey, long groupId, IEnumerable<long> answerIds)
    {
        lock (_gate)
        {
            Exec("""
                DELETE FROM onboarding_answers WHERE account_key = $a AND answer_id IN (SELECT id FROM role_group_answers WHERE group_id = $g);
                """, ("$a", accountKey), ("$g", groupId));
            foreach (var id in answerIds)
                Exec("INSERT OR IGNORE INTO onboarding_answers (account_key, answer_id) VALUES ($a, $id);", ("$a", accountKey), ("$id", id));
        }
    }

    /// <summary>Roles the member got from their answers (and still may lose by changing them).</summary>
    public HashSet<long> OnboardingGrants(string accountKey) =>
        [.. Query("SELECT role_id FROM onboarding_grants WHERE account_key = $a;", r => r.GetInt64(0), ("$a", accountKey))];

    public void SetOnboardingGrants(string accountKey, IEnumerable<long> roleIds)
    {
        lock (_gate)
        {
            Exec("DELETE FROM onboarding_grants WHERE account_key = $a;", ("$a", accountKey));
            foreach (var id in roleIds.Distinct())
                Exec("INSERT OR IGNORE INTO onboarding_grants (account_key, role_id) VALUES ($a, $r);", ("$a", accountKey), ("$r", id));
        }
    }

    /// <summary>Someone gave or took these roles by hand: from now on they aren't the answers' to take back.</summary>
    public void ForgetOnboardingGrants(string accountKey, IEnumerable<long> roleIds)
    {
        lock (_gate)
            foreach (var id in roleIds.Distinct())
                Exec("DELETE FROM onboarding_grants WHERE account_key = $a AND role_id = $r;", ("$a", accountKey), ("$r", id));
    }

    // ── Roles on join ────────────────────────────────────────────────────────

    public long[] AutoRoles() => [.. Query("SELECT role_id FROM onboarding_auto_roles ORDER BY position;", r => r.GetInt64(0))];

    public void SetAutoRoles(IReadOnlyList<long> roleIds)
    {
        lock (_gate)
        {
            Exec("DELETE FROM onboarding_auto_roles;");
            for (var i = 0; i < roleIds.Count; i++)
                Exec("INSERT OR IGNORE INTO onboarding_auto_roles (role_id, position) VALUES ($r, $p);", ("$r", roleIds[i]), ("$p", i));
        }
    }
}

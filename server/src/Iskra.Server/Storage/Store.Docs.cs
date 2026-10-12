using System.Text;
using Microsoft.Data.Sqlite;

namespace Iskra.Server.Storage;

/// <summary>A page in a docs channel. <see cref="Text"/> is only loaded when asked for.</summary>
public sealed record DocPage(long Id, long ChannelId, long? ParentId, string Title, int Position, long Version,
    string CreatedBy, long CreatedAt, string UpdatedBy, long UpdatedAt, int Size)
{
    public string? Text { get; init; }
}

/// <summary>One saved version of a page. <see cref="RestoredFrom"/>: the version it brought back, if it was a restore.</summary>
public sealed record DocRevision(long PageId, long Version, string Title, string Author, long CreatedAt, long? RestoredFrom, int Size)
{
    public string? Text { get; init; }
}

public sealed record DocHit(DocPage Page, string Snippet, List<(int Start, int Length)> Matches);

/// <summary>Why a save didn't happen.</summary>
public enum DocSaveResult { Saved, Conflict, Missing }

/// <summary>
/// Docs channels: pages (one level of sub-pages) with a version that goes up on every save, and their revisions.
/// Every save runs in one transaction that checks the version first, so two people saving at once can't both win.
/// </summary>
public sealed partial class Store
{
    /// <summary>Revisions kept per page (oldest go first).</summary>
    public const int MaxDocRevisions = 50;
    /// <summary>A save by the same person this soon after their last one replaces that revision instead of adding one.</summary>
    public const long DocCoalesceMs = 10 * 60 * 1000;

    private const string DocsMigration = """
        CREATE TABLE doc_pages (
            id          INTEGER PRIMARY KEY,
            channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            parent_id   INTEGER REFERENCES doc_pages(id) ON DELETE CASCADE,
            title       TEXT NOT NULL,
            text        TEXT NOT NULL,
            position    INTEGER NOT NULL,
            version     INTEGER NOT NULL,
            created_by  TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_by  TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE INDEX doc_pages_by_channel ON doc_pages(channel_id, parent_id, position);
        CREATE INDEX doc_pages_by_parent ON doc_pages(parent_id);
        CREATE TABLE doc_revisions (
            page_id       INTEGER NOT NULL REFERENCES doc_pages(id) ON DELETE CASCADE,
            version       INTEGER NOT NULL,
            title         TEXT NOT NULL,
            text          TEXT NOT NULL,
            author        TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            restored_from INTEGER,
            PRIMARY KEY (page_id, version)
        );
        CREATE TABLE doc_files (
            page_id     INTEGER NOT NULL REFERENCES doc_pages(id) ON DELETE CASCADE,
            file_id     TEXT NOT NULL,
            PRIMARY KEY (page_id, file_id)
        );
        CREATE TABLE doc_home (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            page_id     INTEGER REFERENCES doc_pages(id) ON DELETE SET NULL
        );
        CREATE VIRTUAL TABLE doc_pages_fts USING fts5(title, text, content='doc_pages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER doc_pages_fts_insert AFTER INSERT ON doc_pages BEGIN
            INSERT INTO doc_pages_fts (rowid, title, text) VALUES (new.id, new.title, new.text);
        END;
        CREATE TRIGGER doc_pages_fts_delete AFTER DELETE ON doc_pages BEGIN
            INSERT INTO doc_pages_fts (doc_pages_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
        END;
        CREATE TRIGGER doc_pages_fts_update AFTER UPDATE OF title, text ON doc_pages BEGIN
            INSERT INTO doc_pages_fts (doc_pages_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
            INSERT INTO doc_pages_fts (rowid, title, text) VALUES (new.id, new.title, new.text);
        END;
        """;

    private const string DocColumns =
        "id, channel_id, parent_id, title, position, version, created_by, created_at, updated_by, updated_at, length(CAST(text AS BLOB))";

    private static DocPage ReadDocPage(SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), NullableLong(r, 2), r.GetString(3), r.GetInt32(4), r.GetInt64(5),
            r.GetString(6), r.GetInt64(7), r.GetString(8), r.GetInt64(9), r.GetInt32(10));

    private static DocPage ReadDocPageWithText(SqliteDataReader r) => ReadDocPage(r) with { Text = r.GetString(11) };

    /// <summary>A channel's pages without their text: top-level pages and sub-pages, each in their order.</summary>
    public List<DocPage> DocPages(long channelId) =>
        Query($"SELECT {DocColumns} FROM doc_pages WHERE channel_id = $ch ORDER BY parent_id IS NOT NULL, parent_id, position, id;",
            ReadDocPage, ("$ch", channelId));

    public DocPage? GetDocPage(long id, bool withText = false) =>
        Query($"SELECT {DocColumns}{(withText ? ", text" : "")} FROM doc_pages WHERE id = $id;",
            withText ? ReadDocPageWithText : (Func<SqliteDataReader, DocPage>)ReadDocPage, ("$id", id)).FirstOrDefault();

    public int DocPageCount(long channelId) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM doc_pages WHERE channel_id = $ch;", ("$ch", channelId)));

    public bool DocHasChildren(long id) => Scalar("SELECT 1 FROM doc_pages WHERE parent_id = $id LIMIT 1;", ("$id", id)) is not null;

    /// <summary>Runs <paramref name="work"/> in one transaction under the write lock.</summary>
    private T InDocTransaction<T>(Func<Func<string, (string, object?)[], object?>, T> work)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            object? Run(string sql, (string, object?)[] args)
            {
                using var cmd = Command(sql, args);
                cmd.Transaction = tx;
                return cmd.ExecuteScalar();
            }
            var result = work(Run);
            tx.Commit();
            return result;
        }
    }

    /// <summary>A new page at the end of its siblings, with its first revision.</summary>
    public DocPage CreateDocPage(long channelId, long? parentId, string title, string text, string[] fileIds, string author, long now)
    {
        var id = InDocTransaction(run =>
        {
            var position = Convert.ToInt32(run("SELECT COALESCE(MAX(position), -1) + 1 FROM doc_pages WHERE channel_id = $ch AND parent_id IS $parent;",
                [("$ch", channelId), ("$parent", parentId)]));
            var id = Convert.ToInt64(run("""
                INSERT INTO doc_pages (channel_id, parent_id, title, text, position, version, created_by, created_at, updated_by, updated_at)
                VALUES ($ch, $parent, $title, $text, $pos, 1, $by, $now, $by, $now) RETURNING id;
                """, [("$ch", channelId), ("$parent", parentId), ("$title", title), ("$text", text), ("$pos", position), ("$by", author), ("$now", now)]));
            run("INSERT INTO doc_revisions (page_id, version, title, text, author, created_at) VALUES ($id, 1, $title, $text, $by, $now);",
                [("$id", id), ("$title", title), ("$text", text), ("$by", author), ("$now", now)]);
            foreach (var file in fileIds) run("INSERT OR IGNORE INTO doc_files (page_id, file_id) VALUES ($id, $file);", [("$id", id), ("$file", file)]);
            return id;
        });
        return GetDocPage(id)!;
    }

    /// <summary>
    /// Saves a new version if the page is still at <paramref name="baseVersion"/>. A save by the same person within
    /// <see cref="DocCoalesceMs"/> of their last one replaces that revision; beyond <see cref="MaxDocRevisions"/> the oldest go.
    /// </summary>
    public DocSaveResult SaveDocPage(long id, long baseVersion, string title, string text, string[] fileIds, string author, long now, long? restoredFrom = null)
    {
        return InDocTransaction(run =>
        {
            if (run("SELECT version FROM doc_pages WHERE id = $id;", [("$id", id)]) is not { } current) return DocSaveResult.Missing;
            if (Convert.ToInt64(current) != baseVersion) return DocSaveResult.Conflict;
            var version = baseVersion + 1;
            run("UPDATE doc_pages SET title = $title, text = $text, version = $v, updated_by = $by, updated_at = $now WHERE id = $id;",
                [("$id", id), ("$title", title), ("$text", text), ("$v", version), ("$by", author), ("$now", now)]);
            if (restoredFrom is null)
            {
                run("""
                    DELETE FROM doc_revisions WHERE page_id = $id AND version = $base AND author = $by AND created_at >= $since
                        AND restored_from IS NULL AND version > 1;
                    """, [("$id", id), ("$base", baseVersion), ("$by", author), ("$since", now - DocCoalesceMs)]);
            }
            run("INSERT INTO doc_revisions (page_id, version, title, text, author, created_at, restored_from) VALUES ($id, $v, $title, $text, $by, $now, $from);",
                [("$id", id), ("$v", version), ("$title", title), ("$text", text), ("$by", author), ("$now", now), ("$from", restoredFrom)]);
            run("""
                DELETE FROM doc_revisions WHERE page_id = $id AND version NOT IN
                    (SELECT version FROM doc_revisions WHERE page_id = $id ORDER BY version DESC LIMIT $max);
                """, [("$id", id), ("$max", MaxDocRevisions)]);
            foreach (var file in fileIds) run("INSERT OR IGNORE INTO doc_files (page_id, file_id) VALUES ($id, $file);", [("$id", id), ("$file", file)]);
            run(ForgetUnshownDocFiles + " AND page_id = $id;", [("$id", id)]);
            return DocSaveResult.Saved;
        });
    }

    /// <summary>Moves a page under <paramref name="parentId"/> (null: top level), before <paramref name="beforeId"/> (null: last).</summary>
    public void MoveDocPage(DocPage page, long? parentId, long? beforeId)
    {
        lock (_gate)
        {
            var siblings = Query("SELECT id FROM doc_pages WHERE channel_id = $ch AND parent_id IS $parent AND id != $id ORDER BY position, id;",
                r => r.GetInt64(0), ("$ch", page.ChannelId), ("$parent", parentId), ("$id", page.Id));
            var at = beforeId is { } before ? siblings.IndexOf(before) : -1;
            siblings.Insert(at < 0 ? siblings.Count : at, page.Id);
            InDocTransaction(run =>
            {
                run("UPDATE doc_pages SET parent_id = $parent WHERE id = $id;", [("$id", page.Id), ("$parent", parentId)]);
                for (var i = 0; i < siblings.Count; i++) run("UPDATE doc_pages SET position = $pos WHERE id = $id;", [("$id", siblings[i]), ("$pos", i)]);
                return 0;
            });
        }
    }

    /// <summary>Deletes a page and its sub-pages. Returns every id that went.</summary>
    public List<long> DeleteDocPage(long id)
    {
        lock (_gate)
        {
            var ids = Query("SELECT id FROM doc_pages WHERE id = $id OR parent_id = $id;", r => r.GetInt64(0), ("$id", id));
            Exec("DELETE FROM doc_pages WHERE id = $id;", ("$id", id));
            return ids;
        }
    }

    /// <summary>Newest first, without their text.</summary>
    public List<DocRevision> DocRevisions(long pageId) =>
        Query("""
            SELECT page_id, version, title, author, created_at, restored_from, length(CAST(text AS BLOB))
            FROM doc_revisions WHERE page_id = $id ORDER BY version DESC;
            """, r => new DocRevision(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetInt64(4), NullableLong(r, 5), r.GetInt32(6)),
            ("$id", pageId));

    public DocRevision? GetDocRevision(long pageId, long version) =>
        Query("""
            SELECT page_id, version, title, author, created_at, restored_from, length(CAST(text AS BLOB)), text
            FROM doc_revisions WHERE page_id = $id AND version = $v;
            """, r => new DocRevision(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetInt64(4), NullableLong(r, 5), r.GetInt32(6))
            { Text = r.GetString(7) }, ("$id", pageId), ("$v", version)).FirstOrDefault();

    /// <summary>The server's "Start here" page, if one is set (and still exists).</summary>
    public long? DocHome() => Scalar("SELECT page_id FROM doc_home WHERE id = 1;") is long id ? id : null;

    public void SetDocHome(long? pageId) =>
        Exec("INSERT INTO doc_home (id, page_id) VALUES (1, $p) ON CONFLICT(id) DO UPDATE SET page_id = excluded.page_id;", ("$p", pageId));

    /// <summary>
    /// A deleted account that asked for its messages to go: its old docs revisions go, and pages and the revisions others still
    /// read (a page's current version) keep their text but lose the author ("" = someone who left). Runs inside DeleteAccount.
    /// </summary>
    private const string DocsForgetAuthor = """
        DELETE FROM doc_revisions WHERE author = $k
            AND version < (SELECT p.version FROM doc_pages p WHERE p.id = doc_revisions.page_id);
        UPDATE doc_revisions SET author = '' WHERE author = $k;
        UPDATE doc_pages SET created_by = '' WHERE created_by = $k;
        UPDATE doc_pages SET updated_by = '' WHERE updated_by = $k;
        """ + ForgetUnshownDocFiles + ";";

    /// <summary>Forgets kept uploads that no kept revision of their page (the current text is one) links to any more.</summary>
    private const string ForgetUnshownDocFiles = """
        DELETE FROM doc_files WHERE NOT EXISTS (SELECT 1 FROM doc_revisions r
            WHERE r.page_id = doc_files.page_id AND instr(r.text, '/files/' || doc_files.file_id) > 0)
        """;

    /// <summary>
    /// Retention: revisions older than <paramref name="cutoff"/> go, except each page's current version (pages themselves stay:
    /// they're the server's documents, not messages). Returns how many went.
    /// </summary>
    public int PruneDocRevisions(long cutoff)
    {
        lock (_gate)
        {
            using var cmd = Command("""
                DELETE FROM doc_revisions WHERE created_at < $cutoff
                    AND version < (SELECT p.version FROM doc_pages p WHERE p.id = doc_revisions.page_id);
                """, [("$cutoff", cutoff)]);
            var pruned = cmd.ExecuteNonQuery();
            if (pruned > 0) Exec(ForgetUnshownDocFiles + ";");
            return pruned;
        }
    }

    /// <summary>Uploads that any page (or any of its kept revisions) shows, so the upload sweeper keeps them.</summary>
    public HashSet<string> DocFileIds() => Query("SELECT DISTINCT file_id FROM doc_files;", r => r.GetString(0)).ToHashSet();

    /// <summary>Pages whose title or text has every term (prefix match), best first, in the given channels only.</summary>
    public List<DocHit> SearchDocs(IReadOnlyList<string> terms, IReadOnlyCollection<long> channelIds, int limit)
    {
        if (terms.Count == 0 || channelIds.Count == 0) return [];
        var match = string.Join(' ', terms.Select(t => "\"" + t.Replace("\"", "\"\"") + "\"*"));
        lock (_readerGate)
        {
            return ReadQuery($"""
                SELECT p.id, p.channel_id, p.parent_id, p.title, p.position, p.version, p.created_by, p.created_at, p.updated_by, p.updated_at,
                    length(CAST(p.text AS BLOB)), snippet(doc_pages_fts, -1, char(1), char(2), '…', 24)
                FROM doc_pages_fts f JOIN doc_pages p ON p.id = f.rowid
                WHERE doc_pages_fts MATCH $match AND p.channel_id IN (SELECT value FROM json_each($channels))
                ORDER BY bm25(doc_pages_fts, 4.0, 1.0) LIMIT $limit;
                """, r =>
                {
                    var marked = r.GetString(11);
                    return new DocHit(ReadDocPage(r), Unmark(marked), MatchRanges(marked));
                },
                [("$match", match), ("$channels", System.Text.Json.JsonSerializer.Serialize(channelIds)), ("$limit", limit)]);
        }
    }

    private static string Unmark(string marked)
    {
        var text = new StringBuilder(marked.Length);
        foreach (var c in marked) if (c != MatchStart && c != MatchEnd) text.Append(c);
        return text.ToString();
    }
}
